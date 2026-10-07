const mongoose = require('mongoose');

const Profile = require('../models/Profile');
const User = require('../models/User');
const Swipe = require('../models/Swipe');
const verificationTier = require('../utils/verificationTier');
const { blockedUserIds } = require('../utils/blocks');

// Pagination bounds. Not in the spec — sensible defaults so a client can't ask
// for an unbounded page.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Mean Earth radius in km, used to convert a distance to the radians that
// $centerSphere expects.
const EARTH_RADIUS_KM = 6378.1;

// Parse and clamp ?page / ?limit. page is 1-based; both fall back to defaults on
// anything non-numeric or out of range.
function parsePaging(query) {
    let page = parseInt(query.page, 10);
    let limit = parseInt(query.limit, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    return { page, limit };
}

// A candidate profile is returned with only a small verification summary of its
// owner — never the owner's phone, role, or (crucially) their own
// discoverySettings, which are private to them.
function shapeCandidate(doc) {
    const { user, discoverySettings, ...profile } = doc;
    return {
        ...profile,
        user: {
            id: user._id,
            verificationTier: verificationTier(user),
            phoneVerifiedAt: user.phoneVerifiedAt,
            ninVerifiedAt: user.ninVerifiedAt,
        },
    };
}

// GET /discovery
// Paginated candidate profiles for the authenticated user. Applies, in order:
//   - excludes the requester's own profile
//   - excludes every profile they've already swiped on (any Swipe row — like,
//     pass, or superlike)
//   - the reciprocity/verification filter (spec §4.6): if the requester's own
//     discoverySettings.showOnlyNinVerified is true, only NIN-verified users;
//     otherwise anyone with at least phoneVerifiedAt set (incomplete signups,
//     with neither timestamp, never appear)
//   - only active users
//   - geo-distance (spec §4.6): when BOTH the requester and a candidate have a
//     location set, the candidate must be within the requester's maxDistanceKm.
//     Candidates with no location are still shown; when the requester has no
//     location, no distance filter is applied at all.
async function getDiscovery(req, res) {
    const { page, limit } = parsePaging(req.query);
    const meId = new mongoose.Types.ObjectId(req.userId);

    // The requester's own profile drives the verification filter and the geo
    // origin. Its absence just means no location origin and default settings.
    const myProfile = await Profile.findOne({ userId: req.userId });
    const showOnlyNinVerified = Boolean(
        myProfile && myProfile.discoverySettings && myProfile.discoverySettings.showOnlyNinVerified,
    );

    // Every user this requester has already swiped on — excluded regardless of
    // whether it was a like, pass, or superlike.
    const swipedTargetIds = await Swipe.find({ actorId: req.userId }).distinct('targetId');

    // Users on either side of a block with the requester (they blocked them, or
    // were blocked by them) — never surface them (spec safety / App Store Guideline
    // 1.2). This runs raw through the aggregation below, which does NOT cast query
    // values, so the ids must be real ObjectIds — same as swipedTargetIds.
    const blockedIds = (await blockedUserIds(req.userId))
        .map((id) => new mongoose.Types.ObjectId(id));

    // Base match: not me, not already swiped, not blocked (either direction).
    const match = {
        userId: { $ne: meId, $nin: [...swipedTargetIds, ...blockedIds] },
    };

    // Opposite-sex matching (product decision): derive the target gender directly
    // from the requester's own gender — male sees only female profiles and vice
    // versa. Naturally also excludes candidates with no gender set (they can't be
    // confirmed as the opposite sex). If the requester hasn't set their own gender
    // yet, no gender filter is applied — we can't derive a target from nothing.
    const myGender = myProfile && myProfile.gender;
    if (myGender === 'male' || myGender === 'female') {
        match.gender = myGender === 'male' ? 'female' : 'male';
    }

    // Geo filter only when the requester has a usable location. Candidates within
    // maxDistanceKm OR with no location of their own are kept — the distance rule
    // only binds when both sides have a location (spec §4.6).
    const myCoords = myProfile && myProfile.location && myProfile.location.coordinates;
    if (Array.isArray(myCoords) && myCoords.length === 2) {
        const maxKm = (myProfile.discoverySettings && myProfile.discoverySettings.maxDistanceKm) || 25;
        const radians = maxKm / EARTH_RADIUS_KM;
        match.$or = [
            { location: { $geoWithin: { $centerSphere: [myCoords, radians] } } },
            { location: { $exists: false } },
        ];
    }

    // Fetch one extra row to compute hasMore without a second count query.
    const skip = (page - 1) * limit;
    const candidates = await Profile.aggregate([
        { $match: match },
        {
            $lookup: {
                from: User.collection.name,
                localField: 'userId',
                foreignField: '_id',
                as: 'user',
            },
        },
        { $unwind: '$user' },
        {
            $match: {
                'user.status': 'active',
                // Verification filter (spec §4.6). Defaults in the User model are
                // null, so `$ne: null` selects "timestamp is set".
                ...(showOnlyNinVerified
                    ? { 'user.ninVerifiedAt': { $ne: null } }
                    : { 'user.phoneVerifiedAt': { $ne: null } }),
            },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit + 1 },
    ]);

    const hasMore = candidates.length > limit;
    const page_ = hasMore ? candidates.slice(0, limit) : candidates;

    return res.json({
        page,
        limit,
        hasMore,
        candidates: page_.map(shapeCandidate),
    });
}

module.exports = {
    getDiscovery,
};
