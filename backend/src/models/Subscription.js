const { Schema, model } = require('mongoose');

// A user's recurring subscription state (spec §3, §7). Exactly one row per user
// (userId is unique) — the "Unlimited" plan that lifts the daily 10-swipe cap,
// unlocks "see who liked you," and the advanced filters. A user with no row is
// treated as `plan: 'free'` at read time (see SubscriptionController.getMe); we
// don't write a free-tier row on signup.
//
// paymentPlatform routes reconciliation, not preference (spec §7): 'paystack'
// rows carry a paystackSubscriptionCode and are reconciled via the Paystack
// webhook; 'ios_iap' rows carry an iosOriginalTransactionId and are reconciled
// via Apple's App Store Server Notifications v2. Both are populated by the
// subscribe/verify slices — this model is just the data layer.
const SubscriptionSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true,
    },
    plan: {
        type: String,
        enum: ['free', 'unlimited'],
        default: 'free',
    },
    status: {
        type: String,
        enum: ['active', 'cancelled', 'expired'],
        default: 'active',
    },
    // Which processor owns this subscription — set once the paid plan is
    // activated. Absent on a row that has never been paid.
    paymentPlatform: {
        type: String,
        enum: ['ios_iap', 'paystack'],
    },
    // Paystack subscription handle — Android/web path only.
    paystackSubscriptionCode: {
        type: String,
    },
    // The Paystack charge `reference` that last activated/renewed this row — the
    // webhook's idempotency key. Paystack retries webhook deliveries, so the
    // handler only applies a charge whose reference differs from this one; a
    // repeat delivery of the same charge is a no-op and never pushes
    // currentPeriodEnd out another 30 days. A fresh checkout carries a new
    // reference and legitimately renews. Absent until the first charge lands.
    paystackLastReference: {
        type: String,
    },
    // Apple's original transaction id — the stable key across renewals, iOS only.
    iosOriginalTransactionId: {
        type: String,
    },
    // End of the currently paid period; the swipe-cap check (spec §7) treats a
    // subscription as lapsed once this passes even if status hasn't been
    // reconciled yet.
    currentPeriodEnd: {
        type: Date,
    },
}, {
    timestamps: true,
});

module.exports = model('Subscription', SubscriptionSchema);
