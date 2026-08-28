const crypto = require('crypto');

const Subscription = require('../models/Subscription');
const paystack = require('../services/paystack');

// GET /subscriptions/me
// Read-only snapshot of the authenticated user's subscription (spec §6, §7).
// Makes no payment call — it only reads what the subscribe/verify slices have
// persisted. A user who has never subscribed has no Subscription row, so we
// default to the free plan rather than writing a free-tier row on signup.
async function getMe(req, res) {
    const subscription = await Subscription.findOne({ userId: req.userId })
        .select('plan status paymentPlatform currentPeriodEnd')
        .lean();

    // No row yet → free plan. `status: 'active'` here means "the free tier is in
    // effect," not a paid subscription; currentPeriodEnd is null because free
    // never expires. This mirrors the schema defaults (plan 'free', status
    // 'active') so a defaulted response and a real free-tier row read the same.
    if (!subscription) {
        return res.json({
            plan: 'free',
            status: 'active',
            paymentPlatform: null,
            currentPeriodEnd: null,
        });
    }

    return res.json({
        plan: subscription.plan,
        status: subscription.status,
        paymentPlatform: subscription.paymentPlatform ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    });
}

// POST /subscriptions/subscribe/paystack
// Starts the Paystack checkout for the "Unlimited" plan on the Android/web path
// (spec §5, §6, §7). Initializes a Paystack transaction and returns the
// `authorizationUrl` the client redirects to (or opens in the Paystack SDK) to
// pay. This endpoint activates NOTHING: no Subscription row is created or
// updated here — that happens only when the signature-verified Paystack webhook
// confirms the charge (a later slice). We carry our userId + plan in the
// transaction metadata so that webhook can map the payment back to this user.
async function subscribeWithPaystack(req, res) {
    // Don't start a second checkout for someone already on an active paid plan —
    // a read-only guard against double-charging (this does not write the row).
    const existing = await Subscription.findOne({ userId: req.userId })
        .select('plan status')
        .lean();
    if (existing && existing.plan === 'unlimited' && existing.status === 'active') {
        return res.status(409).json({ error: 'You already have an active Unlimited subscription' });
    }

    // Our own idempotent reference for this attempt; carried through Paystack and
    // echoed back on the webhook for reconciliation.
    const reference = crypto.randomUUID();

    // Paystack requires an email, but accounts are phone-only (spec §3 User has
    // no email). Synthesize a stable, well-formed placeholder from the phone so
    // Paystack accepts the request and the same user maps to the same customer.
    //
    // ⚠ LAUNCH BLOCKER (tracked in docs/sabipesin-todo-list.md): Paystack mails
    // the payment RECEIPT to this address, so with a synthesized @users.sabipesin
    // .com placeholder real payers never receive their receipt. A real email must
    // be captured (its own email-capture slice) before Paystack goes live. The
    // seam is here: once Profile carries an email, read it first and fall back to
    // the synthesized address only when absent (`profile?.email || synthesized`).
    const email = `${req.user.phone}@users.sabipesin.com`;

    // A PaystackError here propagates to the central error handler (-> 502); the
    // throw stops execution, so nothing is persisted on a failed init.
    const txn = await paystack.initializeSubscriptionTransaction({
        email,
        reference,
        metadata: {
            userId: req.userId,
            plan: 'unlimited',
            paymentPlatform: 'paystack',
        },
    });

    // Hand the client exactly what it needs to continue to Paystack's hosted
    // checkout. `reference` is returned so the client can optionally poll/verify.
    return res.status(201).json({
        message: 'Paystack transaction initialized',
        authorizationUrl: txn.authorizationUrl,
        accessCode: txn.accessCode,
        reference: txn.reference,
    });
}

module.exports = {
    getMe,
    subscribeWithPaystack,
};
