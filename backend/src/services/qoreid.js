const crypto = require('crypto');
const axios = require('axios');

// QoreID KYC integration for NIN + selfie verification (spec §1, §4.2, §6).
//
// The flow is session-based: the backend authenticates to QoreID with its
// clientId/secret (HTTP Basic) and mints a short-lived verification SESSION. The
// only thing the client ever receives is the session's `sdkSessionToken` — the
// JWT the QoreID mobile/web SDK uses to run the actual NIN lookup + selfie
// liveness capture on the device. The result comes back later via the webhook
// (POST /verification/nin/webhook, built in a later slice — not here).
//
//   startNinVerification -> POST {BASE}/v1/sessions -> { sessionId, sdkSessionToken, expiresAt }
//
// QOREID_ENABLED gates the real API call. When it is not 'true' (the dev default)
// we skip QoreID entirely and return a mocked-but-well-formed session, so local
// development and tests never hit the vendor (nor cost a sandbox call). This
// mirrors CraftRanked's QOREID_ENABLED dev-mode toggle (see the SabiPesin todo
// list, "QoreID dev-mode toggle"). Flip QOREID_ENABLED=true with real sandbox/
// production credentials to exercise the live integration.
//
// TODO(sabipesin-credentials): QOREID_CLIENT_ID / QOREID_SECRET are the sandbox
// credentials for now. SabiPesin's own PRODUCTION QoreID account is blocked
// pending CAC documents (see the todo list) — swap to production credentials and
// set QOREID_ENABLED=true before launch.

const {
    QOREID_ENABLED,
    QOREID_CLIENT_ID,
    QOREID_SECRET,
    QOREID_BASE_URL = 'https://api.qoreid.com',
    // QoreID sessions run EITHER a dashboard-configured workflow (preferred; the
    // account's dashboard exposes a numeric "Workflow ID") OR a single product
    // ("collection" session). If QOREID_WORKFLOW_ID is set we mint a workflow
    // session; otherwise we fall back to a productCode collection session. The
    // two are mutually exclusive in QoreID's /v1/sessions API.
    QOREID_WORKFLOW_ID,
    // Product for a collection session. Only used when QOREID_WORKFLOW_ID is
    // unset. NOTE: QoreID product codes are short slugs — live probing showed
    // 'nin' and 'liveness' are recognized (the earlier guess 'nin_face_match' is
    // rejected as "Unknown productCode"). The exact code for the combined NIN +
    // selfie face-match flow is still to be confirmed once the QoreID account is
    // subscribed to it; 'nin' is a recognized placeholder default.
    QOREID_NIN_PRODUCT_CODE = 'nin',
    // Session lifetime and how many capture attempts the SDK allows before the
    // session is spent. Sensible defaults; tunable via env.
    QOREID_SESSION_TTL_SECONDS = '900',
    QOREID_SESSION_MAX_ATTEMPTS = '3',
} = process.env;

// True only when explicitly switched on. Anything else (unset, 'false', '0') is
// dev mode: no real QoreID call is made. Kept lenient on the truthy side so
// 'true'/'TRUE'/'1' all enable it.
const isEnabled = ['true', '1', 'yes'].includes(String(QOREID_ENABLED).toLowerCase());

// A QoreID request that reaches the API but fails (bad credentials, rejected
// session, vendor outage) surfaces as this error. Matched by name in the central
// error handler (like TermiiError / CloudinaryError) and mapped to a 502, so
// this module stays decoupled from the HTTP layer.
class QoreIdError extends Error {
    constructor(message, { status, data } = {}) {
        super(message);
        this.name = 'QoreIdError';
        this.status = status;
        this.data = data;
    }
}

// HTTP Basic credential header for QoreID's session endpoint.
function authHeader() {
    if (!QOREID_CLIENT_ID || !QOREID_SECRET) {
        throw new QoreIdError(
            'QOREID_CLIENT_ID / QOREID_SECRET are not set but QOREID_ENABLED is true. '
            + 'Provide QoreID credentials or set QOREID_ENABLED=false for dev mode.'
        );
    }
    const basic = Buffer.from(`${QOREID_CLIENT_ID}:${QOREID_SECRET}`).toString('base64');
    return `Basic ${basic}`;
}

// Starts a NIN + selfie verification session.
//   reference  — our own idempotent txn reference (echoed back by the vendor)
//   subjectRef — our internal user id, so vendor callbacks map back to a user
// Resolves to { sessionId, sdkSessionToken, expiresAt, productCode, mock }.
// `sdkSessionToken` is the only value the client needs to continue the flow.
async function startNinVerification({ reference, subjectRef } = {}) {
    const ttlSeconds = Number(QOREID_SESSION_TTL_SECONDS) || 900;
    const maxAttempts = Number(QOREID_SESSION_MAX_ATTEMPTS) || 3;

    // Workflow session (dashboard-configured) takes precedence over a single
    // productCode collection session; the two are mutually exclusive.
    const sessionSpec = QOREID_WORKFLOW_ID
        ? { type: 'workflow', workflowId: Number(QOREID_WORKFLOW_ID) }
        : { type: 'collection', productCode: QOREID_NIN_PRODUCT_CODE };

    // Dev mode: skip the vendor entirely and hand back a well-formed fake
    // session so the client flow and the pending Verification record can be
    // exercised end-to-end without a real (billable) QoreID call.
    if (!isEnabled) {
        const suffix = crypto.randomUUID();
        return {
            sessionId: `mock_sess_${suffix}`,
            sdkSessionToken: `mock_sdk_${suffix}`,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
            productCode: sessionSpec.productCode,
            workflowId: sessionSpec.workflowId,
            mock: true,
        };
    }

    // Resolve credentials before the try so a missing-credential QoreIdError
    // surfaces its own message rather than being wrapped as a network failure.
    const authorization = authHeader();

    let data;
    try {
        ({ data } = await axios.post(
            `${QOREID_BASE_URL}/v1/sessions`,
            {
                ...sessionSpec,
                reference,
                subjectRef,
                ttlSeconds,
                maxAttempts,
            },
            {
                headers: {
                    Authorization: authorization,
                    'Content-Type': 'application/json',
                    // Dedupe retries of the same attempt into one vendor session.
                    'Idempotency-Key': reference,
                },
            },
        ));
    } catch (err) {
        if (err.response) {
            const { status, data: body } = err.response;
            const message = (body && (body.message || body.error)) || `QoreID request failed (${status})`;
            throw new QoreIdError(message, { status, data: body });
        }
        throw new QoreIdError(`Could not reach QoreID: ${err.message}`);
    }

    return {
        sessionId: data.sessionId,
        sdkSessionToken: data.sdkSessionToken,
        expiresAt: data.expiresAt,
        productCode: data.productCode || sessionSpec.productCode,
        workflowId: data.workflowId || sessionSpec.workflowId,
        raw: data,
        mock: false,
    };
}

module.exports = {
    startNinVerification,
    isEnabled,
    QoreIdError,
};
