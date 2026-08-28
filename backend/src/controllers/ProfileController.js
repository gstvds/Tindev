const Profile = require('../models/Profile');
const { uploadImage, deleteImage } = require('../services/cloudinary');

// Max photos per profile. Dating apps cap this; keeps a single profile from
// filling the Cloudinary account. Not in the spec — a sensible default.
const MAX_PHOTOS = 6;

// Fields a user may set on their own profile via PUT /profile/me. Deliberately
// excludes: userId (identity), photos (managed by the photo-upload endpoint),
// and discoverySettings (managed by PUT /profile/discovery-settings, where the
// showOnlyNinVerified reciprocity rule is enforced — spec §4.5).
const EDITABLE_FIELDS = [
    'name', 'dob', 'gender', 'lookingFor', 'bio',
    'interests', 'tribe', 'religion', 'state', 'lga',
    'location', 'prompts',
];

// GET /profile/me
async function getMe(req, res) {
    const profile = await Profile.findOne({ userId: req.userId });
    if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
    }
    return res.json(profile);
}

// PUT /profile/me
// Upsert: creates the profile on first call, updates it thereafter. Only the
// allowlisted fields are applied; unknown/blocked fields are ignored.
async function updateMe(req, res) {
    const update = {};
    for (const field of EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            update[field] = req.body[field];
        }
    }

    // Validate/normalize the GeoJSON point before it reaches Mongo so a bad
    // shape returns a clear 400 rather than a cast error or a broken index entry.
    if (update.location !== undefined) {
        const coords = update.location && update.location.coordinates;
        const valid = Array.isArray(coords)
            && coords.length === 2
            && coords.every((n) => typeof n === 'number' && Number.isFinite(n));
        if (!valid) {
            return res.status(400).json({ error: 'location.coordinates must be [longitude, latitude]' });
        }
        const [lng, lat] = coords;
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
            return res.status(400).json({ error: 'location coordinates out of range' });
        }
        update.location = { type: 'Point', coordinates: [lng, lat] };
    }

    // Mongoose ValidationError / CastError (e.g. a bad enum) propagate to the
    // central error handler, which maps them to 400.
    const profile = await Profile.findOneAndUpdate(
        { userId: req.userId },
        { $set: update, $setOnInsert: { userId: req.userId } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    return res.json(profile);
}

// POST /profile/photos
// Multipart upload (field name "photo"). Streams the file to Cloudinary, then
// appends { url, publicId, isPrimary } to the profile's photos array. The first
// photo on a profile becomes primary automatically. Creates the profile if the
// user hasn't set one up yet, mirroring PUT /profile/me's upsert behaviour.
async function uploadPhoto(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: 'No photo uploaded (expected multipart field "photo")' });
    }

    let profile = await Profile.findOne({ userId: req.userId });
    if (!profile) {
        profile = new Profile({ userId: req.userId });
    }

    if (profile.photos.length >= MAX_PHOTOS) {
        return res.status(409).json({ error: `A profile can have at most ${MAX_PHOTOS} photos` });
    }

    // Upload before mutating the DB so a Cloudinary failure leaves no dangling
    // row. CloudinaryError propagates to the central handler (mapped to 502).
    const { url, publicId } = await uploadImage(req.file.buffer, `sabipesin/profiles/${req.userId}`);

    profile.photos.push({
        url,
        publicId,
        isPrimary: profile.photos.length === 0,
    });
    await profile.save();

    return res.status(201).json(profile);
}

// DELETE /profile/photos/:photoId
// Removes the photo subdocument (matched by its _id) and deletes the backing
// Cloudinary asset. If the removed photo was primary, the first remaining photo
// is promoted so a profile with photos always has exactly one primary.
async function deletePhoto(req, res) {
    const profile = await Profile.findOne({ userId: req.userId });
    if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
    }

    const photo = profile.photos.id(req.params.photoId);
    if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
    }

    const wasPrimary = photo.isPrimary;

    // Delete the asset first; a Cloudinary failure (502) aborts before we touch
    // the DB, so the row and asset never drift out of sync. A "not found" asset
    // is treated as success by the service, so re-deletes still clean up the row.
    if (photo.publicId) {
        await deleteImage(photo.publicId);
    }

    profile.photos.pull(photo._id);
    if (wasPrimary && profile.photos.length > 0) {
        profile.photos[0].isPrimary = true;
    }
    await profile.save();

    return res.json(profile);
}

// PUT /profile/discovery-settings
// Enforces the reciprocity rule (spec §4.5): a user may only enable
// showOnlyNinVerified if they are themselves NIN-verified. This is the endpoint
// PUT /profile/me is deliberately blocked from writing to, so the rule cannot be
// bypassed. Accepts showOnlyNinVerified, maxDistanceKm, ageRange and applies
// only the fields provided (dot-path $set preserves the others).
async function updateDiscoverySettings(req, res) {
    const { showOnlyNinVerified, maxDistanceKm, ageRange } = req.body;
    const set = {};

    if (showOnlyNinVerified !== undefined) {
        if (typeof showOnlyNinVerified !== 'boolean') {
            return res.status(400).json({ error: 'showOnlyNinVerified must be a boolean' });
        }
        // Reciprocity: enabling the NIN-only filter requires the requester to be
        // NIN-verified themselves. Reject with a specific code the client routes
        // straight into the NIN verification flow — and do NOT persist anything.
        if (showOnlyNinVerified === true && !req.user.ninVerifiedAt) {
            return res.status(403).json({
                error: 'You must complete NIN verification before filtering by NIN-verified users',
                code: 'NIN_REQUIRED',
            });
        }
        set['discoverySettings.showOnlyNinVerified'] = showOnlyNinVerified;
    }

    if (maxDistanceKm !== undefined) {
        if (typeof maxDistanceKm !== 'number' || !Number.isFinite(maxDistanceKm) || maxDistanceKm <= 0) {
            return res.status(400).json({ error: 'maxDistanceKm must be a positive number' });
        }
        set['discoverySettings.maxDistanceKm'] = maxDistanceKm;
    }

    if (ageRange !== undefined) {
        const validNum = (n) => typeof n === 'number' && Number.isFinite(n);
        const min = ageRange && ageRange.min;
        const max = ageRange && ageRange.max;
        if (!ageRange || !validNum(min) || !validNum(max)) {
            return res.status(400).json({ error: 'ageRange must be { min, max } numbers' });
        }
        // 18+ floor: this is a dating app; not in the spec but a safety baseline.
        if (min < 18) {
            return res.status(400).json({ error: 'ageRange.min must be at least 18' });
        }
        if (min > max) {
            return res.status(400).json({ error: 'ageRange.min cannot exceed ageRange.max' });
        }
        set['discoverySettings.ageRange'] = { min, max };
    }

    if (Object.keys(set).length === 0) {
        return res.status(400).json({ error: 'No valid discovery settings provided' });
    }

    // Upsert so the profile is created on first call, mirroring PUT /profile/me.
    const profile = await Profile.findOneAndUpdate(
        { userId: req.userId },
        { $set: set, $setOnInsert: { userId: req.userId } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    return res.json(profile);
}

module.exports = {
    getMe,
    updateMe,
    uploadPhoto,
    deletePhoto,
    updateDiscoverySettings,
};
