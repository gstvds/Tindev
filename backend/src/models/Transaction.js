const { Schema, model } = require('mongoose');

// A one-off purchase — a profile boost or a super like (spec §3, §7). Unlike
// Subscription there can be many rows per user, one per purchase attempt.
//
// The two provider references are the idempotency keys for reconciliation and
// are `unique` + `sparse` (spec §3): sparse so the many rows that don't yet have
// a reference for a given platform (e.g. an iOS purchase has no
// paystackReference) don't collide on `null` under the unique index. Exactly one
// of the two is set per completed transaction, matching paymentPlatform.
const TransactionSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    type: {
        type: String,
        enum: ['boost', 'superlike'],
        required: true,
    },
    paymentPlatform: {
        type: String,
        enum: ['ios_iap', 'paystack'],
    },
    // Amount in kobo — the Paystack path. Apple reports its own price/currency in
    // the receipt, so this is the naira-side amount for the Paystack path.
    amountKobo: {
        type: Number,
    },
    // Paystack transaction reference — the idempotency key for the Paystack
    // webhook. sparse so iOS rows (which never set it) don't collide on null.
    paystackReference: {
        type: String,
        unique: true,
        sparse: true,
    },
    // Apple's transaction id — the idempotency key for the App Store server
    // notification. sparse for the same reason as paystackReference.
    iosTransactionId: {
        type: String,
        unique: true,
        sparse: true,
    },
    status: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending',
    },
}, {
    timestamps: true,
});

module.exports = model('Transaction', TransactionSchema);
