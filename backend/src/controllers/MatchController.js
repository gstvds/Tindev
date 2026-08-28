const mongoose = require('mongoose');

const Match = require('../models/Match');
const User = require('../models/User');
const Profile = require('../models/Profile');

// Strip a candidate/other user's private discoverySettings before returning
// their profile — those are theirs alone.
function publicProfile(profile) {
    if (!profile) return null;
    const obj = profile.toObject();
    delete obj.discoverySettings;
    return obj;
}

// Shape one Match for the requester `me`, resolving the OTHER participant and
// attaching their derived verificationTier — spec §4.7: always included, never
// hidden or softened, even when null. `otherUser` / `otherProfile` are looked up
// by the caller (batched for the list, single for the detail endpoint).
function shapeMatch(m, me, otherUser, otherProfile) {
    const otherId = String(m.userA) === me ? String(m.userB) : String(m.userA);
    return {
        id: m._id,
        matchedAt: m.matchedAt,
        status: m.status,
        otherUser: {
            id: otherId,
            verificationTier: otherUser ? otherUser.verificationTier : null,
            profile: publicProfile(otherProfile),
        },
    };
}

// GET /matches
// The authenticated user's active matches, newest first. Each carries the other
// participant's verificationTier (§4.7); the viewer's own tier is included too so
// both sides are covered.
async function listMatches(req, res) {
    const me = req.userId;

    const matches = await Match.find({
        status: 'active',
        $or: [{ userA: me }, { userB: me }],
    }).sort({ matchedAt: -1 });

    // The "other" user in each match is whichever side isn't the requester.
    const otherIds = matches.map((m) => (String(m.userA) === me ? m.userB : m.userA));

    // Batch-load the other users (hydrated so the verificationTier virtual runs)
    // and their profiles, then index by id for O(1) assembly.
    const [users, profiles] = await Promise.all([
        User.find({ _id: { $in: otherIds } }),
        Profile.find({ userId: { $in: otherIds } }),
    ]);
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));

    const payload = matches.map((m) => {
        const otherId = String(m.userA) === me ? String(m.userB) : String(m.userA);
        return shapeMatch(m, me, userById.get(otherId), profileByUserId.get(otherId));
    });

    return res.json({
        // The viewer's own tier, so §4.7's "each participant" is fully satisfied.
        viewerVerificationTier: req.user.verificationTier,
        matches: payload,
    });
}

// GET /matches/:id
// A single match belonging to the requester. Returns the same shape as one entry
// of GET /matches (other participant's verificationTier included, §4.7) plus the
// viewer's own tier. 404s if the match doesn't exist OR isn't one of the
// requester's — the two are deliberately indistinguishable so this endpoint can't
// be used to probe whether an arbitrary match id exists.
async function getMatch(req, res) {
    const me = req.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(404).json({ error: 'Match not found' });
    }

    // Scope the lookup to matches the requester is part of, so someone else's
    // match reads as "not found" rather than leaking its existence.
    const match = await Match.findOne({
        _id: id,
        $or: [{ userA: me }, { userB: me }],
    });
    if (!match) {
        return res.status(404).json({ error: 'Match not found' });
    }

    const otherId = String(match.userA) === me ? String(match.userB) : String(match.userA);
    const [otherUser, otherProfile] = await Promise.all([
        User.findById(otherId),
        Profile.findOne({ userId: otherId }),
    ]);

    return res.json({
        viewerVerificationTier: req.user.verificationTier,
        match: shapeMatch(match, me, otherUser, otherProfile),
    });
}

module.exports = {
    listMatches,
    getMatch,
};
