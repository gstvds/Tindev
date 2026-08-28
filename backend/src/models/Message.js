const { Schema, model } = require('mongoose');

// A single chat message within a Conversation (spec §3). `flagged` defaults to
// false and is where the anti-scam keyword filter will set `true` later (Phase 5,
// spec §8.5) — the field lives here now so the data layer is stable before that
// logic lands. `readAt` is null until the recipient's `read` event marks it;
// nothing writes it yet (the read endpoints in this phase are pure reads).
const MessageSchema = new Schema({
    conversationId: {
        type: Schema.Types.ObjectId,
        ref: 'Conversation',
        required: true,
        index: true,
    },
    senderId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    text: {
        type: String,
    },
    flagged: {
        type: Boolean,
        default: false,
    },
    readAt: {
        type: Date,
        default: null,
    },
}, {
    timestamps: true,
});

// Messages are always read by conversation, newest first / paginated — a compound
// index on (conversationId, createdAt) serves both the filter and the sort.
MessageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = model('Message', MessageSchema);
