const mongoose = require('mongoose');

const Match = require('../models/Match');
const User = require('../models/User');
const Profile = require('../models/Profile');
const { blockedUserIds, isBlockedBetween } = require('../utils/blocks');
const { isUserDeleted } = require('../utils/accounts');

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

    const allMatches = await Match.find({
        status: 'active',
        $or: [{ userA: me }, { userB: me }],
    }).sort({ matchedAt: -1 });

    // Soft-exclude blocked pairs (spec safety / App Store Guideline 1.2): a match
    // with a user on either side of a block is hidden from the list, but its Match
    // document is deliberately NOT deleted — it's kept for moderation/audit and
    // reappears intact if the block is lifted.
    const blocked = new Set(await blockedUserIds(me));
    const matches = allMatches.filter((m) => {
        const otherId = String(m.userA) === me ? String(m.userB) : String(m.userA);
        return !blocked.has(otherId);
    });

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

    // Soft-exclude deleted accounts (App Store Guideline 5.1.1(v)): a match whose
    // other participant deleted their account (no User doc) is hidden, exactly like
    // a blocked pair above. We reuse the batch load just done — an absent user IS a
    // deleted user — so there's no extra query (the list-side analogue of the block
    // set). The Match doc is deliberately KEPT for this side's audit trail.
    const payload = matches
        .filter((m) => {
            const otherId = String(m.userA) === me ? String(m.userB) : String(m.userA);
            return userById.has(otherId);
        })
        .map((m) => {
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

    // Block gate (spec safety / App Store Guideline 1.2): a blocked pair's match
    // reads as "not found" — same info-leak-safe posture as a foreign/missing id,
    // and consistent with GET /matches soft-excluding it from the list.
    if (await isBlockedBetween(me, otherId)) {
        return res.status(404).json({ error: 'Match not found' });
    }

    // Deleted-account gate (App Store Guideline 5.1.1(v)): if the other participant
    // deleted their account, their match reads as "not found" — the same info-leak-
    // safe 404 as a blocked pair, and consistent with GET /matches hiding it. The
    // Match doc itself is kept (never deleted) for this side's audit trail.
    if (await isUserDeleted(otherId)) {
        return res.status(404).json({ error: 'Match not found' });
    }

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
