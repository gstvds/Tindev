const crypto = require('crypto');

const Transaction = require('../models/Transaction');
const paystack = require('../services/paystack');

// One-off purchases on the Android/web path (spec §5, §6, §7): a profile boost
// and a super like. Both are structurally identical — authenticate, initialize a
// one-off Paystack transaction, persist a PENDING Transaction row keyed by our
// reference, and hand the client the hosted-checkout `authorizationUrl`. They
// differ only in `type` and price, so a single helper drives both endpoints.
//
// Nothing is *granted* here (no boost window opened, no super like credited): a
// row is written as `pending` and only flips to `success` when the
// signature-verified Paystack webhook confirms the charge (spec §5 — never trust
// a client-reported purchase). iOS goes through StoreKit instead (a later slice).

// Per-product naira price in kobo. Boost and super like prices are still open
// (spec §9), so these mirror the subscription's placeholder pattern: an env
// override with a hard-coded fallback. Set the real prices via env before launch.
const {
    // Placeholder ₦1,500 profile boost.
    PAYSTACK_BOOST_AMOUNT_KOBO = '150000',
    // Placeholder ₦500 super like.
    PAYSTACK_SUPERLIKE_AMOUNT_KOBO = '50000',
} = process.env;

const PURCHASE_AMOUNT_KOBO = {
    boost: Number(PAYSTACK_BOOST_AMOUNT_KOBO) || 150000,
    superlike: Number(PAYSTACK_SUPERLIKE_AMOUNT_KOBO) || 50000,
};

// Shared body for both purchase endpoints. `type` is one of the Transaction
// enum values ('boost' | 'superlike').
async function startPaystackPurchase(req, res, type) {
    const amountKobo = PURCHASE_AMOUNT_KOBO[type];

    // Our own idempotent reference for this attempt; carried through Paystack and
    // echoed back on the webhook, and stored as the Transaction's unique key so
    // the webhook can reconcile the charge to exactly this row.
    const reference = crypto.randomUUID();

    // Paystack requires an email, but accounts are phone-only (spec §3). Synthesize
    // the same stable placeholder the subscription path uses. ⚠ Same launch blocker
    // applies (receipts go to this address) — see SubscriptionController for the seam.
    const email = `${req.user.phone}@users.sabipesin.com`;

    // A PaystackError here propagates to the central error handler (-> 502); the
    // throw stops execution BEFORE the Transaction row is written, so a failed
    // init leaves no orphan `pending` row.
    const txn = await paystack.initializeOneOffTransaction({
        email,
        amount: amountKobo,
        reference,
        metadata: {
            userId: req.userId,
            // `type` is the discriminator the webhook routes on: its presence (and
            // being a Transaction enum value) marks this charge as a one-off
            // purchase rather than a subscription, so the webhook updates a
            // Transaction row instead of a Subscription row.
            type,
            paymentPlatform: 'paystack',
        },
    });

    // Persist the pending purchase only after Paystack accepted the init. The
    // charge can't land before the payer visits `authorizationUrl`, so this row is
    // always in place well before the webhook fires.
    await Transaction.create({
        userId: req.userId,
        type,
        paymentPlatform: 'paystack',
        amountKobo,
        paystackReference: reference,
        status: 'pending',
    });

    return res.status(201).json({
        message: 'Paystack transaction initialized',
        authorizationUrl: txn.authorizationUrl,
        accessCode: txn.accessCode,
        reference: txn.reference,
    });
}

// POST /purchases/boost/paystack — authenticated. Starts checkout for a profile
// boost (time-boxed visibility increase).
async function boostWithPaystack(req, res) {
    return startPaystackPurchase(req, res, 'boost');
}

// POST /purchases/superlike/paystack — authenticated. Starts checkout for a
// single super like.
async function superlikeWithPaystack(req, res) {
    return startPaystackPurchase(req, res, 'superlike');
}

module.exports = {
    boostWithPaystack,
    superlikeWithPaystack,
};
