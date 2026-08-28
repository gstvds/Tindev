# Tindev → African Dating Platform: Inspection Report & Development Plan

**Source repo:** `gstvds/Tindev` (github.com/gstvds/Tindev) — Rocketseat "Semana OmniStack 8" bootcamp project.
**Stack confirmed:** React (frontend) + React Native (mobile) + Node.js/Express + MongoDB/Mongoose (backend). This matches your stated comfort zone.
**License:** MIT (Copyright 2019 Gustavo da Silva). ✅ Commercial use, modification, rebranding, and closed-sourcing are all permitted. The only real obligation is retaining the MIT license/copyright notice if you redistribute the *original* code (not required for a deployed commercial product/SaaS — only applies if you republish the source). No copyleft, no attribution-in-UI requirement. Low legal risk, but recommend keeping a `THIRD_PARTY_LICENSES.md` noting Tindev's MIT origin for due-diligence hygiene (investors/acquirers sometimes ask).

> **Note on scope:** this document is the original inspection and phase breakdown — the big-picture "what and why." A few specifics below were finalized *after* this was written and are superseded by `technical-build-spec.md`, which is authoritative wherever the two disagree:
> - **Build order:** Trust & Verification (Phase 5 here) actually gets built *before* Discovery & Matching (Phase 3 here) — discovery's filtering logic depends on verification fields existing first. See the technical spec's section 8 for the real order.
> - **Verification model:** not a mandatory gate before browsing. It's phone-first (instant), with NIN + selfie optional and free, unlocking a "NIN-verified only" filter that's reciprocal — see the technical spec's section 4.
> - **KYC vendor:** QoreID, not Smile Identity (mentioned below as an example before the vendor was settled).
> - **Payments:** split by platform — Apple StoreKit on iOS, Paystack on Android/web — not Paystack everywhere.
> - **App name:** SabiPesin, registered as SabiPesin Ltd — not decided yet when this was written.

---

## 1. What This Codebase Actually Is (important expectation-setting)

This is a **minimal 2019 bootcamp teaching project**, not a production dating app skeleton. It demonstrates CRUD + a "like/dislike" concept, nothing more. Concretely:

| Area | Status |
|---|---|
| Frontend (React) | Exists. 2 pages (Login, Main). No swipe gestures — just Like/Dislike buttons on a list. |
| Mobile (React Native) | **Unbuilt.** `App.js` is the untouched React Native "Hello World" boilerplate. Native `android/`/`ios/` project scaffolding exists (some value for later), but zero app code. README itself says "Mobile version is not finished." |
| Backend (Express) | Exists but extremely thin: 4 endpoints, 1 model. |
| Auth | **Not real.** "Login" = typing a GitHub username; backend fetches your public GitHub profile via `api.github.com` and auto-creates a record. There is no password verification, no session, no JWT. |
| Matching | Like/Dislike arrays on a single `Dev` model. Mutual-match detection exists but only does `console.log('Deu match')` — no Match record, no notification, nothing returned to the client. |
| Chat/Realtime | **None at all.** No socket.io, no message model, no chat UI anywhere. |
| Image storage | **None.** Avatar is just whatever URL GitHub already hosts. No upload pipeline. |
| Notifications | None. |
| Location | None. |
| Config/env | **None.** MongoDB Atlas connection string (shared Rocketseat bootcamp cluster credentials) is hardcoded in `server.js`. No `.env`, no dotenv, no config module. |

**Bottom line:** you should treat this as a *very early scaffold* — useful for its Express/Mongoose/CRA/RN project wiring and MIT-clean starting point, but nearly everything product-related needs to be built. Set expectations accordingly versus what the "Tindev" name might imply.

---

## 2. Detailed Findings by Category

**Frontend architecture:** Create React App (react-scripts 3.0.1), React 16.8.6, react-router-dom v5, axios. No state management lib — just `useState`/`useEffect`. `routes.js` → `/` (Login) and `/dev/:id` (Main/swipe list).

**Mobile architecture:** Bare React Native 0.60.4 CLI project (not Expo). No navigation library, no screens, no API layer. Native Android/iOS folders exist and could save setup time, but everything else is greenfield.

**Backend architecture:** Express 4 + Mongoose 5, single `server.js` entrypoint, `routes.js`, `controllers/`, `models/`.

**Database models:** Only `Dev` (name, user, password, bio, avatar, `likes[]`, `dislikes[]` — both self-referencing ObjectId arrays). No `Match`, `Message`, `Photo`, `Report`, `Block`, `Subscription`, `Location` models.

**Authentication:** Broken/fake. `bcrypt.hash(req.body.password, 10)` is called, but the frontend never sends a `password` field, so it hashes `undefined` — dead code. The actual "identity" mechanism is a raw Mongo `_id` placed in the URL and echoed back in a custom `user` request header. **Anyone can impersonate any user** by sending a different ID in that header — no verification whatsoever. `LoginController.js` is entirely commented out.

**API endpoints:**
- `GET /devs` — list candidates (excludes self + already liked/disliked), identity via unauthenticated `user` header
- `POST /devs` — creates profile by pulling public GitHub data (doubles as "signup")
- `POST /devs/:devId/likes`
- `POST /devs/:devId/dislikes`
- `/login` route is commented out entirely

**Matching/swiping:** Frontend is a static list with Like/Dislike buttons — no drag/swipe gesture library despite the "Tinder" premise. Backend detects mutual likes but discards the result (just a `console.log`).

**Chat/realtime:** None — needs to be built entirely from scratch (Socket.IO or similar).

**Image storage:** None — needs a full upload pipeline (multer + cloud storage) built from scratch.

**Notifications:** None — needs push (FCM/APNs) and in-app notification system built from scratch.

**Config/environment variables:** None used anywhere. Hardcoded, shared, publicly-known DB credentials in `server.js` — **must be rotated/removed immediately**, never reused.

**Existing dependencies (all ~2019-era, stale):** `express@4.17`, `mongoose@5.7`, `axios@0.19`, `bcrypt@5`, `cors@2.8` (backend); `react@16.8`, `react-router-dom@5`, `react-scripts@3.0.1` (frontend); `react@16.8`, `react-native@0.60.4` (mobile). All should be upgraded to current majors before real development — several have known CVEs at these versions.

---

## 3. Reuse / Modify / Build New / Remove

**Reuse as-is (structural only):**
- Overall repo layout (`backend/`, `frontend/`, `mobile/` as separate workspaces)
- Express + Mongoose + CORS wiring pattern in `server.js`/`routes.js` (rewritten, but same pattern)
- MVC-ish `controllers/` + `models/` folder convention
- React Router page-based routing pattern in frontend
- Native `android/`/`ios/` scaffolding in `mobile/` (saves initial RN setup time)

**Modify (keep concept, rewrite implementation):**
- `Dev` model → becomes `User`/`Profile` model, hardened and greatly extended
- Like/Dislike logic → becomes `Swipe` + `Match` model with real match persistence
- `server.js` → env-based config, no hardcoded secrets
- Frontend Login/Main pages → real auth screens + real swipe-card UI (needs a gesture/animation library)

**Build entirely new (nothing to reuse):**
- Real authentication (phone/OTP or email+password, JWT/session, refresh tokens)
- Chat/messaging (data model + Socket.IO/WebSocket layer + UI on web and mobile)
- Image upload & storage (multer/S3-compatible or Cloudinary, moderation hooks)
- Push/in-app notifications
- Location-based discovery (geoindexing, distance filters)
- Relationship-intention & compatibility fields + matching algorithm
- Verification (selfie/ID/liveness check) and anti-scam/trust systems
- Reporting/blocking
- Subscriptions/payments (Paystack, given Nigeria focus)
- AI compatibility scoring + conversation-starter generation
- Admin/moderation dashboard
- The entire mobile app (current one is an empty shell)

**Remove/replace outright:**
- Hardcoded MongoDB Atlas connection string in `server.js`
- GitHub-API-based "signup" flow (`DevController.store` fetching `api.github.com`) — irrelevant to a dating app and a privacy/security anti-pattern to boot
- The `user`-header "auth" mechanism — replace with real token-based auth before anything else is built on top of it
- `LoginController.js` dead/commented code
- `TODO` file's stale note (superseded by this plan)
- Stale 2019-era dependency versions across all three packages

---

## 4. Security Issues & Technical Debt (flag before building)

1. **Critical — No real authentication.** Identity is a spoofable header. This must be fixed in Phase 1 before any other feature is layered on.
2. **Critical — Hardcoded, shared DB credentials committed to source.** Rotate immediately; never reuse; move all secrets to environment variables + secret manager for production.
3. **High — `backend/node_modules` is committed to git** (no `.gitignore` in `backend/`). Bloats repo, and vendored dependencies can mask supply-chain drift. Add `.gitignore` and purge from history.
4. **High — Passwords mishandled.** `bcrypt.hash` is called on a field that's never actually sent; no real credential storage exists yet.
5. **Medium — No input validation/sanitization** anywhere in controllers (no schema validation, e.g. Joi/Zod/express-validator).
6. **Medium — No rate limiting, no helmet-style HTTP hardening, no HTTPS enforcement** in `server.js`.
7. **Medium — Outdated dependencies** with likely known CVEs (react-scripts 3.0.1, mongoose 5.7, express 4.17, axios 0.19, RN 0.60.4).
8. **Low — No tests anywhere** (backend, frontend, or mobile) beyond RN's default boilerplate test.
9. **Low — No CI/CD, linting config, or environment separation** (dev/staging/prod).

None of this is unusual for a bootcamp teaching repo — but all of it needs to be addressed before it's a commercial product handling real user data, payments, and sensitive verification info (which raises NDPR — Nigeria Data Protection Act — considerations given your Nigeria launch).

---

## 5. Development Plan

### PHASE 1 — Foundation
- **Files likely to change:** `backend/src/server.js`, `backend/src/routes.js`, `backend/package.json`, add `.gitignore` (backend currently has none)
- **New files:** `.env.example`, `backend/src/config/database.js`, `backend/src/config/env.js`, `backend/src/middlewares/auth.js`, `backend/src/middlewares/errorHandler.js`, `backend/src/utils/jwt.js`, CI config (GitHub Actions)
- **Database changes:** New MongoDB Atlas project/cluster (own, not the shared bootcamp one); connection via env var
- **API changes:** Remove GitHub-based signup; add `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/otp` (phone verification)
- **Frontend changes:** Replace Login page with real registration/login flow; add auth context/token storage
- **Dependencies:** `dotenv`, `jsonwebtoken`, `express-validator` or `zod`, `helmet`, `express-rate-limit`; upgrade `mongoose`, `express`, `bcrypt` to current majors
- **Risks:** Getting auth model wrong here is expensive to fix later — invest real time in this phase
- **Testing:** Unit tests for auth controllers/middleware; integration test for register→login→protected-route flow

### PHASE 2 — User Profiles
- **Files likely to change:** replace `models/Dev.js` with `models/User.js`
- **New files:** `models/Profile.js` (or embedded schema), `controllers/ProfileController.js`, `routes/profile.js`, validation schemas
- **Database changes:** Fields for name, DOB/age, gender, relationship intentions, bio, interests, education/work, ethnicity/tribe (optional, sensitive — handle carefully), location (GeoJSON point), photos array, verification status
- **API changes:** `GET/PUT /profile`, `GET /profile/:id`, `POST /profile/photos`
- **Frontend changes:** Profile creation/edit wizard (multi-step), photo upload UI
- **Dependencies:** `multer`, cloud storage SDK (see Phase 5/general — Cloudinary or S3-compatible)
- **Risks:** Sensitive personal fields (tribe/ethnicity, religion) — make optional and clearly govern under NDPR-style consent
- **Testing:** Profile CRUD tests; photo upload validation (size/type limits)

### PHASE 3 — Discovery & Matching
- **Files likely to change:** replace `controllers/LikeController.js`, `controllers/DislikeController.js`
- **New files:** `models/Swipe.js`, `models/Match.js`, `controllers/DiscoveryController.js`, `controllers/MatchController.js`, matching-score utility
- **Database changes:** 2dsphere geo index on location; `Swipe` collection (actor, target, action, timestamp); `Match` collection (userA, userB, matchedAt)
- **API changes:** `GET /discovery` (filtered, paginated, distance-aware), `POST /swipes`, `GET /matches`
- **Frontend changes:** Real swipeable card deck (web + mobile)
- **Dependencies:** `react-tinder-card` or similar for web; `react-native-deck-swiper` or Reanimated-based gesture handling for mobile
- **Risks:** Query performance at scale (geo + exclusion filters) — index early
- **Testing:** Match-creation logic tests (mutual like → match); discovery filter tests

### PHASE 4 — Messaging
- **New files:** `models/Message.js`, `models/Conversation.js`, `sockets/chatSocket.js`, `controllers/MessageController.js`
- **Database changes:** `Conversation` + `Message` collections, indexed by conversation/participants
- **API changes:** `GET /conversations`, `GET /conversations/:id/messages`, WebSocket events (`message:send`, `message:receive`, `typing`, `read`)
- **Frontend changes:** Chat UI (web + mobile), unread badges, typing indicators
- **Dependencies:** `socket.io` + `socket.io-client`
- **Risks:** Realtime scaling (sticky sessions or Redis adapter if you horizontally scale); message abuse/spam needs Phase 5 hooks
- **Testing:** Socket connection/auth tests; message delivery/ordering tests

### PHASE 5 — Trust & Verification
- **New files:** `models/Report.js`, `models/Block.js`, `models/Verification.js`, `controllers/TrustController.js`, verification provider integration module
- **Database changes:** Report/Block/Verification collections; verification status field on Profile
- **API changes:** `POST /reports`, `POST /blocks`, `POST /verification/selfie`, `GET /verification/status`
- **Frontend changes:** Report/block UI, verification flow (selfie + liveness prompt), verified badge display
- **Dependencies:** QoreID (or similar KYC vendor) for ID/selfie verification, image moderation API for photo screening
- **Risks:** This is your core anti-scam differentiator — budget real time and possibly a paid verification vendor; false-positive/negative handling needs care
- **Testing:** Verification flow end-to-end; report/block enforcement tests (blocked users can't message/match)

### PHASE 6 — Payments & Premium
- **New files:** `models/Subscription.js`, `controllers/PaymentController.js`, `services/paystack.js`, webhook handler
- **Database changes:** Subscription/plan/entitlement fields on User
- **API changes:** `POST /payments/initialize`, `POST /payments/webhook`, `GET /subscriptions/me`, entitlement-gated endpoints (boosts, super-likes, see-who-liked-you)
- **Frontend changes:** Pricing/paywall screens, premium feature gating
- **Dependencies:** Paystack Node SDK (Nigeria-first payment rails — cards, bank transfer, USSD)
- **Risks:** Webhook signature verification is critical (don't trust client-reported payment success); handle currency (NGN) correctly
- **Testing:** Payment flow with Paystack test mode; webhook idempotency tests

### PHASE 7 — AI Features
- **New files:** `services/aiCompatibility.js`, `services/conversationStarters.js`, `controllers/AIController.js`
- **Database changes:** Compatibility score cache field on Match, optional embedding storage
- **API changes:** `GET /matches/:id/compatibility`, `GET /matches/:id/icebreakers`
- **Frontend changes:** Compatibility indicator on match/profile cards, suggested-opener UI in chat
- **Dependencies:** Anthropic API (Claude) via `@anthropic-ai/sdk` for compatibility summaries/icebreakers
- **Risks:** Cost control (cache results, don't call the API on every screen render); keep AI suggestions optional/skippable, not manipulative
- **Testing:** Prompt/response contract tests; fallback behavior when AI service is unavailable

### PHASE 8 — Admin & Moderation
- **New files:** separate `admin/` frontend app or protected admin routes, `controllers/AdminController.js`, `middlewares/adminAuth.js`
- **Database changes:** Admin role field on User; audit log collection
- **API changes:** `GET /admin/reports`, `PUT /admin/users/:id/suspend`, `GET /admin/metrics`
- **Frontend changes:** Admin dashboard (queue for reports/verifications, user management)
- **Dependencies:** Possibly a lightweight admin UI kit if not hand-rolled
- **Risks:** Admin auth must be fully separate/hardened from user auth
- **Testing:** RBAC tests (non-admins can't hit admin routes)

### PHASE 9 — Testing
- **Files likely to change:** all controllers/services get accompanying tests
- **New files:** `jest.config.js` (backend + frontend), `__tests__/` suites, e2e test setup (Playwright/Detox for mobile)
- **Dependencies:** `jest`, `supertest`, `@testing-library/react`, `detox` (RN e2e)
- **Risks:** Retrofitting tests late is slower — start test scaffolding in Phase 1, not deferred entirely to Phase 9
- **Testing requirements:** Target meaningful coverage on auth, payments, matching, and trust/safety logic specifically (highest-consequence code paths)

### PHASE 10 — Production Deployment
- **New files:** Dockerfiles, `docker-compose.yml`, CI/CD pipeline configs, infra-as-code (if used)
- **Database changes:** Production Atlas cluster with proper backups, IP allowlisting, least-privilege DB users
- **API changes:** Production env config, CDN for static assets/images
- **Frontend changes:** Production build pipeline, environment-specific config
- **Dependencies:** Hosting (e.g., Render/Railway/AWS), CDN, monitoring (Sentry), logging
- **Risks:** NDPR (Nigeria Data Protection Act) compliance for storing user PII/verification data locally or with a compliant processor; app store review requirements for dating apps (Apple/Google have specific policies here)
- **Testing:** Load testing on discovery/chat endpoints; security review/pen-test before public launch

---

## Immediate Next Steps (no code changes yet, per your instructions)
1. ~~Confirm this is the correct source repo~~ — done, confirmed `gstvds/Tindev`.
2. ~~Fork it into your own GitHub org/account~~ — done, `larrydenor/sabipesin-app`, cloned locally.
3. Rotate away from the hardcoded DB credentials before anything else touches this codebase — **still pending**, do this as the first real change once Claude Code starts on Phase 1.
4. ~~Decide on your verification vendor and payment setup~~ — done: QoreID for verification, Paystack (Android/web) + Apple StoreKit (iOS) for payments.
