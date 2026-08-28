# Technical Build Spec — SabiPesin

This is a hand-off document for Claude Code. It translates everything decided during product/strategy planning into concrete data models, API routes, and business logic. Where the phase plan (`tindev-to-african-dating-app-plan.md`) says *what* to build and *why*, this document says *exactly how* — field names, endpoint shapes, and the rules that govern them.

**Starting point:** fork of `gstvds/Tindev` (MIT-licensed, Express + Mongoose + React + React Native). Treat it as a skeleton for folder structure and conventions only — almost none of its actual logic survives (see "What to remove," below).

---

## 0. Before Claude Code touches the repo

- **Name is locked: SabiPesin, registered as SabiPesin Ltd.** Domain (sabipesin.com) secured, no conflicts found on the App Store or Google Play. Nigeria Trademarks Registry search and social handle checks still worth doing before public launch, but nothing here blocks the build starting.
- Fork Tindev into your own GitHub org, under the SabiPesin org/account.
- Provision a MongoDB Atlas cluster under SabiPesin Ltd. Never reuse the credentials hardcoded in the original `server.js` — they belong to a shared bootcamp cluster.
- Open accounts under SabiPesin Ltd (approval takes real calendar time, start these in parallel with coding):
  - Paystack (business/KYB verification required before live payments)
  - QoreID for NIN/selfie verification — already in use elsewhere, sandbox access available; open the fresh production account now that CAC registration is underway
  - Termii for SMS OTP — workspace "SabiPesin Ltd" created, API key generated (switched from Africa's Talking after a lengthy account-approval appointment delay; Termii's sandbox/live send worked without that gate)
  - Cloudinary for photo storage — already in use elsewhere; open the fresh account under SabiPesin Ltd
- Native app, launching on both the App Store and Google Play — decided, no longer PWA-first. This means `mobile/` (currently untouched React Native boilerplate in Tindev) gets built out from Phase 1 onward, not deferred.

---

## 1. Environment variables

```
MONGODB_URI=
JWT_SECRET=
JWT_REFRESH_SECRET=
PORT=3333
NODE_ENV=development

# SMS OTP (phone verification)
OTP_PROVIDER=termii
TERMII_API_KEY=

# NIN/selfie verification vendor
KYC_PROVIDER=qoreid
QOREID_CLIENT_ID=
QOREID_SECRET=
QOREID_WEBHOOK_SECRET=

# Photo storage
CLOUDINARY_URL=

# Payments
PAYSTACK_SECRET_KEY=
PAYSTACK_PUBLIC_KEY=
PAYSTACK_WEBHOOK_SECRET=
```

No secrets in source, ever. `.env.example` should mirror this file with blank values.

---

## 2. What to remove from Tindev before building anything new

- Hardcoded MongoDB Atlas connection string in `server.js`
- `DevController.store`'s GitHub-API-based "signup" (fetches `api.github.com`) — irrelevant and a privacy anti-pattern
- The `user`-header "auth" mechanism in `LikeController`/`DislikeController` — spoofable, replace entirely with JWT middleware
- `LoginController.js` (dead/commented code)
- Committed `backend/node_modules` — add `.gitignore`, purge from git history
- `Dev.js` model — replaced by `User` + `Profile` below

---

## 3. Data models (Mongoose)

### User
```js
{
  phone: { type: String, required: true, unique: true, index: true },
  phoneVerifiedAt: { type: Date, default: null },
  ninVerifiedAt: { type: Date, default: null },
  ninVerificationRef: { type: String, default: null }, // vendor's reference ID
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
  createdAt: Date,
  updatedAt: Date
}
```
`verificationTier` is not stored — derive it at read time: `ninVerifiedAt ? 'nin' : (phoneVerifiedAt ? 'phone' : null)`.

### Profile
```js
{
  userId: { type: ObjectId, ref: 'User', required: true, unique: true, index: true },
  name: String,
  dob: Date,
  gender: String,
  lookingFor: { type: String, enum: ['casual', 'serious', 'marriage', 'friendship'] },
  bio: String,
  interests: [String],
  tribe: String,       // optional, sensitive — never required
  religion: String,    // optional, sensitive — never required
  state: String,
  lga: String,
  location: { type: { type: String, default: 'Point' }, coordinates: [Number] }, // 2dsphere index
  photos: [{ url: String, isPrimary: Boolean }],
  prompts: [{ question: String, answer: String }],
  discoverySettings: {
    showOnlyNinVerified: { type: Boolean, default: false },
    maxDistanceKm: { type: Number, default: 25 },
    ageRange: { min: Number, max: Number }
  },
  createdAt: Date,
  updatedAt: Date
}
```
Index: `location` as `2dsphere`.

### Swipe
```js
{
  actorId: { type: ObjectId, ref: 'User', required: true },
  targetId: { type: ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['like', 'pass', 'superlike'], required: true },
  createdAt: Date
}
```
Compound unique index: `(actorId, targetId)`.

### Match
```js
{
  userA: { type: ObjectId, ref: 'User', required: true },
  userB: { type: ObjectId, ref: 'User', required: true },
  matchedAt: Date,
  status: { type: String, enum: ['active', 'unmatched'], default: 'active' }
}
```
Compound unique index on the sorted pair `(userA, userB)`.

### Conversation
```js
{
  matchId: { type: ObjectId, ref: 'Match', required: true, unique: true },
  participants: [{ type: ObjectId, ref: 'User' }],
  lastMessageAt: Date,
  createdAt: Date
}
```

### Message
```js
{
  conversationId: { type: ObjectId, ref: 'Conversation', required: true, index: true },
  senderId: { type: ObjectId, ref: 'User', required: true },
  text: String,
  flagged: { type: Boolean, default: false }, // set true if anti-scam keyword filter trips
  createdAt: Date,
  readAt: Date
}
```

### Verification
```js
{
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['phone_otp', 'nin_selfie'], required: true },
  status: { type: String, enum: ['pending', 'verified', 'failed'], default: 'pending' },
  provider: String,
  providerRef: String,
  verifiedAt: Date,
  createdAt: Date
}
```

### Report
```js
{
  reporterId: { type: ObjectId, ref: 'User', required: true },
  reportedUserId: { type: ObjectId, ref: 'User', required: true },
  reason: { type: String, enum: ['fake_profile', 'scam_attempt', 'harassment', 'inappropriate_content', 'other'] },
  details: String,
  status: { type: String, enum: ['open', 'reviewed', 'actioned'], default: 'open' },
  createdAt: Date
}
```

### Block
```js
{
  blockerId: { type: ObjectId, ref: 'User', required: true },
  blockedId: { type: ObjectId, ref: 'User', required: true },
  createdAt: Date
}
```
Compound unique index: `(blockerId, blockedId)`.

### Subscription
```js
{
  userId: { type: ObjectId, ref: 'User', required: true, unique: true },
  plan: { type: String, enum: ['free', 'unlimited'], default: 'free' },
  status: { type: String, enum: ['active', 'cancelled', 'expired'], default: 'active' },
  paymentPlatform: { type: String, enum: ['ios_iap', 'paystack'] },
  paystackSubscriptionCode: String,   // Android/web only
  iosOriginalTransactionId: String,   // iOS only
  currentPeriodEnd: Date,
  createdAt: Date
}
```

### Transaction (one-off purchases)
```js
{
  userId: { type: ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['boost', 'superlike'], required: true },
  paymentPlatform: { type: String, enum: ['ios_iap', 'paystack'] },
  amountKobo: Number,               // Paystack path
  paystackReference: { type: String, unique: true, sparse: true },
  iosTransactionId: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  createdAt: Date
}
```

---

## 4. Verification & trust logic — the core rules

This is the part that took the most back-and-forth in planning, so it's spelled out explicitly:

1. **Signup requires phone + OTP only.** On successful OTP confirmation, set `user.phoneVerifiedAt`. This is the *only* requirement to browse, swipe, match, and chat. No wall before this point.
2. **NIN + selfie verification is optional and always free**, available any time from the profile/settings screen. On success (selfie matched against NIN photo via the KYC vendor), set `user.ninVerifiedAt`.
3. **Badge display:** every profile card and match/chat screen shows `✓ Phone Verified` if only `phoneVerifiedAt` is set, or `✓✓ NIN Verified` if `ninVerifiedAt` is also set. Never hidden.
4. **Discovery default (`showOnlyNinVerified = false`):** a user sees everyone with at least `phoneVerifiedAt` set, regardless of their own verification tier.
5. **The reciprocity rule (server-enforced, not just UI):** `PUT /profile/discovery-settings` with `showOnlyNinVerified: true` must check the *requesting* user's own `ninVerifiedAt`. If it's null, return `403` with a specific error code (`NIN_REQUIRED`) instead of persisting the setting — the frontend routes this response straight into the NIN verification flow. The setting can only actually be saved as `true` once the user is NIN-verified themselves.
6. **Discovery query respects the filter:** `GET /discovery` — if the requester's `discoverySettings.showOnlyNinVerified` is `true`, filter candidates to `ninVerifiedAt: { $ne: null }`. Otherwise, only exclude users with no `phoneVerifiedAt` at all (incomplete signups never appear).
7. **Match reveal includes both tiers, always.** The match/chat payload includes each participant's derived `verificationTier` — this is never omitted or softened.

---

## 5. Monetization logic — the exact rule

**Always free, for every user, regardless of verification tier:** phone verification, NIN verification, profile creation, 10 swipes per rolling 24h window, matching, and messaging once matched.

**Paid, decoupled from verification status — available to phone-only and NIN-verified users alike:**
- `Subscription` (single "Unlimited" plan, naira): unlimited swipes past the daily 10, "see who liked you," advanced filters (tribe/religion/intent).
- One-off `Transaction`s: profile boost (time-boxed visibility increase, e.g. 3 hours), super like.

**Platform-specific payment routing — this is non-negotiable, not a preference:** Apple requires all digital subscriptions and in-app purchases on iOS to go through StoreKit, not a third-party processor. A direct Paystack checkout for the subscription or boosts on iOS risks App Store rejection.
- **iOS:** subscription and one-off purchases go through StoreKit 2 (Apple IAP). Apple takes its commission (standard rate, reduced to 15% under the App Store Small Business Program for developers earning under $1M/year). The backend still needs a `Subscription`/`Transaction` record, but it's reconciled via Apple's server-to-server notifications, not a Paystack webhook.
- **Android and any web/PWA presence:** Paystack works directly, no restriction.
- Practical implication: the `Subscription` and `Transaction` models need a `paymentPlatform` field (`'ios_iap' | 'paystack'`) and platform-specific webhook/notification handlers, rather than a single Paystack-only path as originally scoped.

**Enforcement:** the swipe endpoint checks a rolling 24h swipe count per user unless `Subscription.status === 'active'`, in which case the cap is skipped. Verification tier has no bearing on this check anywhere in the codebase — if it does, that's a bug against this spec.

**Payment flow:** for the Paystack path, the webhook (`POST /payments/webhook`) must verify the request signature before trusting any payment-success payload. For the iOS path, Apple's server notifications (App Store Server Notifications v2) must be verified the same way — never trust a client-reported "purchase succeeded" call on either platform.

---

## 6. API routes

### Auth
```
POST   /auth/otp/request        { phone }
POST   /auth/otp/verify         { phone, code }  -> JWT + refresh token, creates User if new
POST   /auth/refresh
POST   /auth/logout
```

### Verification
```
POST   /verification/nin/start           -> kicks off KYC vendor session
POST   /verification/nin/webhook         -> vendor callback (verify signature), sets ninVerifiedAt on success
GET    /verification/status
```

### Profile
```
GET    /profile/me
PUT    /profile/me
POST   /profile/photos                   (multipart -> Cloudinary)
DELETE /profile/photos/:photoId
PUT    /profile/discovery-settings       { showOnlyNinVerified, maxDistanceKm, ageRange } -> enforces reciprocity rule
```

### Discovery & matching
```
GET    /discovery                        paginated, geo + verification-filter aware, excludes already-swiped
POST   /swipes                           { targetId, action } -> creates Match if mutual like
GET    /matches
GET    /matches/:id
```

### Messaging
```
GET    /conversations
GET    /conversations/:id/messages
```
WebSocket events: `message:send`, `message:receive`, `typing`, `read`.

### Trust & safety
```
POST   /reports
POST   /blocks
DELETE /blocks/:id
```

### Payments
```
POST   /subscriptions/subscribe/paystack    -> Paystack subscription init (Android/web)
POST   /subscriptions/subscribe/ios/verify  -> verify a StoreKit receipt, activate Subscription (iOS)
GET    /subscriptions/me
POST   /purchases/boost/paystack
POST   /purchases/boost/ios/verify
POST   /purchases/superlike/paystack
POST   /purchases/superlike/ios/verify
POST   /payments/webhook/paystack           -> Paystack webhook, signature-verified
POST   /payments/webhook/apple              -> App Store Server Notifications v2, signature-verified
```

### Account
```
DELETE /account                             -> required by App Store Guideline 5.1.1(v); anonymize or hard-delete per policy
```

### Admin
```
GET    /admin/reports
PUT    /admin/users/:id/suspend
GET    /admin/metrics
```

---

## 7. App Store compliance — build these in from the start, not after

Confirmed against Apple's 2026 App Review Guidelines. These aren't optional polish — a first submission missing any of these is a likely rejection, and dating apps get closer scrutiny than average.

- **Guideline 3.1.1 — In-App Purchase required for digital content.** Covered above: iOS subscription/boost purchases must use StoreKit 2, not Paystack directly.
- **Guideline 1.2 (UGC/social apps) — trust & safety features are a hard requirement, not a nice-to-have:** a way to filter objectionable content, a report mechanism with a timely response process, the ability to block abusive users, and published contact information (support email/phone visible in the app). The Report and Block models in section 3 satisfy the data layer; make sure the support contact is actually surfaced in-app, not just in a privacy policy.
- **Guideline 5.1.1(v) — account deletion.** Apps that allow account creation must let users delete their account from within the app, not just deactivate it. See `DELETE /account` above.
- **Subscription pricing transparency.** Price, renewal terms, and cancellation method must be visible before purchase, with no scrolling required to see them, and must match the price actually charged (mismatches between App Store Connect metadata and in-app pricing are a common, avoidable rejection reason).
- **Minimum functionality (Guideline 4.2).** The app must use real native features, not just wrap a web view — push notifications, camera access for verification selfies, and native navigation all help satisfy this.
- **Demo access for the reviewer.** Apple's reviewers need a way to test the full flow, including matching and chat, without needing a second real phone number for OTP — plan for a reviewer test account that bypasses OTP/NIN in a controlled way, documented in the App Store Connect review notes.
- **Age rating.** Dating apps are typically rated 17+ on the App Store; factor this into App Store Connect setup in Phase 10.
- **Termii Sender ID isn't required for Phase 1 development** — OTP sends work against a generic number without one. It is required before production launch (so OTPs arrive branded "SabiPesin" and route reliably around DND-registered numbers). Budget real time for this: CraftRanked's own Sender ID took from an early-year application to an August 4th approval — weeks, not the "1-3 business days" the platform advertises. Start this application as early as possible once SabiPesin's CAC documents are ready, well ahead of when it's actually needed for launch.

---

## 8. Recommended build order

Slightly reordered from the original 10-phase plan — verification moves earlier because discovery's query logic (section 4, rule 6) depends on the verification fields existing first.

1. **Foundation** — remove old Tindev auth/signup code, env config, JWT middleware, phone OTP
2. **Profiles** — model, CRUD, photo upload
3. **Verification** — NIN/selfie vendor integration, the reciprocity rule (section 4) end to end
4. **Discovery & Matching** — geo query, swipe, match creation
5. **Messaging** — Socket.IO, conversation/message models, anti-scam keyword flagging
6. **Payments** — Subscription + Transaction models, Paystack integration, webhook verification
7. **AI features** — compatibility scoring, conversation starters
8. **Admin & moderation**
9. **Testing** — prioritize auth, the reciprocity rule, and payment webhook signature verification, since these are the highest-consequence code paths
10. **Production deployment** — including App Store Connect setup, age rating, reviewer demo account, and StoreKit product configuration (section 7)

---

## 9. Open items not yet decided

- StoreKit product IDs and iOS subscription pricing tier (Apple sells subscriptions in fixed price tiers, not arbitrary naira amounts — needs mapping once the final naira price is set)
