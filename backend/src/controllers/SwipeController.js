const mongoose = require('mongoose');

const Swipe = require('../models/Swipe');
const Match = require('../models/Match');
const User = require('../models/User');

// Only a mutual like OR superlike forms a match — a `pass` never does (spec §4).
const LIKE_ACTIONS = ['like', 'superlike'];
const VALID_ACTIONS = ['like', 'pass', 'superlike'];

// Canonical ordering for a Match's user pair: smaller ObjectId (by hex string)
// first. Storing the pair this way makes a match between two people a single
// document regardless of who swiped first, which the unique index then dedupes.
function sortPair(a, b) {
    return String(a) < String(b) ? [a, b] : [b, a];
}

// Create (or resurrect the query for) the Match document for a mutual like.
// Upserts on the sorted pair so it's idempotent; the try/catch handles the race
// where two users like each other near-simultaneously and both attempt to insert
// the same pair — one wins, the other re-reads the now-existing match.
async function upsertMatch(a, b) {
    const [userA, userB] = sortPair(a, b);
    try {
        return await Match.findOneAndUpdate(
            { userA, userB },
            { $setOnInsert: { userA, userB } },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        );
    } catch (err) {
        // Duplicate key on the (userA, userB) unique index — the pair already
        // exists (concurrent insert won the race), so just return it.
        if (err.code === 11000) {
            return Match.findOne({ userA, userB });
        }
        throw err;
    }
}

// POST /swipes  { targetId, action }
// Records the requester's swipe on another user and, if this completes a mutual
// like/superlike, creates the Match. Discovery (GET /discovery) and match listing
// (GET /matches) are separate endpoints, not built here.
async function createSwipe(req, res) {
    const actorId = req.userId;
    const { targetId, action } = req.body;

    if (!VALID_ACTIONS.includes(action)) {
        return res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
    }
    if (!targetId || !mongoose.Types.ObjectId.isValid(targetId)) {
        return res.status(400).json({ error: 'A valid targetId is required' });
    }
    if (String(targetId) === String(actorId)) {
        return res.status(400).json({ error: 'You cannot swipe on yourself' });
    }

    const target = await User.findById(targetId);
    if (!target) {
        return res.status(404).json({ error: 'Target user not found' });
    }

    // Record the swipe. Upsert on the (actorId, targetId) unique pair so a repeat
    // swipe updates the action in place (e.g. a prior `pass` becoming a `like`)
    // instead of colliding on the unique index — last action wins.
    const swipe = await Swipe.findOneAndUpdate(
        { actorId, targetId },
        { $set: { action }, $setOnInsert: { actorId, targetId } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );

    // A match forms only when this swipe is a like/superlike AND the target has
    // already liked/superliked the actor back.
    let match = null;
    if (LIKE_ACTIONS.includes(action)) {
        const reciprocal = await Swipe.findOne({
            actorId: targetId,
            targetId: actorId,
            action: { $in: LIKE_ACTIONS },
        });
        if (reciprocal) {
            match = await upsertMatch(actorId, targetId);
        }
    }

    return res.status(201).json({
        swipe,
        isMatch: Boolean(match),
        match,
    });
}

module.exports = {
    createSwipe,
};
