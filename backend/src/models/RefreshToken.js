const { Schema, model } = require('mongoose');

// Refresh tokens themselves are stateless JWTs (see utils/jwt.js) — nothing is
// written here when one is minted. This collection exists purely to make
// rotation enforceable: POST /auth/refresh writes ONE row per token, at the
// moment that token is redeemed, keyed by a SHA-256 hash of the raw token (never
// the token itself, so a DB read alone can't hand out a live bearer credential).
// The unique index on tokenHash is the entire safety mechanism — Mongo's own
// uniqueness guarantee is the "lock", so two concurrent redemptions of the same
// token race on a single insert and exactly one wins, with no transaction
// needed (same non-transactional-but-safe posture as the account deletion
// cascade). A second redemption attempt of an already-spent token — whether a
// genuine replay after rotation or the loser of that race — hits a duplicate
// key error and is rejected.
const RefreshTokenSchema = new Schema({
    tokenHash: {
        type: String,
        required: true,
        unique: true,
    },
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    usedAt: {
        type: Date,
        default: Date.now,
    },
    // Mirrors the redeemed token's own `exp` claim. Once a refresh token is past
    // this point it's already rejected by verifyRefreshToken before the DB is
    // ever consulted, so the spent-marker row has no further purpose — the TTL
    // index reaps it automatically rather than letting this collection grow
    // unboundedly.
    expiresAt: {
        type: Date,
        required: true,
    },
}, {
    timestamps: true,
});

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('RefreshToken', RefreshTokenSchema);
