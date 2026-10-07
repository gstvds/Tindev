# SabiPesin — Todo List

A running list of things flagged along the way that aren't blocking right now, but shouldn't be forgotten. Update this as new things come up — check items off as they're resolved rather than deleting them, so there's a record of what's been handled.

---

## Blocking on CAC documents

**Status: CAC documents in hand. Bank account number pending — the one remaining piece before every item below can be actioned.** An admin contact on the investor side is now handling this paperwork directly, rather than it sitting on Larry's plate.

- [ ] **Termii — SabiPesin's own account.** Currently borrowing CraftRanked's Termii API key/Sender ID to prove the OTP flow works. Once CAC docs are in hand:
  - Complete SabiPesin's own Termii KYC (Business Details already filled in, documents not yet uploaded)
  - Activate Nigeria as a destination country on the account
  - Request and get SabiPesin's own Sender ID approved — **budget real time for this.** CraftRanked's own Sender ID took from an early-year application to an August 4th approval (weeks, not the advertised "1–3 business days")
  - Swap `TERMII_API_KEY` in `.env` from CraftRanked's borrowed key to SabiPesin's own
  - Do one final live-SMS test end to end with the real account before calling the OTP piece truly done (not just code-complete)
- [ ] **QoreID — production account.** Blocked pending CAC documents (sandbox already available for testing)
- [ ] **Paystack — business (KYB) verification.** Required before any live payment processing
- [ ] **CAC name registration itself** — confirm "SabiPesin Ltd" is filed and approved
- [ ] **Hand the admin contact a clear list of what needs the CAC document + bank details once ready:** QoreID production account activation, Paystack KYB submission, Termii Sender ID application (budget real time here — CraftRanked's own took from an early-year application to an August 4th approval, weeks not days), and — new, worth adding to their scope — drafting Terms of Service, Privacy Policy, and NDPR-compliant data-processing language with the investor's law firm.

---

## Vendor / account follow-ups

- [ ] **QoreID sandbox not subscribed to NIN + selfie face-match product.** Live-tested against the real sandbox API (credentials confirmed valid — token mint succeeds) but every session-creation attempt for the NIN+selfie flow returns 403 "Not subscribed to this product" or 400 "Unknown productCode." The `30417` collection ID we were given doesn't map to any field QoreID's `/v1/sessions` endpoint accepts. Needs a support ticket to QoreID: (1) get the sandbox account subscribed to the NIN + selfie face-match product, (2) clarify how the `30417` collection ID is meant to be used — likely a dashboard-side product subscription rather than a request field. Code side is done and correct (confirmed against QoreID's own SDK docs) — this is purely an account-provisioning gap on QoreID's end.

- [ ] **Close PR #30** on `gstvds/Tindev` — a pull request opened against the upstream repo by mistake instead of your own fork. Not urgent, just tidy it up.
- [x] **Instagram, TikTok, and Facebook Page** — "SabiPesin" secured on all three (Facebook wasn't even on the original checklist — good catch going beyond it)
- [ ] **Nigeria Trademarks Registry search** for "SabiPesin" — domain, CAC name, app store availability, and social handles are all confirmed clear; trademark is the one check still outstanding
- [ ] **Confirm Instagram/TikTok handles** for "SabiPesin" are free and reserve them

---

- [ ] **Push notifications — not started, needs its own dedicated slice.** Zero push notification code exists yet. Real constraints worth planning around: Expo Go (used for all mobile testing so far) doesn't support remote push at all — testing requires building a proper EAS "development build" and a physical device, not the simulator. iOS needs the Apple Developer account (already planned) to generate push credentials; Android needs a Firebase project (similar to CraftRanked's existing setup). Best sequenced after the remaining core screens (verification, subscriptions, discovery settings) and alongside Phase 10 production readiness, not squeezed into regular feature work.

- [x] **Gender/matching model resolved.** Product is opposite-sex matching only, by deliberate design — not a legal-review blocker, since the discovery filter never offers same-sex matching as a feature in the first place. `gender` uses a simple male/female enum; discovery filtering derives directly from it (no separate `interestedIn` field needed). Confirmed live: Atlas had zero profiles at the time of this change, so no migration was needed. **Residual watch item:** the discovery filter's "silent exclusion for non-enum/missing gender" behavior only becomes a real risk if a profile is ever created outside the mobile form's enum-constrained screen (a seed script, admin tool, or bulk import). If such a path is built later, re-run `{ gender: { $nin: ['male','female', null] } }` against production before trusting the filter.

- [ ] **Tighten CORS before production.** Both the REST API and the new Socket.io layer currently allow `origin: '*'` (Socket.io was deliberately set to match the existing permissive REST config while building, not because it's safe long-term). This is a real security gap for Socket.io specifically — open CORS on an authenticated real-time connection means any website could attempt to open a socket to your server. Fix both together before any public launch: restrict to the actual frontend/app origins.

- [ ] **Orphaned shell Users cleanup.** The OTP flow creates a `User` record on *request*, not on successful *verify* (a schema requirement — `Verification.userId` needs an existing user to reference). This means an abandoned or failed OTP attempt leaves a `phoneVerifiedAt: null` shell user in the database. Harmless today; worth a periodic cleanup job once there's an admin surface or enough real traffic for it to matter.
- [ ] **QoreID dev-mode toggle.** CraftRanked's codebase has a `QOREID_ENABLED=false` env flag that mocks a successful verification locally, avoiding real API calls (and cost) during everyday development. Worth adding the same pattern to SabiPesin's spec before building the QoreID integration (Phase 5) — genuinely useful, not yet added.
- [ ] **StoreKit product IDs / iOS subscription pricing tier.** Apple sells subscriptions in fixed price tiers, not arbitrary naira amounts — needs mapping once the final subscription price is locked in.
- [ ] **Subscription screen — Android path untested.** The mobile Unlimited upgrade flow (`SubscriptionScreen.tsx`), now including the receipt-email field added on top of it, was verified on the iOS Simulator only (via a temporary, since-reverted test override) plus the backend directly; `WebBrowser.openAuthSessionAsync`'s actual in-app-browser behavior on a real Android device/emulator — the platform this feature ships on — has never been run.
- [ ] **Receipt-email delivery itself still unverified.** The email now reaching Paystack is confirmed correct (looked up directly via Paystack's own transaction API, both the saved address and the synthesized fallback), but whether Paystack's sandbox actually *sends* a receipt email was never checked — there's no tunnel in this dev environment, so Paystack never delivers a webhook or callback here. Worth a real end-to-end check (production, or sandbox with a tunnel) before trusting that real payers get their receipt.
- [ ] **Backend has no request logging.** `server.js` has no morgan/winston/pino or any access-log middleware for any route. Needed before launch for basic observability/debugging; until it exists, "check the log for call X" is never a valid way to verify whether an endpoint fired.
- [ ] **Subscription header icon renders as "?" on some devices.** The ⭐ Unlimited icon added to the Discover header (`RootNavigator.tsx`) is a raw emoji glyph; replace with a proper icon asset/icon font so it doesn't fall back to a missing-glyph box on devices/fonts that don't render it.
- [ ] **Soften "still processing" copy after a deliberate cancel.** `SubscriptionScreen.tsx`'s timeout state says the payment "can take a few minutes" — reads oddly when the user just dismissed the checkout on purpose rather than waiting on a slow payment. Reword to be neutral regardless of why polling timed out.

---

## Product / brand follow-ups

- [ ] **Logo mark.** The name (SabiPesin) is locked; the visual logo itself is still undesigned. Flagged as open in the brand mockup.
- [ ] **Revenue projections in the investor mockup** are currently shown gross. Once you're closer to launch, worth running a version net of the iOS 15% commission (Small Business Program rate) so the investor sees real take-home, not just gross MRR. Not urgent — a five-minute update whenever it's relevant again.

---

## Phase status (per technical-build-spec.md)

Verified against the actual code, not assumed from the spec's recommended order (audit, 7 Oct 2026):

- [x] **Phase 1 — Foundation.** Done. Phone OTP auth, JWT access/refresh, auth middleware.
- [x] **Phase 2 — Profiles.** Done. Profile CRUD, Cloudinary photo upload, `PUT /profile/discovery-settings` enforcing the reciprocity rule.
- [x] **Phase 3 — Discovery & Matching.** Done. Geo query, swipe, match creation.
- [x] **Phase 4 — Messaging.** Done. Socket.io, conversation/message models, anti-scam keyword flagging.
- [ ] **Phase 5 — Trust & Verification — partial.** `POST /verification/nin/start` and `GET /verification/status` are built, but `POST /verification/nin/webhook` (the vendor callback that actually sets `ninVerifiedAt`) was never built. Also blocked on the QoreID sandbox-subscription gap above — the NIN+selfie flow has never been exercised end to end with a real vendor response.
- [ ] **Phase 6 — Payments — partial.** Paystack path (Android/web) is fully built: Subscription + Transaction models, `/subscriptions/me`, `/subscriptions/subscribe/paystack`, `/purchases/boost|superlike/paystack`, signature-verified `/payments/webhook/paystack`. No iOS/StoreKit routes exist. See the payments platform decision below — this phase's remaining scope has changed.
- [ ] **Phase 7 — AI features — not started.** No AI/ML code, libraries, or routes exist anywhere in the repo. Per `tindev-to-african-dating-app-plan.md`, scope is compatibility scoring + conversation-starter generation via the Anthropic API (Claude) — not human-assisted curation.
- [ ] **Phase 8 — Admin & moderation — not started.** No `/admin/*` routes or admin controllers exist. `User.role` reserves an `'admin'` enum value and `Report.status` reserves a moderation lifecycle, but nothing reads or acts on either yet.
- [ ] **Phase 9 — Testing:** broader end-to-end pass once more phases exist (note: less debt here than usual, since every PR so far has been tested before merge, not deferred)
- [ ] **Phase 10 — Production deployment:** App Store Connect setup, 17+ age rating, reviewer demo account (bypasses OTP/NIN in a controlled way), StoreKit product configuration

---

## Payments platform decision (5 Oct 2026)

In-app purchases (Unlimited subscription, boosts, superlikes) will go through **Google Play Billing** (Android) and **Apple StoreKit** (iOS) — not Paystack — because both app stores require their own billing for in-app digital goods. The existing Paystack backend (Subscription + Transaction models, `/subscriptions/me`, the Paystack webhook) stays as-is; it's being extended, not replaced.

- [ ] Google Play purchase verification + Google Play real-time developer notifications (server-side)
- [ ] iOS StoreKit receipt verification + App Store Server Notifications v2 (server-side)
- [ ] Extend `paymentPlatform` (`Subscription`/`Transaction` models) to cover `google_play`, alongside the existing `ios_iap` / `paystack` values
- [ ] **Real purchase testing is blocked until Apple and Google enrollment completes** — nothing above can be verified end-to-end before then.

---

## Known gaps (docs audit, 7 Oct 2026)

- [ ] **`POST /auth/logout` never built.** Listed in the spec (`technical-build-spec.md` §6); mobile just drops the tokens client-side on sign-out, no server call.
- [ ] **No mobile UI for report, block, or account deletion.** All three exist on the backend only (`SafetyController`, `AccountController`) — there's no screen or flow to trigger them from the app.
- [ ] **`frontend/` is the untouched original Tindev web app**, not part of SabiPesin — never touched since the fork, per the spec's "almost none of its actual logic survives" note.
- [ ] **Root `README.md` is still Tindev's original Rocketseat-bootcamp README** — not updated for SabiPesin.

---

## Already resolved (kept for the record)

- [x] **Token refresh (mid-session).** Backend `POST /auth/refresh` with rotation, mobile REST refresh-and-retry on 401, and chat socket handshake-rejection recovery via refresh — all three chunks merged. (PR #28)
- [x] **Report / Block (backend)** — the App Store Guideline 1.2 safety requirement. `Report` + `Block` models, `POST /users/:id/report`, `POST`/`DELETE /users/:id/block`, `GET /users/blocked`, and blocking wired into every surface: discovery, `GET /matches` + `/matches/:id`, `GET /conversations` + `/conversations/:id/messages`, `POST /matches/:id/conversation`, and the socket `message:send` handler (either direction; Match/Conversation docs soft-excluded, never deleted). Backend only — mobile UI is a later slice. Verified against the Atlas dev DB with the real Joe/Girl accounts. (branch `feature/report-block`)
- [x] Hardcoded MongoDB credentials rotated out, fresh SabiPesin cluster live and verified
- [x] Fake Tindev auth (GitHub-signup, spoofable header, dead LoginController) fully stripped
- [x] JWT foundation built — separate access/refresh secrets, type-claim cross-validation
- [x] Phone OTP flow built self-managed (Termii's Token API turned out to be "Country Inactive" on both accounts) — hashed codes, 10-min expiry, 5-attempt cap, rate limiting
- [x] JWT issuance wired into OTP verify success path
- [x] App-wide async error handling — no single bad request can crash the server anymore
- [x] Profile model + `GET/PUT /profile/me` built, with `discoverySettings` and `photos` deliberately excluded from the general update endpoint to protect the reciprocity rule
- [x] **Account deletion (backend).** `DELETE /account` (App Store Guideline 5.1.1(v)) — hard-deletes the caller's own User/Profile/Swipe docs and Cloudinary photos, cascades correctly, socket disconnect on delete. Mobile UI is still outstanding (see Known gaps above). (PR #27)
- [x] **Subscription screen (mobile).** `SubscriptionScreen.tsx` — Paystack Unlimited upgrade flow and status display, reachable from the Discover header. (PR #29)
- [x] **Receipt email.** Optional `GET/PUT /account/email` (self-only, never used for login/OTP/recovery) wired into the Paystack subscribe/purchase paths, with a receipt-email field added to the Subscription screen. (PR #30)
