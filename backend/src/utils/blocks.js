const Block = require('../models/Block');

// Shared block lookups so discovery, match/conversation listing, and live
// messaging all apply the SAME "either direction" rule from one place. A block is
// mutual in effect (spec / App Store Guideline 1.2): if A blocked B or B blocked
// A, the two should not see or reach each other — regardless of who initiated it.

// Every user id that is on the other side of a block from `userId`, in EITHER
// direction (userId blocked them, or they blocked userId). Returned as a de-duped
// array of hex strings. Used to exclude those users from discovery and to
// soft-exclude blocked pairs from match/conversation listings.
async function blockedUserIds(userId) {
    const me = String(userId);
    const blocks = await Block.find({
        $or: [{ blockerId: me }, { blockedUserId: me }],
    });
    const ids = new Set();
    for (const b of blocks) {
        const other = String(b.blockerId) === me ? String(b.blockedUserId) : String(b.blockerId);
        ids.add(other);
    }
    return [...ids];
}

// True if either party has blocked the other. Used by the socket message:send
// handler to refuse delivery between blocked users.
async function isBlockedBetween(a, b) {
    const found = await Block.findOne({
        $or: [
            { blockerId: a, blockedUserId: b },
            { blockerId: b, blockedUserId: a },
        ],
    });
    return Boolean(found);
}

module.exports = { blockedUserIds, isBlockedBetween };
