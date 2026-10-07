const User = require('../models/User');

// The deletion-side analogue of utils/blocks.js. Account deletion (App Store
// Guideline 5.1.1(v)) HARD-deletes a user's OWN User/Profile/Swipe docs and photos,
// but deliberately KEEPS the shared Match/Conversation/Message docs for the other
// party's audit trail — the exact same soft-exclude posture as a block. So, just
// like a block, a deleted user must vanish from the other party's discovery,
// listings, by-id reads, and messaging. The only difference from blocks.js is that
// there's no Block row to consult: we check whether the counterpart's User document
// still exists at all.
//
// The list endpoints (GET /matches, GET /conversations) don't call this — they
// already batch-load the other participants' User docs, so a deleted user is simply
// absent from that map and is filtered out there for free (no redundant query),
// which is the list-side analogue of blocks.js's `blockedUserIds` set. This helper
// is the boolean, one-off analogue of `isBlockedBetween`, for the by-id read routes
// and the live socket send where no such batch load exists.

// True if `userId` no longer has a User document (i.e. the account was deleted).
async function isUserDeleted(userId) {
    if (!userId) return true;
    const exists = await User.exists({ _id: userId });
    return !exists;
}

module.exports = { isUserDeleted };
