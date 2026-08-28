const crypto = require('crypto');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const Verification = require('../models/Verification');
const termii = require('../services/termii');
const { issueTokens } = require('../utils/jwt');

const PROVIDER = 'termii';

// --- OTP policy -------------------------------------------------------------
const CODE_LENGTH = 6;
const BCRYPT_ROUNDS = 10;
const OTP_TTL_MS = 10 * 60 * 1000;          // code valid for 10 minutes
const MAX_VERIFY_ATTEMPTS = 5;              // wrong tries before a code is killed
const RESEND_COOLDOWN_MS = 60 * 1000;       // min gap between requests to a number
const REQUEST_WINDOW_MS = 60 * 60 * 1000;   // rolling window for the request cap
const MAX_REQUESTS_PER_WINDOW = 5;          // max OTP requests per number per hour

// Cryptographically secure 6-digit code. crypto.randomInt is uniform and
// unpredictable (never Math.random); padStart keeps leading-zero codes valid.
function generateCode() {
    const max = 10 ** CODE_LENGTH;
    return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

// Normalize a Nigerian phone number to Termii's expected international format:
// digits only, no leading '+', country code 234. Accepts common local inputs:
//   08012345678      -> 2348012345678
//   +2348012345678   -> 2348012345678
//   234 801 234 5678 -> 2348012345678
// Returns null if the input can't be coerced into a plausible NG number.
function normalizePhone(input) {
    if (!input || typeof input !== 'string') return null;

    let digits = input.replace(/[^\d]/g, '');

    if (digits.startsWith('0')) {
        digits = `234${digits.slice(1)}`;
    } else if (digits.startsWith('234')) {
        // already in international form
    } else if (digits.length === 10) {
        // bare subscriber number without the leading 0
        digits = `234${digits}`;
    } else {
        return null;
    }

    // 234 + 10-digit subscriber number
    if (!/^234\d{10}$/.test(digits)) return null;

    return digits;
}

// POST /auth/otp/request  { phone }
// Rate-limits, generates a secure code, delivers it via Termii SMS, and stores
// only its bcrypt hash in a pending Verification. The User is created here (as a
// shell with phoneVerifiedAt === null) so the Verification's required userId
// exists; phoneVerifiedAt is only set once the code is confirmed.
async function requestOtp(req, res) {
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
        return res.status(400).json({ error: 'A valid Nigerian phone number is required' });
    }

    let user = await User.findOne({ phone });
    if (!user) {
        user = await User.create({ phone });
    }

    // Rate limiting (per phone): a short resend cooldown plus a rolling hourly
    // cap, so a number can't be spammed with OTP SMS (which also costs money).
    const now = Date.now();
    const windowStart = new Date(now - REQUEST_WINDOW_MS);

    const recentCount = await Verification.countDocuments({
        userId: user._id,
        type: 'phone_otp',
        createdAt: { $gte: windowStart },
    });
    if (recentCount >= MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({ error: 'Too many verification requests, please try again later' });
    }

    const latest = await Verification.findOne({ userId: user._id, type: 'phone_otp' })
        .sort({ createdAt: -1 });
    if (latest) {
        const elapsed = now - latest.createdAt.getTime();
        if (elapsed < RESEND_COOLDOWN_MS) {
            const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                error: `Please wait ${retryAfter}s before requesting another code`,
            });
        }
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);

    // A TermiiError here propagates to the central error handler (-> 502); the
    // throw also stops execution, so no Verification is recorded on a failed send.
    const message = `Your SabiPesin verification code is ${code}. It expires in ${OTP_TTL_MS / 60000} minutes.`;
    const { messageId } = await termii.sendSms(phone, message);

    // Only one code is live at a time: supersede any earlier pending codes so an
    // older SMS can't also be used to verify.
    await Verification.updateMany(
        { userId: user._id, type: 'phone_otp', status: 'pending' },
        { status: 'failed' }
    );

    await Verification.create({
        userId: user._id,
        type: 'phone_otp',
        status: 'pending',
        provider: PROVIDER,
        providerRef: messageId,
        codeHash,
        expiresAt: new Date(now + OTP_TTL_MS),
        attempts: 0,
    });

    return res.json({ message: 'Verification code sent', phone });
}

// POST /auth/otp/verify  { phone, code }  -> { accessToken, refreshToken }
// Verifies the code against the latest pending OTP for this phone. Enforces
// expiry and a max-attempts cap. On success: marks the Verification verified,
// stamps user.phoneVerifiedAt, and issues access + refresh tokens (spec §6).
async function verifyOtp(req, res) {
    const phone = normalizePhone(req.body.phone);
    const { code } = req.body;

    if (!phone) {
        return res.status(400).json({ error: 'A valid Nigerian phone number is required' });
    }
    if (!code) {
        return res.status(400).json({ error: 'A verification code is required' });
    }

    const user = await User.findOne({ phone });
    if (!user) {
        return res.status(400).json({ error: 'No verification was requested for this number' });
    }

    // codeHash is select:false — ask for it explicitly here.
    const verification = await Verification.findOne({
        userId: user._id,
        type: 'phone_otp',
        status: 'pending',
    }).sort({ createdAt: -1 }).select('+codeHash');

    if (!verification) {
        return res.status(400).json({ error: 'No pending verification found, request a new code' });
    }

    if (verification.expiresAt && verification.expiresAt.getTime() < Date.now()) {
        verification.status = 'failed';
        await verification.save();
        return res.status(400).json({ error: 'This code has expired, request a new one' });
    }

    const match = await bcrypt.compare(String(code), verification.codeHash || '');
    if (!match) {
        verification.attempts += 1;
        // Kill the code once the attempt cap is reached so it can't be brute-forced.
        if (verification.attempts >= MAX_VERIFY_ATTEMPTS) {
            verification.status = 'failed';
        }
        await verification.save();

        const attemptsLeft = Math.max(0, MAX_VERIFY_ATTEMPTS - verification.attempts);
        const error = attemptsLeft === 0
            ? 'Invalid code — too many attempts, request a new one'
            : 'Invalid verification code';
        return res.status(400).json({ error, attemptsLeft });
    }

    verification.status = 'verified';
    verification.verifiedAt = new Date();
    await verification.save();

    if (!user.phoneVerifiedAt) {
        user.phoneVerifiedAt = verification.verifiedAt;
        await user.save();
    }

    const { accessToken, refreshToken } = issueTokens(user);

    return res.json({
        message: 'Phone verified',
        phone,
        verificationTier: user.verificationTier,
        accessToken,
        refreshToken,
    });
}

module.exports = {
    requestOtp,
    verifyOtp,
    normalizePhone,
    generateCode,
};
