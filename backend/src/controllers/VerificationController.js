const crypto = require('crypto');

const Verification = require('../models/Verification');
const qoreid = require('../services/qoreid');

const PROVIDER = 'qoreid';

// POST /verification/nin/start
// Kicks off a QoreID NIN + selfie verification session for the authenticated
// user and records a pending Verification (type: 'nin_selfie', spec §3, §6).
// Returns the session token/id the client hands to the QoreID SDK to run the
// on-device NIN lookup + selfie liveness capture. The result is applied later by
// the webhook (POST /verification/nin/webhook — a separate slice), which is what
// sets user.ninVerifiedAt (spec §4.2). This endpoint never verifies anything on
// its own; it only opens the session.
async function startNin(req, res) {
    // NIN verification is optional and can be started any time (spec §4.2), but
    // there's nothing to do once a user is already NIN-verified.
    if (req.user.ninVerifiedAt) {
        return res.status(409).json({ error: 'You are already NIN verified' });
    }

    // Idempotent reference for this attempt (echoed back by QoreID and useful for
    // reconciling the webhook); subjectRef ties the vendor session to our user.
    const reference = crypto.randomUUID();

    // A QoreIdError here propagates to the central error handler (-> 502); the
    // throw stops execution, so no Verification is recorded on a failed start.
    const session = await qoreid.startNinVerification({
        reference,
        subjectRef: req.userId,
    });

    // Only one session is live at a time: supersede any earlier pending
    // nin_selfie rows so a stale session can't also resolve against this user
    // (mirrors the OTP supersede in AuthController).
    await Verification.updateMany(
        { userId: req.userId, type: 'nin_selfie', status: 'pending' },
        { status: 'failed' }
    );

    await Verification.create({
        userId: req.userId,
        type: 'nin_selfie',
        status: 'pending',
        provider: PROVIDER,
        // providerRef is QoreID's sessionId — the handle the webhook resolves against.
        providerRef: session.sessionId,
        expiresAt: session.expiresAt ? new Date(session.expiresAt) : undefined,
    });

    // Hand the client exactly what it needs to continue: the SDK session token
    // and the session id/expiry. `mock` flags dev-mode (no real vendor call) so
    // the client can short-circuit instead of loading the real SDK.
    return res.status(201).json({
        message: 'NIN verification session started',
        provider: PROVIDER,
        sessionId: session.sessionId,
        sdkSessionToken: session.sdkSessionToken,
        expiresAt: session.expiresAt,
        mock: session.mock,
    });
}

// GET /verification/status
// Read-only snapshot of the authenticated user's verification state (spec §6).
// Returns the two verification timestamps and the derived tier
// (`ninVerifiedAt ? 'nin' : phoneVerifiedAt ? 'phone' : null` — §3, §4.7, the
// User.verificationTier virtual). No QoreID call — this only reads what earlier
// slices (phone OTP verify, the NIN start/webhook) have already persisted.
async function getStatus(req, res) {
    // Surface the in-flight NIN attempt, if any, so the client can show "pending"
    // and when the session lapses. There's at most one live session per user
    // (startNin supersedes older pending rows), but sort by newest to be safe.
    const pending = await Verification.findOne({
        userId: req.userId,
        type: 'nin_selfie',
        status: 'pending',
    })
        .sort({ createdAt: -1 })
        .select('status expiresAt')
        .lean();

    return res.json({
        phoneVerifiedAt: req.user.phoneVerifiedAt,
        ninVerifiedAt: req.user.ninVerifiedAt,
        verificationTier: req.user.verificationTier,
        // null when there's no in-flight NIN verification; otherwise the pending
        // row's status and expiry (spec §6).
        pendingNinVerification: pending
            ? { status: pending.status, expiresAt: pending.expiresAt }
            : null,
    });
}

module.exports = {
    startNin,
    getStatus,
};
