const { Schema, model } = require('mongoose');

// One directional swipe: actor -> target (spec §3). A mutual like/superlike
// between two users forms a Match — that logic lives in SwipeController, not
// here. `pass` is recorded too so discovery can exclude already-swiped users.
const SwipeSchema = new Schema({
    actorId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    targetId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    action: {
        type: String,
        enum: ['like', 'pass', 'superlike'],
        required: true,
    },
}, {
    timestamps: true,
});

// One swipe per (actor, target) — spec §3. Also serves as the lookup index for
// the reciprocal-like check in SwipeController and for excluding already-swiped
// users from discovery later. Unique so a repeat swipe updates in place (the
// controller upserts) rather than creating duplicate rows.
SwipeSchema.index({ actorId: 1, targetId: 1 }, { unique: true });

module.exports = model('Swipe', SwipeSchema);
