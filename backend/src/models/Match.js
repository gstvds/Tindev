const { Schema, model } = require('mongoose');

// A mutual like between two users (spec §3). The pair is stored canonically —
// userA is always the smaller ObjectId (by hex string), userB the larger — so a
// match between two people is a single document regardless of who liked first.
// The compound unique index on that sorted pair enforces it.
const MatchSchema = new Schema({
    userA: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    userB: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    matchedAt: {
        type: Date,
        default: Date.now,
    },
    status: {
        type: String,
        enum: ['active', 'unmatched'],
        default: 'active',
    },
}, {
    timestamps: true,
});

// Safety net for direct .create()/.save() callers: keep the pair canonical
// (userA < userB) so the unique index below always dedupes it. NOTE: pre hooks
// do not run on findOneAndUpdate, so the controller sorts the pair itself before
// its upsert — this hook only guards other write paths.
MatchSchema.pre('validate', function canonicalizePair(next) {
    if (this.userA && this.userB && String(this.userA) > String(this.userB)) {
        const swap = this.userA;
        this.userA = this.userB;
        this.userB = swap;
    }
    next();
});

// Unique per sorted pair (spec §3): exactly one match document per two users.
MatchSchema.index({ userA: 1, userB: 1 }, { unique: true });

module.exports = model('Match', MatchSchema);
