const { Schema, model } = require('mongoose');

// One user blocking another (App Store Guideline 1.2 / spec safety requirement).
// Directional: blockerId -> blockedUserId. A block hides each party from the
// other across discovery, matches, conversations, and live messaging (wired in
// Chunk 3), while the underlying Match/Conversation docs are kept for audit.
const BlockSchema = new Schema({
    blockerId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    blockedUserId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
}, {
    timestamps: true,
});

// Exactly one block document per ordered (blocker, blocked) pair. Unlike Match's
// canonical sorted pair, the pair is NOT sorted here — direction is meaningful
// (A blocking B is a different fact from B blocking A, and both can coexist). A
// repeat block collides on this unique index (code 11000), which the controller
// treats as success rather than an error — the same idempotent-by-design pattern
// the Swipe/Match models use.
BlockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });

module.exports = model('Block', BlockSchema);
