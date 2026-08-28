const { Schema, model } = require('mongoose');

// The chat thread for a Match (spec §3). Created off a Match and 1:1 with it —
// `matchId` is unique so a match has exactly one conversation. `participants`
// mirrors the match's two users (denormalised so listing a user's conversations
// is a single indexed query without joining back through Match). `lastMessageAt`
// is bumped on each new message so threads can be sorted most-recent-first
// without scanning the Message collection.
const ConversationSchema = new Schema({
    matchId: {
        type: Schema.Types.ObjectId,
        ref: 'Match',
        required: true,
        unique: true,
    },
    participants: [{
        type: Schema.Types.ObjectId,
        ref: 'User',
    }],
    lastMessageAt: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: true,
});

// Listing "my conversations" filters on membership, so index the participant ids.
ConversationSchema.index({ participants: 1 });

module.exports = model('Conversation', ConversationSchema);
