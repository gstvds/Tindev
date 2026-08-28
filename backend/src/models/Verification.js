const { Schema, model } = require('mongoose');

// One row per verification attempt (spec §3). For phone_otp the provider is
// Termii; providerRef holds the SMS message_id returned by Termii's send.
// nin_selfie rows are written later by the KYC flow (§6).
//
// codeHash/expiresAt/attempts extend the base spec model: because Termii's
// managed Token API is not activated for our account (see the OTP blockers
// note), we generate and validate the OTP ourselves and only use Termii to
// deliver the SMS. The plaintext code is NEVER stored — only its bcrypt hash.
const VerificationSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    type: {
        type: String,
        enum: ['phone_otp', 'nin_selfie'],
        required: true,
    },
    status: {
        type: String,
        enum: ['pending', 'verified', 'failed'],
        default: 'pending',
    },
    provider: {
        type: String,
    },
    providerRef: {
        type: String,
    },
    // bcrypt hash of the OTP — never the plaintext code. select:false keeps it
    // out of query results unless a caller explicitly asks for it.
    codeHash: {
        type: String,
        select: false,
    },
    // OTP lifetime; a code past this is treated as expired on verify.
    expiresAt: {
        type: Date,
    },
    // Failed verify attempts against this code; capped before invalidation.
    attempts: {
        type: Number,
        default: 0,
    },
    verifiedAt: {
        type: Date,
    },
}, {
    timestamps: true,
});

module.exports = model('Verification', VerificationSchema);
