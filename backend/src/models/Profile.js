const { Schema, model } = require('mongoose');

// GeoJSON point subdocument. No `default` on `type` and `default: undefined` on
// `coordinates` are deliberate: with setDefaultsOnInsert, a `default: 'Point'`
// here would materialize a hollow { type: 'Point' } (no coordinates) on every
// profile created without a location, which the 2dsphere index rejects ("Can't
// extract geo keys"). Kept fully absent until real coordinates are set — the
// controller always sets `type` explicitly when it writes coordinates, and a
// 2dsphere index (v2) simply skips documents missing the field.
const PointSchema = new Schema({
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined },
}, { _id: false });

// User-facing dating profile (spec §3). One per User. Sensitive attributes
// (tribe, religion) are always optional and never required. Photos are managed
// by the dedicated upload endpoint (Cloudinary) — not written through PUT
// /profile/me — so they are deferred here but the shape is defined.
const ProfileSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },
    name: { type: String },
    dob: { type: Date },
    // Opposite-sex matching by product decision: gender is a closed set and
    // discovery derives a user's match target directly from it (male ↔ female),
    // so there is deliberately no separate "interestedIn"/preference field.
    gender: { type: String, enum: ['male', 'female'] },
    lookingFor: {
        type: String,
        enum: ['casual', 'serious', 'marriage', 'friendship'],
    },
    bio: { type: String },
    interests: [{ type: String }],
    tribe: { type: String },      // optional, sensitive — never required
    religion: { type: String },   // optional, sensitive — never required
    state: { type: String },
    lga: { type: String },
    // GeoJSON point (2dsphere indexed below). coordinates are [longitude, latitude].
    location: {
        type: PointSchema,
        default: undefined,
    },
    // Managed by POST/DELETE /profile/photos (Cloudinary). Each subdoc gets an
    // auto _id which is the :photoId used by DELETE. publicId is stored in
    // addition to the spec's { url, isPrimary } so the delete endpoint can remove
    // the actual Cloudinary asset (not just the DB reference) and avoid orphans.
    photos: [{
        url: { type: String },
        publicId: { type: String },
        isPrimary: { type: Boolean },
    }],
    prompts: [{
        question: { type: String },
        answer: { type: String },
    }],
    discoverySettings: {
        // Reciprocity field (spec §4.5): can only be set to true via the
        // dedicated PUT /profile/discovery-settings endpoint, which checks the
        // requester's own ninVerifiedAt. It is intentionally NOT writable
        // through PUT /profile/me, so that endpoint can't bypass the rule.
        showOnlyNinVerified: { type: Boolean, default: false },
        maxDistanceKm: { type: Number, default: 25 },
        ageRange: {
            min: { type: Number },
            max: { type: Number },
        },
    },
}, {
    timestamps: true,
});

// Geo queries for discovery (spec §4.6) rely on this index.
ProfileSchema.index({ location: '2dsphere' });

module.exports = model('Profile', ProfileSchema);
