const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const paystack = require('../services/paystack');

// Server-to-server payment webhooks (spec §5, §6). Unlike every other write
// path these are NOT authenticated with a JWT — Paystack calls them directly —
// so trust is established by verifying the provider's signature over the raw
// request body before a single field of the payload is believed. The Apple
// (App Store Server Notifications v2) handler is a later slice.

// We don't have a real recurring Paystack Plan yet (spec §9 pricing is open), so
// a charge grants a fixed 30-day window. Once a dashboard Plan drives billing,
// currentPeriodEnd should come from the subscription's next_payment_date instead.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// POST /payments/webhook/paystack
// Activates the "Unlimited" plan when Paystack confirms a successful charge.
// This is the ONLY path that writes a paid Subscription row (spec §5 — the
// client-facing subscribe endpoint deliberately persists nothing).
async function paystackWebhook(req, res) {
    // 1. Authenticate the request itself. Anything that fails signature
    //    verification is rejected outright — no payload is trusted (spec §5).
    if (!paystack.verifyWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body || {};

    // 2. We only act on a completed charge. Every other event type (invoice
    //    updates, transfers, etc.) is acknowledged with 200 so Paystack stops
    //    retrying — a non-2xx would make it redeliver events we never handle.
    if (event.event !== 'charge.success') {
        return res.status(200).json({ received: true });
    }

    const data = event.data || {};
    const metadata = data.metadata || {};
    // The mapping we planted at initialization (see SubscriptionController
    // .subscribeWithPaystack and PurchasesController.startPaystackPurchase). After
    // signature verification this metadata is trustworthy — it's our own data,
    // echoed back unmodified.
    const { userId, type, paymentPlatform } = metadata;
    const reference = data.reference;

    // Guard against a charge we can't map to our own flows (missing metadata, or a
    // charge from some other integration on this Paystack account). Ack with 200
    // so it isn't retried — there's nothing to act on.
    if (!userId || paymentPlatform !== 'paystack' || !reference) {
        return res.status(200).json({ received: true });
    }

    // Route on the metadata `type` we planted at init. A one-off purchase (boost /
    // super like) carries a Transaction `type` and settles a Transaction row; a
    // subscription checkout carries no `type` and activates the Subscription row.
    // This is the only branch that decides Transaction-vs-Subscription.
    if (type === 'boost' || type === 'superlike') {
        // Flip the matching pending Transaction to success. Same idempotency shape
        // as the subscription path, keyed on the charge reference: the filter also
        // requires `status: 'pending'`, so a duplicate delivery of an
        // already-settled charge (or an unknown reference) matches nothing and is a
        // harmless no-op. The single atomic findOneAndUpdate means concurrent
        // duplicate deliveries can't both win.
        await Transaction.findOneAndUpdate(
            { paystackReference: reference, status: 'pending' },
            { $set: { status: 'success' } },
        );

        return res.status(200).json({ received: true });
    }

    // Present only when the transaction was initialized against a dashboard Plan
    // (PLN_…); absent for the one-time-charge fallback. Optional either way.
    const paystackSubscriptionCode = data.subscription
        && (data.subscription.subscription_code || data.subscription.code);

    const currentPeriodEnd = new Date(Date.now() + THIRTY_DAYS_MS);

    // 3. Create-or-update the user's single Subscription row, idempotently.
    //    Paystack retries deliveries, so the filter excludes a charge we've
    //    already applied (`paystackLastReference` === this reference). A retry
    //    of the same charge therefore matches nothing; because of `upsert` Mongo
    //    then tries to INSERT and hits the unique `userId` index — that E11000
    //    collision IS the idempotency guarantee (the charge was already applied),
    //    so we swallow it. This is what stops a retry from pushing
    //    currentPeriodEnd out another 30 days. A brand-new checkout carries a new
    //    reference, matches the row (or inserts the first one), and renews.
    try {
        await Subscription.findOneAndUpdate(
            { userId, paystackLastReference: { $ne: reference } },
            {
                $set: {
                    plan: 'unlimited',
                    status: 'active',
                    paymentPlatform: 'paystack',
                    currentPeriodEnd,
                    paystackLastReference: reference,
                    ...(paystackSubscriptionCode ? { paystackSubscriptionCode } : {}),
                },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
    } catch (err) {
        // Duplicate delivery of an already-applied charge — expected, no-op.
        // Anything else is a real failure and propagates to the error handler.
        if (err.code !== 11000) {
            throw err;
        }
    }

    return res.status(200).json({ received: true });
}

module.exports = {
    paystackWebhook,
};
