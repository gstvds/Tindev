const axios = require('axios');
const crypto = require('crypto');

// Paystack payments integration — the Android/web/PWA path for the "Unlimited"
// subscription (spec §5, §6, §7). iOS goes through StoreKit instead; Paystack is
// never used on iOS (Apple requires IAP for digital subscriptions).
//
// This module's only job here is to INITIALIZE a Paystack transaction and hand
// back the hosted checkout URL:
//
//   initializeSubscriptionTransaction -> POST {BASE}/transaction/initialize
//     -> { authorization_url, access_code, reference }
//
// The client redirects the browser (or opens the Paystack SDK) to
// `authorization_url` to actually pay. NOTHING is persisted here and no
// Subscription row is written — activation happens only when the
// signature-verified Paystack webhook confirms the charge (a later slice, spec
// §5 "never trust a client-reported purchase"). We carry `metadata` (our userId
// + plan) and our own `reference` through the transaction so the webhook can map
// the payment back to the right user without any pre-created DB row.
//
// Unlike qoreid.js there's no ENABLED dev-toggle: Paystack's sk_test_/pk_test_
// keys ARE the sandbox — test-mode calls are free and safe, so we always hit the
// real API and let the key decide test vs. live.
//
// TODO(pricing): the final naira price of the Unlimited plan is still open (spec
// §9). PAYSTACK_UNLIMITED_AMOUNT_KOBO is a placeholder default; set the real
// price via env, or set PAYSTACK_UNLIMITED_PLAN_CODE to a dashboard-created Plan
// so Paystack manages the recurring billing itself.

const {
    PAYSTACK_SECRET_KEY,
    PAYSTACK_BASE_URL = 'https://api.paystack.co',
    // Amount to charge in kobo when there's no dashboard Plan. Placeholder
    // ₦5,000 until the real price is set (spec §9 open item).
    PAYSTACK_UNLIMITED_AMOUNT_KOBO = '500000',
    // Optional Paystack "Plan" code (PLN_xxx) created in the dashboard. When set,
    // the transaction is initialized against the plan and Paystack creates &
    // manages the recurring subscription itself (the amount is taken from the
    // plan); when unset we fall back to a one-time charge of AMOUNT_KOBO. The two
    // are mutually exclusive on transaction/initialize — mirrors qoreid.js's
    // workflow-vs-collection dual mode.
    PAYSTACK_UNLIMITED_PLAN_CODE,
    // Where Paystack redirects the browser after checkout (web/PWA). Optional —
    // the native Android SDK returns control in-app and ignores this.
    PAYSTACK_CALLBACK_URL,
} = process.env;

if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
        'PAYSTACK_SECRET_KEY is not set. Copy .env.example to .env and provide the Paystack secret key.'
    );
}

// A Paystack request that reaches the API but is rejected (bad key, invalid
// params) — or an API response whose envelope reports `status: false` — surfaces
// as this error. Matched by name in the central error handler (like TermiiError /
// QoreIdError) and mapped to a 502, so this module stays decoupled from HTTP.
class PaystackError extends Error {
    constructor(message, { status, data } = {}) {
        super(message);
        this.name = 'PaystackError';
        this.status = status;
        this.data = data;
    }
}

// Bearer secret-key header for Paystack's REST API.
function authHeader() {
    return `Bearer ${PAYSTACK_SECRET_KEY}`;
}

// Low-level POST {BASE}/transaction/initialize. Shared by every init path
// (subscription and one-off purchases) so the HTTP call, error mapping, and
// success-envelope validation live in exactly one place. Takes the fully-built
// payload and resolves to Paystack's `data` object (the inner `data.data`), whose
// `authorization_url` is guaranteed present on return.
async function initializeTransaction(payload) {
    let data;
    try {
        ({ data } = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            payload,
            {
                headers: {
                    Authorization: authHeader(),
                    'Content-Type': 'application/json',
                },
            },
        ));
    } catch (err) {
        if (err.response) {
            const { status, data: body } = err.response;
            const message = (body && (body.message || body.error)) || `Paystack request failed (${status})`;
            throw new PaystackError(message, { status, data: body });
        }
        throw new PaystackError(`Could not reach Paystack: ${err.message}`);
    }

    // Paystack envelopes every response as { status: boolean, message, data }.
    // A truthy `status` with a `data.authorization_url` is the only success shape.
    if (!data || data.status !== true || !data.data || !data.data.authorization_url) {
        throw new PaystackError((data && data.message) || 'Paystack did not return an authorization URL', { data });
    }

    return data.data;
}

// Initializes a Paystack transaction for the Unlimited subscription.
//   email     — the customer's email (Paystack requires one; see the controller
//               for how we source it from a phone-only account)
//   reference — our own idempotent transaction reference, carried through so the
//               webhook can reconcile the charge back to this attempt
//   metadata  — arbitrary object echoed back on the webhook (we pass userId/plan)
// Resolves to { authorizationUrl, accessCode, reference, amount, plan, raw }.
// `authorizationUrl` is the only value the client strictly needs to continue.
async function initializeSubscriptionTransaction({ email, reference, metadata } = {}) {
    const amount = Number(PAYSTACK_UNLIMITED_AMOUNT_KOBO) || 500000;

    const payload = {
        email,
        // Paystack ignores `amount` when a `plan` is supplied (it uses the plan's
        // amount), but we always send it so the one-time-charge fallback works.
        amount,
        currency: 'NGN',
        reference,
        metadata,
    };
    if (PAYSTACK_UNLIMITED_PLAN_CODE) {
        payload.plan = PAYSTACK_UNLIMITED_PLAN_CODE;
    }
    if (PAYSTACK_CALLBACK_URL) {
        payload.callback_url = PAYSTACK_CALLBACK_URL;
    }

    const result = await initializeTransaction(payload);

    return {
        authorizationUrl: result.authorization_url,
        accessCode: result.access_code,
        reference: result.reference,
        amount,
        plan: PAYSTACK_UNLIMITED_PLAN_CODE || null,
        raw: result,
    };
}

// Initializes a Paystack transaction for a ONE-OFF charge — a profile boost or a
// super like (spec §5, §6). Deliberately generic: unlike
// initializeSubscriptionTransaction it never attaches a `plan` (there's no
// recurring billing for a one-off) and the caller supplies the exact kobo amount,
// so the same function serves boost, super like, and any future one-off product.
//   email     — the customer's email (Paystack requires one; sourced from the
//               phone-only account the same way the subscription path does)
//   amount    — the charge amount in kobo (positive integer)
//   reference — our own idempotent transaction reference, carried through and
//               echoed back on the webhook so it maps to our pending Transaction
//   metadata  — arbitrary object echoed back on the webhook (we pass userId/type)
// Resolves to { authorizationUrl, accessCode, reference, amount, raw }.
async function initializeOneOffTransaction({ email, amount, reference, metadata } = {}) {
    const amountKobo = Number(amount);
    if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
        throw new PaystackError('initializeOneOffTransaction requires a positive integer kobo amount');
    }

    const payload = {
        email,
        amount: amountKobo,
        currency: 'NGN',
        reference,
        metadata,
    };
    if (PAYSTACK_CALLBACK_URL) {
        payload.callback_url = PAYSTACK_CALLBACK_URL;
    }

    const result = await initializeTransaction(payload);

    return {
        authorizationUrl: result.authorization_url,
        accessCode: result.access_code,
        reference: result.reference,
        amount: amountKobo,
        raw: result,
    };
}

// Verifies a Paystack webhook came from Paystack and wasn't tampered with (spec
// §5 "never trust a client-reported purchase"). Paystack signs each webhook with
// HMAC-SHA512 of the RAW request body keyed by our secret key, and sends the hex
// digest in the `x-paystack-signature` header. We recompute it over the captured
// raw bytes (see server.js `req.rawBody`) and compare.
//   rawBody   — the exact request-body bytes (Buffer or string), NOT the parsed
//               object; re-serializing would change the bytes and never match
//   signature — the `x-paystack-signature` header value
// Returns true only on an exact match. Any missing input, or a length/content
// mismatch, returns false — the caller rejects with 401. The comparison is
// constant-time to avoid leaking how much of the digest matched.
function verifyWebhookSignature(rawBody, signature) {
    if (!rawBody || !signature) {
        return false;
    }

    const expected = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(rawBody)
        .digest('hex');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(String(signature), 'utf8');

    // timingSafeEqual throws if the lengths differ, so short-circuit first. A
    // valid Paystack signature is always a 128-char sha512 hex digest, so a
    // length mismatch is by definition not a match.
    if (expectedBuf.length !== providedBuf.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = {
    initializeSubscriptionTransaction,
    initializeOneOffTransaction,
    verifyWebhookSignature,
    PaystackError,
};
