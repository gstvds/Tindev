const express = require('express');
const multer = require('multer');

const AuthController = require('./controllers/AuthController');
const ProfileController = require('./controllers/ProfileController');
const SwipeController = require('./controllers/SwipeController');
const DiscoveryController = require('./controllers/DiscoveryController');
const MatchController = require('./controllers/MatchController');
const ConversationController = require('./controllers/ConversationController');
const VerificationController = require('./controllers/VerificationController');
const SubscriptionController = require('./controllers/SubscriptionController');
const PurchasesController = require('./controllers/PurchasesController');
const PaymentsController = require('./controllers/PaymentsController');
const SafetyController = require('./controllers/SafetyController');
const AccountController = require('./controllers/AccountController');
const authMiddleware = require('./middlewares/auth');
const asyncHandler = require('./utils/asyncHandler');

const routes = express.Router();

// Photo uploads: keep the file in memory (buffer) so the controller can stream
// it straight to Cloudinary without a temp file. Reject non-images up front and
// cap size; multer raises MulterError, mapped to 400 by the central handler.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter(req, file, cb) {
        if (file.mimetype.startsWith('image/')) {
            return cb(null, true);
        }
        return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo'));
    },
});

// Every async handler/middleware is wrapped with asyncHandler so a throw or
// rejection is routed to the central error handler instead of crashing the
// process (Express 4 does not catch async rejections on its own).
const auth = asyncHandler(authMiddleware);

// Phone OTP auth (spec §6).
routes.post('/auth/otp/request', asyncHandler(AuthController.requestOtp));
routes.post('/auth/otp/verify', asyncHandler(AuthController.verifyOtp));

// Refresh token rotation. Deliberately NOT behind `auth` — the caller has no
// valid access token by definition; the refresh token in the body is the
// credential this route checks instead.
routes.post('/auth/refresh', asyncHandler(AuthController.refreshTokens));

// NIN + selfie verification (spec §6, §4.2). Authenticated. Starts a QoreID KYC
// session and records a pending nin_selfie Verification; returns the SDK session
// token the client uses to run the on-device NIN lookup + selfie capture. The
// vendor webhook that sets ninVerifiedAt is a later slice of Phase 5.
routes.post('/verification/nin/start', auth, asyncHandler(VerificationController.startNin));

// Verification status (spec §6). Authenticated, read-only: returns the caller's
// phone/NIN verification timestamps, the derived verificationTier, and any
// in-flight NIN verification's status + expiry. No QoreID call.
routes.get('/verification/status', auth, asyncHandler(VerificationController.getStatus));

// Profile CRUD (spec §6). Authenticated; a user only ever reads/writes their
// own profile. Photo upload and discovery-settings are separate endpoints.
routes.get('/profile/me', auth, asyncHandler(ProfileController.getMe));
routes.put('/profile/me', auth, asyncHandler(ProfileController.updateMe));

// Photo upload/delete (spec §6). Multipart field name: "photo".
routes.post('/profile/photos', auth, upload.single('photo'), asyncHandler(ProfileController.uploadPhoto));
routes.delete('/profile/photos/:photoId', auth, asyncHandler(ProfileController.deletePhoto));

// Discovery settings (spec §6). Enforces the NIN reciprocity rule (§4.5) — the
// one write path allowed to set showOnlyNinVerified.
routes.put('/profile/discovery-settings', auth, asyncHandler(ProfileController.updateDiscoverySettings));

// Swipe + match creation (spec §6). Records a swipe and forms a Match on a mutual
// like/superlike.
routes.post('/swipes', auth, asyncHandler(SwipeController.createSwipe));

// Discovery (spec §6, §4.6). Paginated candidate profiles: excludes self and
// already-swiped users, applies the NIN/phone verification filter and geo-distance.
routes.get('/discovery', auth, asyncHandler(DiscoveryController.getDiscovery));

// Match listing + detail (spec §6). The requester's active matches, and a single
// match by id. Both include the other participant's derived verificationTier
// (§4.7 — never hidden); the detail route 404s for a missing or foreign match.
routes.get('/matches', auth, asyncHandler(MatchController.listMatches));
routes.get('/matches/:id', auth, asyncHandler(MatchController.getMatch));

// Messaging read layer (spec §6). Lists the requester's conversations and, for a
// single conversation they participate in, its paginated messages. Socket.IO and
// the anti-scam keyword flagging (spec §8.5) arrive in a later slice of Phase 5.
routes.get('/conversations', auth, asyncHandler(ConversationController.listConversations));
routes.get('/conversations/:id/messages', auth, asyncHandler(ConversationController.listMessages));

// Get-or-create the conversation for a match the requester is part of (spec §6).
// The Match forms on a mutual like; its Conversation is created lazily here, on
// first chat open. Idempotent (unique matchId) and participant-scoped — a foreign
// or missing match id 404s indistinguishably, same posture as GET /matches/:id.
routes.post('/matches/:id/conversation', auth, asyncHandler(ConversationController.getOrCreateConversation));

// Subscription read layer (spec §6, §7). Authenticated, read-only: returns the
// caller's current plan + status, defaulting to the free plan when there's no
// Subscription row yet. Makes no payment call. Paystack/StoreKit init, verify,
// and the signature-verified webhooks are later slices of Phase 6.
routes.get('/subscriptions/me', auth, asyncHandler(SubscriptionController.getMe));

// Paystack subscription init (spec §6, §5, §7). Authenticated, Android/web path.
// Initializes a Paystack transaction for the "Unlimited" plan and returns the
// authorization_url the client redirects to. Writes no Subscription row — the
// plan is activated only by the signature-verified Paystack webhook (later slice).
routes.post('/subscriptions/subscribe/paystack', auth, asyncHandler(SubscriptionController.subscribeWithPaystack));

// One-off purchase init — Paystack, Android/web path (spec §6, §5, §7).
// Authenticated. Each initializes a one-off Paystack transaction, persists a
// PENDING Transaction row keyed by our reference, and returns the authorization_url
// the client redirects to. They grant nothing here — the purchase is settled to
// `success` only by the signature-verified Paystack webhook below. (iOS
// StoreKit verify counterparts, §6, are a later slice.)
routes.post('/purchases/boost/paystack', auth, asyncHandler(PurchasesController.boostWithPaystack));
routes.post('/purchases/superlike/paystack', auth, asyncHandler(PurchasesController.superlikeWithPaystack));

// Paystack webhook (spec §5, §6, §7). Deliberately NOT behind `auth` — Paystack
// calls this server-to-server, so there's no JWT. Trust is established inside the
// handler by verifying the HMAC-SHA512 `x-paystack-signature` over the raw body
// (captured in server.js); an unsigned/forged request gets 401. On a genuine
// charge.success it either activates a paid Subscription or settles a one-off
// Transaction (boost/super like) — routing on the metadata `type` — and it's
// idempotent on the charge reference so Paystack's retries don't double-apply.
routes.post('/payments/webhook/paystack', asyncHandler(PaymentsController.paystackWebhook));

// Safety: report + block (App Store Guideline 1.2 / spec safety). Authenticated.
// `/users/blocked` is registered before the parameterized `/users/:id/*` routes so
// the literal path can never be shadowed by an `:id` match. Report is a pure audit
// record with no matching/discovery/messaging side effects; Block is idempotent
// (a repeat block is treated as success) and its effect on discovery/matches/
// conversations/messaging is wired in a later slice.
routes.get('/users/blocked', auth, asyncHandler(SafetyController.listBlocked));
routes.post('/users/:id/report', auth, asyncHandler(SafetyController.reportUser));
routes.post('/users/:id/block', auth, asyncHandler(SafetyController.blockUser));
routes.delete('/users/:id/block', auth, asyncHandler(SafetyController.unblockUser));

// Account deletion (App Store Guideline 5.1.1(v)). Authenticated; deletes ONLY the
// caller's own account (the target is always req.userId — no admin/other-user path).
// Hard-deletes the caller's User/Profile/Swipe docs and Cloudinary photos; the
// shared Match/Conversation/Message docs are deliberately kept for the other party's
// audit trail (that side soft-excludes the deleted user via utils/accounts.js).
routes.delete('/account', auth, asyncHandler(AccountController.deleteAccount));

// Optional receipt-delivery email (App Store guidance: any personal-info
// request must be optional and never block app use). Self-only — the target
// is always req.userId, same as DELETE /account above. Never verified, never
// used for login/OTP/recovery (auth stays phone-only); stored on User and
// read back by the Paystack subscribe/purchase paths once chunk 2 wires it in.
routes.get('/account/email', auth, asyncHandler(AccountController.getEmail));
routes.put('/account/email', auth, asyncHandler(AccountController.updateEmail));

module.exports = routes;
