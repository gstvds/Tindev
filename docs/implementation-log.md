# Implementation Log

A running record of what was actually built, the real endpoint/model shapes, and
any deviations from `technical-build-spec.md` (with the reason). One entry per
feature, committed together with that feature's code.

---

## Receipt email — mobile Subscription screen field + account API (mobile only, Chunks 3 & 4 of 4)

**Why:** Chunks 1–2 built the backend (optional account `email`, `GET/PUT
/account/email`, and both Paystack init calls preferring it over the
synthesized placeholder). Nothing on mobile could set it yet. This closes the
loop: an optional "Email for your receipt" field on `SubscriptionScreen.tsx`,
shown only where the Upgrade button already shows, following Apple's
requirement that any personal-info ask be optional and never block app use.

**New file — `src/api/account.ts`:** `getMyEmail()` (`GET /account/email`) and
`updateMyEmail(email: string | null)` (`PUT /account/email`), following
`profile.ts`'s thin-typed-wrapper convention.

**`SubscriptionScreen.tsx` changes:**
- New state: `email` (live input), `savedEmail` (last value confirmed by the
  backend, `null` = nothing saved), `emailError`, `emailSaveState` ('idle' |
  'saving' | 'saved'), `emailNotice` (shown only when an Upgrade-triggered save
  fails for a non-format reason).
- `load()` now also calls `getMyEmail()` after the subscription-status fetch
  succeeds, to pre-fill the field. Best-effort: a failed prefill just leaves
  the field blank rather than putting the whole screen in the error state —
  only the required status fetch can do that.
- Local `Field` component added (label + "Optional" badge + inline error),
  mirroring `ProfileSetupScreen`'s local (unexported) `Field` — duplicated
  rather than extracted into a shared component, since `ProfileSetupScreen`
  doesn't export it and extracting wasn't asked for.
- `validateEmailFormat()` mirrors the backend's own rule exactly — trimmed,
  max 254 chars, `/^\S+@\S+\.\S+$/` — so a malformed value is caught locally
  before any network call ever fires.
- `trySaveEmail()` is the shared core: validates locally (returns `{ ok:
  false, reason: 'format' }` on failure, setting the inline error — nothing
  sent to the network), no-ops if the trimmed value already matches
  `savedEmail`, otherwise calls `updateMyEmail()` and returns `{ ok: false,
  reason: 'save-failed' }` on a network/server error. Returning a reason
  (rather than a bare boolean) was necessary so `onUpgrade` can tell "don't
  proceed" apart from "proceed but flag it" without re-reading `emailError`
  state right after setting it (a stale-closure trap — `setState` calls don't
  resolve synchronously, so a same-tick read of the state variable would see
  the pre-update value).
- The standalone **Save** button calls `trySaveEmail()` directly; a
  `'save-failed'` result (but not `'format'`, which already shows its own
  error) surfaces a generic "Could not save your email" inline message.
- `onUpgrade()` now calls `trySaveEmail()` first. A `'format'` failure returns
  immediately — inline error shown, no checkout, exactly like before this
  change for a bad value. A `'save-failed'` result does **not** block — it
  sets `emailNotice` ("We couldn't save your receipt email, but your upgrade
  will continue.") and falls through to the existing checkout flow unchanged.
  Nothing else in `onUpgrade` (the `Platform.OS !== 'android'` guard,
  `subscribeToUnlimited()`, `WebBrowser.openAuthSessionAsync`,
  `pollUntilActiveOrTimeout()`, the 409 handling) was touched.
- Visibility: the email field and the Upgrade button now share one boolean,
  `showUpgradeFlow = !isActiveUnlimited && Platform.OS === 'android'` — the
  exact condition the Upgrade button already used, so the field can never show
  somewhere the button doesn't (or vice versa). The iOS "coming soon" notice
  and the existing polling/timeout/success notices are unchanged.

**Smoke test — real device/simulator walkthrough, driven interactively by the
user, one instruction at a time** (local mongod on a fresh scratch dbpath,
port 27097, backend on `PORT=3333` to match mobile's default
`EXPO_PUBLIC_API_BASE_URL=http://localhost:3333`, real Paystack sandbox key
already in `.env`; two disposable phone numbers, `08011110001` and
`08011110002`, neither Joe/Girl; OTP codes read from the backend's
`[otp-dev-echo]` console line after the user tapped Send in the app — never
requested by the assistant, so the user's own in-flight code was never
clobbered):

- **(a)** Fresh free account, no email: field rendered empty; tapping Upgrade
  opened the real Paystack sandbox checkout (accepting iOS's "expo wants to
  use paystack.com to sign in" `ASWebAuthenticationSession` prompt, which is
  normal system behavior for `openAuthSessionAsync`, not app-specific).
  Checkout was cancelled without paying each time in every case below, to
  avoid actually activating a subscription mid-walkthrough; the resulting
  honest "still processing" timeout after ~30s confirmed the untouched
  polling logic was unaffected.
- **(b)** Typed a valid email, tapped **Save** (saw the "Saved" confirmation),
  then Upgrade: looked up the most recent Paystack sandbox transaction via
  `GET /transaction` and confirmed `customer.email` was exactly that address.
- **(c)** Typed a malformed value (`not-an-email`), tapped Upgrade directly:
  inline "Enter a valid email address." error shown, no
  `ASWebAuthenticationSession` prompt appeared — confirmed checkout never
  opened, purely client-side rejection.
- **(d)** Typed a different valid email **without** tapping Save, tapped
  Upgrade directly: Paystack's API showed the new address on the resulting
  transaction, and a direct read of the scratch DB confirmed the email was
  actually persisted to the account (not just sent once) — proving the
  save-before-checkout path in `trySaveEmail()` fired.
- **(e)** Cleared the field, tapped Save (shown as "Saved" with an empty
  field — confirmed with the user that this is the correct cleared state, not
  a bug), then Upgrade: Paystack's API showed the next transaction back on the
  synthesized `2348011110001@users.sabipesin.com` address.
- **(f)** A second account (`08011110002`) with its `Subscription` doc set
  directly to `unlimited`/`active` in the scratch DB (bypassing real payment —
  this case only tests UI state, not a purchase): screen showed "Unlimited"
  plan, a renewal date, **no** email field, and **no** Upgrade button.
- **(g)** After fully reverting the temporary iOS-testing override (see
  below) and reloading, the same free account on (real, non-overridden) iOS
  showed the "coming soon" notice and **no** email field.

**Temporary iOS-testing override, used only during the walkthrough above —
confirmed fully removed before this entry:** a `TEMP_ALLOW_IOS_TESTING` const
(same technique as the prior Phase 6 Subscription-screen slice) temporarily
widened `showUpgradeFlow` and the `onUpgrade`/iOS-notice guards to treat iOS
as the Android path, since this environment has no Android emulator. Removal
was verified three ways: a byte-for-byte `diff` against a snapshot of the file
taken before the override was introduced (zero output), a clean `tsc
--noEmit`, and `git --no-pager grep --cached "TEMP_ALLOW_IOS_TESTING" --
mobile/` after staging the two changed files (exit code 1 — no match), with
the files unstaged again immediately after. **The committed code never
allows iOS down this path** — `onUpgrade` still returns early unless
`Platform.OS === 'android'`, and the field/button condition is unchanged from
what ships.

**Incidental, pre-existing issues hit along the way (not caused by this
chunk, not fixed here):** a double-tap on "Send code" superseded the first
OTP (expected — only the latest code is ever valid, per
`AuthController.requestOtp`'s supersede-on-resend logic); the header's ⭐/⚙
icons render as "?" glyphs in this simulator (already tracked in
`sabipesin-todo-list.md`); and a stale Metro bundle survived a plain in-app
reload after the override was reverted, requiring `expo start -c` to actually
clear — a Metro caching quirk, not a code issue.

**Not verified (flagged in `sabipesin-todo-list.md`):** the Android path for
this whole flow (same gap as the original Subscription-screen slice — no
Android emulator/device available here), and whether Paystack's sandbox
actually *sent* a receipt email for any of the real addresses used above —
there's no tunnel in this environment, so that remains unconfirmed.

---

## Receipt email — wire saved email into Paystack init (backend only, Chunk 2 of 4)

**Why:** Chunk 1 added the optional, unverified `email` field and `GET/PUT
/account/email`, but `SubscriptionController` and `PurchasesController` still
synthesized `${phone}@users.sabipesin.com` on every Paystack init, so real
payers still never got their Paystack receipt. This chunk only flips the two
`email` assignments to prefer the saved address — the exact seam both
controllers already called out (`profile?.email || synthesized`, now
`req.user.email || synthesized`).

**Built:** In both `SubscriptionController.subscribeWithPaystack` and
`PurchasesController.startPaystackPurchase`, changed:
```js
const email = `${req.user.phone}@users.sabipesin.com`;
```
to:
```js
const email = req.user.email || `${req.user.phone}@users.sabipesin.com`;
```
`req.user` already carries `email` with no middleware change needed (confirmed
in Chunk 1: `middlewares/auth.js`'s `User.findById` has no projection). Nothing
else in either controller changed — the 409 double-subscribe guard, the
`Transaction.create()` call, the reference generation, and `PaymentsController`
(webhook/settlement) are byte-for-byte unchanged from before this chunk. The
surrounding launch-blocker comments in both controllers are now stale (the
blocker they describe is resolved) but were deliberately left untouched per
this chunk's explicit scope — a follow-up cleanup, not done here.

**Smoke test** (real Paystack sandbox — `sk_test_…` key already in `.env` — on
a fresh local mongod scratch dbpath, port 27098/`PORT=3398`; two disposable
accounts, neither Joe/Girl; no tunnel, so no webhook delivery from Paystack
itself — only locally-crafted signed requests, see the regression item below):
- `POST /subscriptions/subscribe/paystack` on an account with no email → `201`
  with an `authorizationUrl`; looked the resulting `reference` up via
  Paystack's own `GET /transaction/verify/:reference` and confirmed
  `data.customer.email` is the synthesized `+2340000001001@users.sabipesin.com`.
- Same call on an account with `email` set via `PUT /account/email` → `201`;
  Paystack's `transaction/verify` showed `data.customer.email` as the real
  address (`receipt-smoke-chunk2@example.com`), not the synthesized one.
- Repeated both cases for `POST /purchases/boost/paystack` and `POST
  /purchases/superlike/paystack` — same result in all four combinations,
  verified directly against Paystack's API each time, not just the init
  response.
- `PUT /account/email { email: null }` on the with-email account, then a fresh
  `POST /purchases/superlike/paystack` → Paystack's `transaction/verify` showed
  `data.customer.email` back to the synthesized `+2340000001002@users
  .sabipesin.com` — confirms the fallback re-engages the moment the saved
  email is cleared, not just at account creation.
- Regression — a hand-built, correctly HMAC-SHA512-signed `charge.success`
  payload (same construction as `services/paystack.verifyWebhookSignature`,
  signed with the real sandbox secret) for the with-email account's real
  subscribe `reference` and `metadata.userId`, POSTed directly to `/payments
  /webhook/paystack` (no live Paystack delivery — no tunnel) → `200 { received:
  true }`, and `GET /subscriptions/me` afterward showed `plan: "unlimited",
  status: "active"`. The email had already been cleared to `null` on this
  account by the previous step, so this proves activation never reads or
  depends on `email` — only `metadata.userId` and `reference`, as found in
  Chunk 1. A second `POST /subscriptions/subscribe/paystack` on the now-active
  account → `409` (double-subscribe guard untouched). The same payload replayed
  with a garbage `x-paystack-signature` → `401 { error: "Invalid signature" }`
  (signature check untouched).

**Not verified (can't be, from here):** whether Paystack's sandbox actually
*sent* a receipt email to either address. There is no tunnel in this
environment, so Paystack never delivered a webhook or any other callback here,
and nothing about email delivery is observable via the API lookups above (they
only show what `customer.email` Paystack recorded against the transaction).
This chunk confirms the correct address reaches Paystack's own records — not
that an email was received.

**Not built (later chunks):** no mobile changes — the Subscription screen UI
for setting an email, and the `mobile/src/api/account.ts` client, are Chunks
3–4.

---

## Receipt email — account-level email field + `GET/PUT /account/email` (backend only, Chunk 1 of 4)

**Why:** `SubscriptionController.subscribeWithPaystack` and `PurchasesController
.startPaystackPurchase` synthesize `${phone}@users.sabipesin.com` for Paystack
because accounts are phone-only — so real payers never receive their Paystack
receipt (tracked as a launch blocker, with the seam already noted in both
controllers: `profile?.email || synthesized`). This chunk adds the optional
email itself and the endpoints to manage it. It deliberately does **not**
touch `SubscriptionController`, `PurchasesController`, or any payment code —
wiring the real address into the Paystack `email` field is Chunk 2.

**Built:**
- `models/User.js` — new `email` field: `{ type: String, default: null,
  lowercase: true, trim: true, maxlength: 254, match: /^\S+@\S+\.\S+$/ }`. No
  unique index — this is a receipt-delivery convenience field, not an identity
  key, so two accounts may share an address. Never verified, never used for
  login/OTP/recovery; auth stays phone-only and untouched.
- `AccountController.getEmail` — `GET /account/email` → `{ email: string |
  null }`, read from `req.user` (already loaded by `middlewares/auth.js`'s
  `User.findById`, no projection excludes it — confirmed below).
- `AccountController.updateEmail` — `PUT /account/email` accepts `{ email:
  string | null }`. Trims and lowercases; empty string or `null` clears it back
  to `null`. Explicit pre-checks (same style as `updateDiscoverySettings`)
  return `400` with a `code` before touching the DB: `INVALID_EMAIL` (not a
  string, or fails the match regex) and `EMAIL_TOO_LONG` (> 254 chars after
  trim). Self-only — the target is always `req.userId`, via the same
  `req.user` the auth middleware already loaded (no other-account lookup path
  exists), mirroring `deleteAccount`.
- Both routes registered in `routes.js` next to `DELETE /account`, behind `auth`.

**Mongoose 5.7 validator gotcha — deliberately avoided `findOneAndUpdate`:**
this codebase's Mongoose version does not run schema validators on update
queries unless `runValidators: true` is explicitly passed. `updateEmail` calls
`req.user.save()` instead (save() always runs validators), so the schema's own
`match`/`maxlength` validators are a real second line of defense behind the
controller's explicit checks — proved directly below, not assumed.

**Smoke test** (local mongod, scratch dbpath on port 27099, `PORT=3399`,
disposable accounts minted directly via `utils/jwt.issueTokens` — no OTP, no
Atlas):
- `GET /account/email` on a fresh account → `200 { email: null }`.
- `PUT { email: "user@example.com" }` → `200`; subsequent `GET` reflects it.
- `PUT { email: "  Test@Example.COM " }` → stored/returned as
  `test@example.com` (trimmed + lowercased).
- `PUT { email: "not-an-email" }` → `400 { error, code: "INVALID_EMAIL" }`.
- `PUT` with a 296-char value → `400 { error, code: "EMAIL_TOO_LONG" }`.
- `PUT { email: "" }` and `PUT { email: null }` both → `200 { email: null }`.
- No `Authorization` header → `401`.
- Two different accounts both `PUT` the same address → both `200` (no
  uniqueness conflict).
- Set an email, then `DELETE /account` → confirmed via a direct `User.findOne`
  against the scratch DB that no User document remains (not just that the
  field was cleared).
- Schema-validator proof, bypassing the controller entirely: a raw
  `user.email = 'not-an-email'; await user.save()` throws `ValidationError:
  Path \`email\` is invalid`; a 255-char local-part similarly throws on
  `maxlength` — confirms the validators in `User.js` are real, not just the
  controller's own 400s.
- Regression pass on the same running instance: `GET /verification/status`,
  `GET /profile/me` (404 for a profile-less user), `PUT /profile/me`, `GET
  /discovery`, `GET /matches`, and `GET /subscriptions/me` all responded
  exactly as before — this chunk touches nothing on those paths.

**Read-only findings for Chunk 2 (no code changed for these):**
- No code stores or uses a Paystack `customer_code` or `authorization_code`,
  and nothing calls a Paystack "charge authorization" / recurring-charge
  endpoint — `services/paystack.js` only ever calls `POST
  /transaction/initialize`. `Subscription.paystackSubscriptionCode` is written
  opportunistically by the webhook (`PaymentsController.js`) only when
  Paystack's `charge.success` payload happens to include a
  `data.subscription.subscription_code` (i.e. only when a dashboard Plan via
  `PAYSTACK_UNLIMITED_PLAN_CODE` was used) — it is never read back or used to
  trigger a charge anywhere in the codebase. The "Unlimited" plan is a one-off
  30-day charge: `PaymentsController.js`'s `THIRTY_DAYS_MS` sets
  `currentPeriodEnd` 30 days out on each successful `charge.success`, and
  reactivation after expiry requires the user to start a brand-new checkout
  (`POST /subscriptions/subscribe/paystack` mints a fresh `reference`) — there
  is no auto-renewal/auto-charge path that email or any saved card would feed.
- `middlewares/auth.js` loads `req.user` via a bare `User.findById(decoded.sub)`
  with no `.select()`/projection, so the new `email` field is included on
  `req.user` automatically — no middleware change needed for Chunk 2 to read
  `req.user.email`.

**Not built (later chunks):** `SubscriptionController`/`PurchasesController`
still synthesize `${phone}@users.sabipesin.com` — real emails are not yet sent
to Paystack (Chunk 2). No mobile changes (Chunks 3–4).

---

## Mobile subscription screen — Paystack upgrade + status (Phase 6, mobile)

**Built:** The mobile side of the Unlimited plan: a status read, a Paystack
checkout launch (Android/web path only — spec §6), and the poll-for-activation
loop that closes the loop after the user returns from the hosted checkout.
Backend counterpart (`GET /subscriptions/me`, `POST /subscriptions/subscribe/
paystack`, the signature-verified webhook) already existed from the prior
Phase 6 slices above — this is purely the client.

**New files:**
- `src/api/subscriptions.ts` — typed wrappers: `getSubscriptionStatus()` (`GET
  /subscriptions/me`) and `subscribeToUnlimited()` (`POST /subscriptions/
  subscribe/paystack`), following the `profile.ts`/`discovery.ts` convention of
  a thin typed layer over the shared `apiClient`.
- `src/screens/SubscriptionScreen.tsx` — on mount, reads status via
  `getSubscriptionStatus()`. Free/non-active user on Android sees an "Upgrade to
  Unlimited" button; tapping it calls `subscribeToUnlimited()`, then
  `WebBrowser.openAuthSessionAsync(authorizationUrl)`. Browser close (for any
  reason — `openAuthSessionAsync` can't distinguish pay/cancel/dismiss) starts a
  poll of `getSubscriptionStatus()` every 2s, up to 15 attempts (~30s). A flip to
  `plan: 'unlimited', status: 'active'` shows a success notice; exhausting the
  budget without one shows a neutral "still processing" notice — deliberately
  not an error state, since the webhook may simply be slow and we have no signal
  either way. A transient error mid-poll is swallowed (keeps polling on
  schedule) rather than surfacing a scary failure for one blip. iOS renders a
  disabled "coming soon" notice instead of the button and never calls
  `subscribeToUnlimited()` or opens a browser session. A 409 from `subscribe`
  (already active) is treated as a no-op refresh, not an error banner.

**Navigation** (`src/navigation/types.ts`, `RootNavigator.tsx`):
- New `AppStack` route `Subscription` (undefined).
- `Home` (Discover) header gains a **⭐ Unlimited** icon to the left of the
  existing filter icon, mirroring the `DiscoverySettings` header-icon pattern
  (`navigation.navigate('Subscription')`).

**Dependencies:** added `expo-web-browser` (`~13.0.3`, via `npx expo install`
for SDK 51 compatibility) — not previously a dependency.

**Deviations from spec:**
- No explicit success/failure signal from the browser close itself; correctness
  rests entirely on the poll eventually observing the webhook's write (or timing
  out honestly). This mirrors the chat slice's "honest about what we don't know"
  stance above rather than guessing from `WebBrowserAuthSessionResult`.

**Known gaps (not specific to this slice, but surfaced while testing it):**
- **No request logging.** `server.js` has no morgan/winston/pino or any other
  access-log middleware — nothing logs a request's path/method/body for any
  route, including this one. "Check the log for a call to X" is not a valid
  verification technique here; it would read as empty whether or not the call
  happened. Verifying whether an endpoint fired requires an independent signal
  (here, the Paystack sandbox API's own transaction records).
- **Synthesized placeholder email.** `SubscriptionController.subscribeWithPaystack`
  sends Paystack `${phone}@users.sabipesin.com` (accounts are phone-only, but
  Paystack requires an email). Paystack mails the payment receipt to that
  address, so real payers currently receive no receipt — already flagged as a
  launch blocker in that controller; repeated here because this slice is what
  actually drives a receipt-bearing sandbox charge end to end.

**Verification:** Mobile `tsc --noEmit` clean (strict).

Live-tested end-to-end on the **iOS Simulator** against a local-mongod-only
backend (`mongodb://127.0.0.1:27017/sabipesin_subtest`, never Atlas) and the
real Paystack sandbox (`sk_test_`/`pk_test_`). iOS has no purchase path by
design (spec — Apple requires StoreKit for digital subscriptions), so reaching
the button required a **temporary, since fully-reverted** `TEMP_ALLOW_IOS_TESTING`
const in `SubscriptionScreen.tsx` that bypassed the `Platform.OS === 'android'`
checks for this test session only. The revert was verified three ways: a diff
against a saved pre-revert snapshot showing exactly the override's 3 hunks
removed and nothing else, `grep -n "TEMP_ALLOW_IOS_TESTING"` returning zero
matches, and a clean `tsc --noEmit` after. **The committed code was never
changed to allow iOS** — `onUpgrade` still returns early unless
`Platform.OS === 'android'`, and the iOS branch still renders only the
coming-soon notice.

Two local-only seeded accounts (free; and an already-active Unlimited) covered
all five original smoke-test cases:
- Free account: "Free" status + Upgrade button shown.
- Tap Upgrade → real Paystack sandbox checkout opened; completed by choosing
  the "Success" option in Paystack's sandbox test-mode picker (no card details
  were entered). **No ngrok/tunnel is configured**, so Paystack's
  servers cannot reach this localhost backend — real Paystack-to-webhook
  delivery was already proven live in the Phase 6 webhook entry below and was
  not re-proven here. Instead, a manually HMAC-signed `charge.success` POST
  (same technique as that Phase 6 test) was sent to the local webhook route
  using the *real* sandbox transaction reference looked up from Paystack's own
  API. The Mongo `Subscription` doc was confirmed flipped to `unlimited/active`
  before the checkout sheet was closed; the screen's poll then picked it up and
  showed the success state ("Renews 02/11/2026").
- Dismiss-without-paying: the account's `Subscription` doc was reset to free
  (deleted from the local test DB) to retest; the corresponding Paystack
  transaction was confirmed `abandoned` via the sandbox API; the screen showed
  neither a false success nor an error, consistent with the neutral
  still-processing/no-upgrade-button behavior.
- Already-active account: "Unlimited" + renewal date shown, no Upgrade button.
- iOS (after reverting the temporary override): "Free" status + the
  coming-soon notice, no Upgrade button — confirmed visually on the simulator.

Backend chain additionally covered by a reconstructed version of the Phase 6
webhook harness against the same local-mongod backend (7/7 assertions: new
user defaults to free, real sandbox `authorizationUrl` returned, correctly
signed webhook → `200` → flips to `unlimited/active`, badly signed webhook →
`401`, second subscribe attempt on an active plan → `409`); harness deleted
immediately after running, nothing from it committed.

**Not verified: Android.** No Android emulator or device was used in this
slice — `WebBrowser.openAuthSessionAsync`'s in-app-browser behavior on Android
specifically (the platform this feature actually ships on) remains untested.
Only iOS (under the temporary, reverted override) and the backend chain were
exercised live.

---

## Token refresh — chat socket reconnect (Chunk 3 of 3 — feature complete)

**Why:** Chunk 2 fixed REST; the socket was still open. Investigation flagged
`chatSocket.ts`'s handshake `auth: { token: accessToken }` as a static object
captured once at mount — Socket.IO reuses it verbatim on every reconnect, so
once the access token expires, reconnection would be attempted with a
permanently stale token.

**Verified against a real backend before writing any fix** (not assumed from
the investigation's phrasing): a rejected handshake does **not** actually loop
forever. socket.io-client's Manager auto-retries a *transport-level* failure
(offline, wrong host — surfaces as a `TransportError` with
`.type === 'TransportError'`) but, by design, does **not** retry a
*middleware-rejected* handshake at all (`io.use`'s `next(new Error(...))` —
`src/socket/index.js` — surfaces as a plain `Error`, no `.type`). One
`connect_error` fires and the socket just goes silently dead — arguably worse
than a loop, since there's no ongoing sign anything is still trying. This
corrects the "silent reconnect loop" framing from the investigation summary;
the actual bug is "one rejected attempt, then nothing," not an infinite retry.
Also confirmed separately: a *server-initiated* `socket.disconnect()` sends
reason `"io server disconnect"`, which socket.io-client explicitly does not
auto-reconnect from either — different from a real network drop, which closes
the transport with reason `"transport close"` and DOES auto-reconnect. Both
findings shaped the smoke test below.

**Fix 1 — a live token on every attempt:** `auth` is now a function
(`(cb) => { getTokens().then(current => cb({ token: current?.accessToken ??
null })) }`), not a static object. socket.io-client invokes this fresh on the
initial connect AND every reconnect/manual-reconnect attempt (verified:
`Socket.prototype.onopen` checks `typeof this.auth == "function"` and calls it
per attempt), so whatever token is currently in storage is always what gets
sent.

**Fix 2 — handle a rejected handshake instead of leaving it dead:** on
`connect_error`, `isHandshakeAuthRejection(err)` distinguishes the two cases
above (`err.type !== 'TransportError'`). A transport error falls through to
Socket.IO's own automatic reconnection, unchanged — network drops should just
keep retrying with whatever token is currently valid. A middleware rejection:
- First occurrence for this failure → `getOrStartRefresh(baseUrl)`, then
  `socket.connect()` manually once the refresh resolves (the Manager won't
  retry this on its own — confirmed above), so the retried handshake goes out
  with the fresh token via Fix 1.
- Refresh fails, or the refreshed token is *also* rejected
  (`refreshedForThisFailure` guard, mirrors Chunk 2's `_retried`) →
  `socket.disconnect()`, `connectionState` set to `'disconnected'` explicitly
  (confirmed a `.disconnect()` on a socket that never successfully connected
  does NOT fire a `'disconnect'` event, so the UI state can't be left to that
  listener here), and `forceSignOut()`.
- `refreshedForThisFailure` resets on a successful `'connect'`, so a later,
  independent auth rejection (e.g. the refresh token's own 30-day expiry) can
  trigger the flow again — but a refresh whose new token the server also
  rejects doesn't loop.

**Shared refresh/sign-out logic, extracted rather than duplicated:**
`getOrStartRefresh` and `forceSignOut` (plus `registerSignOutHandler`) moved
out of `client.ts` into a new `auth/refreshSession.ts`, used by both
`client.ts` and `chatSocket.ts`. Flagging this judgment call rather than just
making it silently: extracting means a REST 401 and a socket handshake
rejection landing around the same moment share ONE refresh call (the
module-level `refreshPromise` is now genuinely global, not per-transport)
instead of racing two against the backend's rotation (Chunk 1 invalidates a
refresh token the instant it's redeemed, so a losing racer would get
`INVALID_REFRESH_TOKEN`). `getOrStartRefresh(baseUrl)` takes the base URL as a
parameter rather than importing it, so each transport still resolves its own —
both use `apiClient.defaults.baseURL` in practice. `chatSocket.ts` now connects
via `io(apiClient.defaults.baseURL, ...)` instead of the separately-imported
`API_BASE_URL`, the same "one source of truth" fix Chunk 2 made for the REST
refresh call, for the same testability reason.

**Test infrastructure:** added `socket.io` (server) and
`@types/react-test-renderer` as devDependencies — `react-test-renderer` itself
was already present transitively. `useChatSocket` is a hook, so the test uses a
minimal hand-rolled `renderHook` (a host component + `react-test-renderer`'s
`act`/`create`) rather than pulling in `@testing-library/react-hooks`, which
isn't maintained for React 18.

**Two real bugs caught by writing the smoke test, both fixed before it
passed:**
1. The test process hung indefinitely after all assertions had actually
   completed. Cause: `renderChatSocket()` never unmounted the test renderer, so
   the hook's socket (and any pending reconnection timers) outlived each test
   and kept Node's event loop alive. Fixed with an `afterEach` that unmounts
   every renderer created. Test-file-only issue, not a `chatSocket.ts` bug — a
   real screen unmounting already calls the hook's cleanup, which disconnects
   and removes listeners.
2. The "network drop" and "token expires mid-session" tests originally used
   `serverSocket.disconnect(true)` to simulate a drop — which, per the finding
   above, sends `"io server disconnect"` and never triggers a reconnect, so
   both tests timed out waiting for a reconnection that was never going to
   happen. Fixed by using `serverSocket.conn.close()` instead (closes the
   underlying engine.io transport, reason `"transport close"`), which does
   trigger the client's normal automatic reconnection — confirmed directly
   against a real `socket.io-client`/`socket.io` pair before changing the
   tests.

**Smoke test** (`src/realtime/__tests__/chatSocket.test.ts`, a real `socket.io`
server + real `socket.io-client`, `expo-secure-store` swapped for an in-memory
Map):
- Expired access token at initial connect → handshake rejected → refresh
  triggered → `socket.connect()` retried → connects with the fresh token.
  Exactly one refresh call; new pair persisted to storage.
- Token that "expires mid-session": connects fine, then the underlying
  transport is closed (simulating a drop) at the moment the server would also
  now reject the old token → the client's own auto-reconnect attempt gets
  rejected → refresh → manual reconnect → connects with the fresh token.
  Exactly one refresh call, not a loop.
- Refresh itself fails (backend's `INVALID_REFRESH_TOKEN`) → `forceSignOut`
  called exactly once, socket ends in `'disconnected'`, tokens cleared,
  exactly one refresh attempt (no retry chase).
- An ordinary network drop with a still-valid token (`conn.close()`,
  `authCheck` never changes) → reconnects on its own, `refreshCallCount` stays
  `0` — confirms refresh is never triggered for a plain transport blip.
- Regression: `sendMessage` still round-trips through the real socket once
  connected — the message-send code path is unchanged by this chunk, this just
  confirms the new connection setup around it didn't break it.

All 5 pass; the full mobile suite (both this chunk's and Chunk 2's test files)
is 10/10, and the process now exits cleanly (no more open-handle hang).
`tsc --noEmit` clean across the whole project.

**Live verification:** Backend + local mongod run locally (per the brief, no
Atlas needed — mobile/socket-only). Confirmed via `curl` that a directly-seeded
Match + Conversation resolve correctly through the real `GET /matches` and
`POST /matches/:id/conversation` routes (used as fixtures for a two-account
chat regression). Loaded the real compiled app (Metro/Expo, iOS Simulator)
against this backend: it correctly detected a stale/invalid stored session and
cleanly fell back to the sign-in screen — live confirmation the Chunk 2 REST
interceptor + sign-out path still works end-to-end in the actual app, not just
under Jest. **Could not complete a full manual two-account UI chat exchange in
the simulator** — this sandbox has no UI automation tool available (no
idb/Appium/chromium-cli) and blocks both Accessibility control (`System
Events` error -25204) and screen capture (`screencapture` permission denied)
for driving/verifying taps by coordinate; `cliclick` clicks landed but produced
no visible effect, most likely for the same underlying permission reason.
Flagging this rather than skipping it silently: the send/receive code path
itself is covered by the Jest regression test above against a real wire
protocol with unchanged code, but a true device-UI, two-account, end-to-end
chat exchange was not run for this chunk.

**Feature complete across all 3 chunks:** `POST /auth/refresh` with rotation
(backend) → REST 401 refresh-and-retry (mobile) → socket handshake-rejection
refresh-and-reconnect (mobile). An access token expiring mid-session no longer
401s REST calls or silently kills the chat socket, in either direction.

---

## Token refresh — mobile REST interceptor (Chunk 2 of 3)

**Why:** Chunk 1 built `POST /auth/refresh`, but nothing on mobile called it.
`ApiError.kind` also had no `'unauthorized'` case — `kindForStatus` bucketed
every non-429 4xx (including a real 401) as `'validation'`, so an expired
access token on, say, profile save would have been silently routed into
`parseFieldErrors` as if it were a field error. This chunk fixes both, REST
only — the Socket.IO reconnect path (`chatSocket.ts`) is untouched, per the
brief; it's Chunk 3.

**`errors.ts`:** added `'unauthorized'` to `ApiErrorKind`; `kindForStatus`
returns it for 401 (checked ahead of the `>= 400` catch-all that used to claim
it). Audited every reader of `.kind` before changing this (asked for, not
assumed): `ProfileSetupScreen.tsx` and `profile.ts`'s `parseFieldErrors` both
already fell back to `{ _form: err.message }` for any non-`'validation'` kind,
so reclassifying 401 produces byte-identical rendered output at both sites.
`OtpEntryScreen.tsx` only checks `'rate_limited'`, unaffected. Nothing needed
flagging — no screen-level behavior changed beyond the interceptor itself.

**`client.ts` — refresh-and-retry:** the response interceptor now branches on
a genuine 401 only (nothing else). On the first 401 for a given request: calls
`POST /auth/refresh` with the stored refresh token, saves the returned pair via
the existing `saveTokens`, and retries the original request once (a `_retried`
marker stashed on the axios config prevents a second attempt if the retry
itself 401s — that case goes straight to sign-out, no second refresh). On any
refresh failure — the backend's 401 `INVALID_REFRESH_TOKEN`, or no refresh
token in storage at all — clears tokens and calls the sign-out handler
registered by `AuthContext`, reusing its existing `signOut()` (which already
clears tokens and flips `isAuthenticated`, and per its own header comment is
what swaps the navigator to the auth stack — no new sign-out mechanism
invented). Concurrent 401s (e.g. a screen firing several calls at once) share
ONE in-flight refresh via a module-level `refreshPromise` — every 401 that
lands while a refresh is pending awaits that same promise and retries with
whatever it produces, instead of racing separate refresh calls against the
backend's rotation (Chunk 1) and losing.

The refresh call itself is a bare `axios.post` (not `apiClient`) so it can
never recurse through this same interceptor. Refactored it to read the base
URL off `apiClient.defaults.baseURL` rather than the separately-imported
`API_BASE_URL` constant — one source of truth, and it's what let the smoke
test below point the whole client at a local test server without touching
`config/env.ts`.

**`AuthContext.tsx`:** added `registerSignOutHandler(value.signOut)` in a
`useEffect` (unregistered on unmount). `client.ts` can't import `signOut`
directly — it only exists as state inside the provider, not a top-level
export — so the provider hands the interceptor a reference to call instead.
(Chunk 3 later moved `registerSignOutHandler` from `client.ts` into a shared
`auth/refreshSession.ts` — `AuthContext.tsx` now imports it from there.)

**Test infrastructure (none existed):** the mobile project had no test runner
at all (`tsc --noEmit` was the only script). Added `jest` + `jest-expo` +
`@types/jest` as devDependencies and a `test` script, since simulating "401 →
refresh → retry" and the concurrency/dedupe case needs to exercise real
in-flight requests, not just type-checking. `jest.config.js` overrides
`testEnvironment` to plain `'node'` (from jest-expo's default RN-emulating
environment): that environment hardcodes the `react-native` package export
condition, which resolves `axios` to its XHR-based browser bundle — under Jest
that adapter never does real network I/O, so every request came back a generic
"network" error regardless of what the test server did. Plain `node` gives
axios its real `http`-based adapter. This only affects how test files resolve
modules — the app's own Metro/Expo build is untouched.

**Deviation found and fixed while building the test, not before:** originally
tried to point the test server at the client via
`process.env.EXPO_PUBLIC_API_BASE_URL`, set at runtime in `beforeAll` before
requiring `client.ts`. That doesn't work — confirmed by isolating it to a
throwaway module — because `babel-preset-expo` statically inlines
`EXPO_PUBLIC_*` vars at transform time, so a runtime `process.env` write has
no effect on the already-compiled `config/env.ts`. Switched to overriding
`apiClient.defaults.baseURL` directly after import, which is what motivated
the `performRefresh` refactor above (it has to follow the same override).

**Smoke test** (`src/api/__tests__/client.test.ts`, real `apiClient` against a
real local `http.createServer`, `expo-secure-store` swapped for an in-memory
Map since there's no device under Jest — nothing else mocked):
- 401 → refresh succeeds → original request retried with the new token →
  caller sees only the eventual 200. New token pair confirmed persisted via
  `tokenStorage.getTokens()`.
- 401 → refresh call itself 401s (`INVALID_REFRESH_TOKEN`) → registered
  sign-out handler called exactly once, tokens cleared, exactly one attempt at
  the original request (no retry attempted).
- 3 concurrent requests all 401 at once → exactly one `/auth/refresh` call
  (asserted via a server-side counter) → all 3 retry successfully with the
  resulting token.
- A retry that itself comes back 401 → exactly one refresh call total (not
  two), sign-out triggered, no loop.
- A real 400 validation error → `kind: 'validation'`, no refresh attempted,
  `parseFieldErrors` output unchanged (`{ dob: 'Cast to Date failed for value
  "x" at path \`dob\`' }`) — confirms the existing field-error path is
  byte-for-byte unaffected by this chunk.

All 5 pass (`npx jest`, `--no-cache` re-run to rule out stale-cache effects).
`tsc --noEmit` clean (strict) across the whole project, unchanged.

**Not built at this point (Chunk 3):** `chatSocket.ts`'s reconnect-with-fresh-
token path. See the Chunk 3 entry above for what was actually found there —
the socket didn't loop, it went silently dead; either way, only REST calls
could self-heal until Chunk 3 landed.

---

## Token refresh — `POST /auth/refresh` (backend only, Chunk 1 of 3)

**Why:** flagged as a pre-launch blocker — `verifyRefreshToken` (`utils/jwt.js`)
was already correct and a refresh token was already minted and returned at OTP
verify, but no route ever consumed one: the access token's 15-minute expiry had
nothing to renew it, so the chat socket would drop and REST calls (e.g. profile
save) would start 401ing partway through a session. This chunk is backend-only;
mobile's REST interceptor and socket reconnect are later chunks.

**Built:** `POST /auth/refresh` — not behind `auth` (the refresh token in the
body is the credential; there's no access token to check by definition).
Verifies the token with the existing `verifyRefreshToken` unchanged, then
rotates: the old refresh token is invalidated the instant the new pair is
minted, not just on its natural 30-day expiry. Response shape matches OTP
verify (`accessToken`, `refreshToken`) — no mobile-side change needed to
consume it later.

**Rotation without a token blacklist or a transaction:** the codebase had no
existing token-tracking pattern (account deletion's note confirms: "there is no
token blacklist — access tokens are stateless JWTs"). New model
`models/RefreshToken.js`: one row per token, written **at redemption**, keyed
by a SHA-256 hash of the raw token (never the token itself) with a `unique`
index — a `userId` and an `expiresAt` mirroring the token's own `exp` (TTL
index, `expireAfterSeconds: 0`, so spent-marker rows reap themselves once the
token they guard would've expired anyway).

`refreshTokens` (`AuthController.js`) does one atomic `RefreshToken.create()`
per request; the unique index IS the concurrency control — Mongo either
inserts the row (first redemption, proceed to mint) or throws `E11000`
(already redeemed — reject), so two concurrent requests for the same token can
never both win. No transaction, same non-transactional-but-safe-on-retry
posture as the account-deletion cascade.

**Deviation from the suggested design (flagging, not asking — stays inside the
options given):** the ask offered "jti (or the token's hash) + userId +
issuedAt, marked as used/deleted on rotation" — i.e. write a row when the token
is *minted*, mark it used later. Writing at mint time would mean `issueTokens`
(called by `verifyOtp`) needs to start writing a DB row and stamping a `jti` on
every login, which is exactly the "change to existing login/OTP-verify code"
the brief said to flag before touching. Writing at *redemption* instead (hash
the raw token, unique-insert on first refresh) gets the identical guarantee —
reuse of an already-rotated token is rejected, concurrent redemption picks
exactly one winner — with **zero changes to `AuthController.verifyOtp` or
`utils/jwt.js`'s existing `issueTokens`/`signRefreshToken`**. Chose this
variant specifically to keep the chunk additive-only per the brief. No changes
were needed to login/OTP-verify code — nothing to flag beyond this note.

**Failure modes** (all collapse to `401 { error, code: 'INVALID_REFRESH_TOKEN' }`
so a client can't distinguish which case it hit): missing/non-string body field,
signature invalid, expired, wrong `type` claim (an access token rejected the
same as garbage), user no longer exists. A suspended/banned user's
otherwise-valid refresh token gets `403`, matching `middlewares/auth.js`'s
existing posture for access tokens.

**Smoke test** (local mongod on port 27117, real minted tokens via the real
`/auth/otp/request` → `/auth/otp/verify` flow, `PORT=3334`):
- Valid refresh token → `200`, new access + refresh pair; the new access token
  verified against `GET /profile/me` (401 would mean rejected, got `404
  "Profile not found"` — accepted); the new refresh token verified by a second
  successful rotation (chains correctly).
- The OLD refresh token, reused after a successful refresh → `401
  INVALID_REFRESH_TOKEN` (rotation actually invalidates it, not just cosmetic).
- Expired refresh token (signed with `expiresIn: '-10s'`) → `401`.
- Malformed/garbage string, and a well-formed *access* token passed as the
  refresh token (`type` claim guard) → both `401`, no `500`, no stack trace in
  the server log.
- Missing `refreshToken` field entirely → `401`, not a crash.
- 5 concurrent requests with the identical refresh token (`curl … &` × 5,
  `wait`) → exactly 1 `200`, the other 4 `401 INVALID_REFRESH_TOKEN`. Confirmed
  in the DB directly: exactly one `RefreshToken` row per token ever redeemed,
  unique + TTL indexes both present (`db.refreshtokens.getIndexes()`).

**Not built (later chunks, per the brief):** mobile's REST interceptor (401 →
call `/auth/refresh` → retry) and the socket's reconnect-with-fresh-token path.
Until those land, mobile behavior is unchanged from before this chunk.

---

## Backend — Account Deletion, Chunk 2: DELETE /account (destructive)

**Built:** `DELETE /account` (App Store Guideline 5.1.1(v)), in
`AccountController.deleteAccount`, wired in `routes.js` behind `auth`. Deletes ONLY
the caller's own account — the target is always `req.userId`, there is deliberately
no admin/other-user deletion path. Immediate hard delete, no grace period.

**Cascade (the caller's own data):**
- **Cloudinary photos** — every `photo.publicId` on the caller's Profile is deleted
  with a real `cloudinary.uploader.destroy` call, reusing the existing
  `services/cloudinary.deleteImage` (the same helper `DELETE /profile/photos/:id`
  uses). Each delete is awaited and verified — `deleteImage` throws `CloudinaryError`
  (→ 502) on a real failure and treats an already-missing asset as success; nothing
  is fire-and-forget.
- **Profile** document.
- **Swipe** documents where the caller is either party (`actorId` OR `targetId`).
- **User** document.

**Deliberately KEPT:** Match / Conversation / Message documents — shared with the
other party, who retains an intact audit trail. The deleted user is instead
soft-excluded from that side's view by Chunk 1 (`utils/accounts.js`). Same posture
as Report/Block keeping docs and soft-excluding.

**Ordering (partial-failure safety, mirrors `ProfileController.deletePhoto`):**
Cloudinary assets are deleted FIRST, so a storage failure aborts (502) before any DB
document is touched; the User document is deleted LAST, so if an earlier DB step
fails the account still exists and the request can simply be retried (a re-deleted
Cloudinary asset reads as "not found" = success). Intentionally NOT wrapped in a
Mongo transaction — the rest of the codebase doesn't use them (they need a replica
set, unavailable on a standalone mongod), and this ordering gives graceful
degradation without one.

**Session invalidation:** there is no token blacklist — access tokens are stateless
JWTs. Deleting the User document IS the invalidation: `middlewares/auth` does a live
`User.findById` on every request (and the socket handshake does the same in
`socket/index.js`), so once the User is gone every existing REST request and every
new/reconnecting socket fails with 401 / "User no longer exists" — immediately, not
bounded by the 15-min token expiry. No new mechanism was invented for that (per the
brief, this was checked and matched rather than replaced).

The one path that live-lookup did NOT cover was a socket **already open at the moment
of deletion**: the handshake authorizes once at connect time, and the per-event
handlers aren't re-checked against the sender, so that connection would otherwise
keep working for its whole lifetime (not bounded by token expiry). Closed by
force-disconnecting the user's live socket(s) at the end of the cascade: each
authenticated socket joins a room named after its userId (`socket/index.js`), so
`req.app.get('io').in(userId).disconnectSockets(true)` evicts every device
immediately (`true` closes the transport so the client sees a real disconnect).
`server.js` now exposes `io` via `app.set('io', io)`. Deliberately NOT a per-event
`isUserDeleted(me)` re-check in `messageHandlers.js` — disconnect-at-deletion-time is
the chosen approach, keeping the hot message path free of an extra lookup.

**Response:** `200 { message: 'Account deleted', deleted: { profile, photos,
swipes } }` — 200-with-body, consistent with the `DELETE /users/:id/block`
precedent. No idempotency handling is needed: once the User is gone the auth gate
401s any repeat call, so the endpoint can't be re-entered by the deleted user.

**Deliberately out of scope (flagging):** the cascade is exactly the set named in
the brief (User, Profile, Swipes, photos). Other rows that reference the user —
`Block`, `Report`, `Subscription`, `Transaction`, and the incoming `Report`s naming
them as `reportedUserId` — are left intact, consistent with the "keep the shared/
audit records" philosophy (a report or block against a since-deleted user is still a
moderation record). Flag if any of those should also be purged.

**Verification:** 28/28 assertions against the LOCAL backend + local mongod (NEVER
Atlas — a real delete has no undo, unlike block/unblock) using a single DISPOSABLE
throwaway user (never Joe/Girl). Two REAL 1×1 PNGs were uploaded to Cloudinary for
that user, then after `DELETE /account`: the response is 200 with the correct counts
(profile true, 2 photos, 2 swipes); the User/Profile/both-direction Swipe docs are
gone from the DB; **both photos are confirmed gone via the Cloudinary Admin API**
(`cloudinary.api.resource` → 404), not merely by a successful DB call; the Match/
Conversation/both Messages the user shared with a "keeper" are untouched in the DB;
the keeper's `GET /matches`, `GET /conversations`, both by-id routes, and a socket
send all now soft-exclude/404/refuse the deleted user (Chunk 1); the deleted user's
old JWT returns 401 on `GET /matches` and a repeat `DELETE /account`; and a full
`POST /swipes` → mutual match → get-or-create conversation → socket `message:send`
regression for two other fresh users still works untouched. The disposable user, its
Cloudinary assets, and the local test DB were all torn down after the run.

The non-transactional cascade's retry safety was separately proven (21/21, local
mongod): a run interrupted right after the Cloudinary step but before the Profile
delete leaves the DB untouched (User/Profile/Swipes intact) with the photos already
gone; a retry then completes cleanly (200), re-processing the already-gone assets
with no throw (Cloudinary "not found" = success) and ending in exactly the state of
an uninterrupted delete.

The already-open-socket disconnect was proven with a REAL socket.io client (12/12,
local mongod): a live authenticated socket that had just sent-and-delivered a message
fires a client-side `disconnect` (reason `io server disconnect`) the instant
`DELETE /account` returns — not on next reconnect — while a second user's socket is
unaffected, and a reconnect with the old token still fails the handshake with "User
no longer exists".

---

## Backend — Account Deletion, Chunk 1: deleted-account soft-exclusion

**Built:** The read-side filter for account deletion (App Store Guideline
5.1.1(v)). Account deletion HARD-deletes a user's OWN User/Profile/Swipe docs and
Cloudinary photos (Chunk 2), but deliberately KEEPS the shared Match/Conversation/
Message docs for the other party's audit trail — the exact same soft-exclude
posture as Report/Block. So the other party must stop seeing/reaching a deleted
user across the same surfaces a block already touches. New shared helper,
`src/utils/accounts.js`, the deletion-side analogue of `src/utils/blocks.js`:
- `isUserDeleted(userId)` → boolean; true when the id has no `User` document. The
  one-off analogue of `isBlockedBetween`, for the by-id read routes and the live
  socket send. (There is no Block row to consult — a deleted user is simply one
  whose `User` doc is gone.)

Call sites (each mirrors the block gate placed right beside it):
- **`GET /matches/:id`** / **`GET /conversations/:id/messages`** /
  **`POST /matches/:id/conversation`** — `isUserDeleted(otherId)` → **404**, the
  same info-leak-safe "not found" as a blocked pair, checked immediately after the
  existing block gate. The get-or-create case also declines to spin up a thread.
- **Socket `message:send`** — a live `isUserDeleted` check refuses to send to a
  deleted counterpart (checked per message, not cached on connect), right after the
  block gate.
- **`GET /matches`** / **`GET /conversations`** — soft-excluded **in memory** after
  the query. These endpoints already batch-load the other participants' `User`
  docs, so a deleted user is simply absent from that map; the pair is filtered out
  there for **free** (no extra query) — the list-side analogue of `blockedUserIds`.
  The Match/Conversation/Message docs are deliberately KEPT.

**Deliberately unchanged — `GET /discovery` (flagging):** unlike a block (where the
blocked user still has live User+Profile docs, so their id must be explicitly added
to the `$nin`), a deleted user has NO Profile row to surface and NO User doc, so the
discovery aggregation's existing inner join (`$lookup` on User → `$unwind: '$user'`,
plus `'user.status': 'active'`) already excludes them under any state — including a
partial-failure state where the User is gone but a Profile lingers. Adding an
existence filter here would be dead code, so discovery is left as-is; the smoke test
still asserts a deleted user never appears in it.

This chunk deletes NOTHING — it is purely a read-side filter, the same risk profile
as Report/Block Chunk 3.

**Verification:** 23/23 assertions against the LOCAL backend + local mongod (never
Atlas). A "deleted" user is simulated as a leftover Match/Conversation/Message whose
other participant has no User doc — the exact state Chunk 2 produces. From Joe's
view: the ghost pair is hidden from `GET /matches` and `GET /conversations` (exactly
one, the real Joe↔Girl pair, remains), the three by-id routes 404 for the ghost and
200 for Girl, `message:send` to the ghost thread is refused (and persists nothing)
while the Girl thread still accepts, and the ghost never appears in `GET /discovery`
(Eve does). The underlying ghost Match/Conversation/Message docs are confirmed still
present afterward (audit trail intact).

---

## Backend — Report / Block, Chunk 3 follow-up: block-gate the by-id read routes

**Built:** Extended the block rule to the three by-id routes that Chunk 3 had left
out, using the same `isBlockedBetween` helper. A blocked pair's match/conversation
now reads as **404 "not found"** — deliberately the same response as a
foreign/missing id, so these routes still can't be used to probe existence and are
consistent with the list endpoints hiding the pair and the socket refusing sends.

- **`GET /matches/:id`** (`MatchController.getMatch`) → 404 when blocked (either
  direction), checked right after the match is loaded.
- **`GET /conversations/:id/messages`** (`ConversationController.listMessages`) →
  404 when blocked, checked after the conversation membership lookup.
- **`POST /matches/:id/conversation`** (`getOrCreateConversation`) → 404 when
  blocked, checked **before** the lazy get-or-create so no conversation is spun up
  for a blocked pair. (The pre-existing `otherId` is now computed once, up front,
  and reused.)

The underlying Match/Conversation docs are still never deleted. This supersedes the
"Deliberately scoped out" note in the Chunk 3 entry below.

**Verification:** 17/17 against the real Atlas dev DB (Joe/Girl), non-destructive
(adds then removes a single block; the get-or-create is idempotent so nothing is
created): baseline all three routes 200; while blocked all three 404 in **both**
directions with the Match + Conversation docs intact; after unblock all three 200
again; no leftover block.

---

## Backend — Report / Block, Chunk 3: blocking wired into existing flows

**Built:** A block now hides the two users from each other across discovery,
match/conversation listings, and live messaging. The rule is applied from one
shared helper, `src/utils/blocks.js`:
- `blockedUserIds(userId)` → de-duped hex ids on either side of a block with the
  user (they blocked, or were blocked).
- `isBlockedBetween(a, b)` → boolean, either direction.

Call sites (all treat a block as mutual in effect — either direction hides both):
- **`GET /discovery`** — blocked ids are added to the existing `$nin` exclusion
  alongside already-swiped ids. Converted to real `ObjectId`s because the discovery
  aggregation's `$match` does not cast query values.
- **`GET /matches`** / **`GET /conversations`** — results are **soft-excluded**
  in memory after the query; the underlying `Match`/`Conversation` (and `Message`)
  documents are deliberately **kept** for moderation/audit and reappear intact when
  the block is lifted. Nothing is deleted.
- **Socket `message:send`** — after the existing conversation-membership re-auth,
  a live `isBlockedBetween` check refuses to send between blocked users (checked per
  message, not cached on connect, so a mid-session block takes effect immediately).

**Deliberately scoped out (flagging):** the spec named only `GET /matches` and
`GET /conversations` for soft-exclusion, so the by-id read endpoints —
`GET /matches/:id`, `GET /conversations/:id/messages`, and
`POST /matches/:id/conversation` — are **not** block-gated in this slice. A blocked
pair is gone from every list and can't exchange new messages, but an already-known
id could still deep-read the stale detail/history. Easy to extend with the same
helper if we want the by-id routes gated too; left out here to stay within the
spec's stated scope.

**Verification:** 31/31 assertions against the local backend + mongod + real
socket.io clients. Baseline (unblocked) discovery/matches/conversations/socket both
directions all work; after Joe blocks Girl, she's gone from Joe's discovery, the
match is gone from **both** users' `/matches`, the thread is gone from **both**
`/conversations`, and socket sends are refused **both** directions — while the
Match and Conversation docs remain in the DB. After unblock, discovery, matches,
conversations, and messaging all reappear and function. Finally a fresh
swipe→match→get-or-create-conversation→socket-send flow (Al/Bella) confirms the
normal non-blocked path is unbroken.

Additionally re-run against the **real Atlas dev DB** with the actual Joe Blog /
Girl Blog accounts once this environment's IP was allowlisted — 27/27, using a
non-destructive harness that snapshots and restores everything it touches
(temporarily removes Joe's swipe so discovery is testable, then re-creates it;
deletes its own smoke messages and restores `conversation.lastMessageAt`; leaves
zero blocks). Post-run inspection confirmed the pair identical to its pre-test
state (same Match + Conversation, both `like` swipes, no blocks).

---

## Backend — Report / Block, Chunk 2: endpoints

**Built:** REST endpoints for reporting and blocking, in `SafetyController.js`,
wired in `routes.js` (all behind `auth`, matching `req.user`/`req.userId`).

- **`POST /users/:id/report`** `{ reason, details? }` → 201 `{ report }`. Rejects
  self-report (400 `CANNOT_REPORT_SELF`) and invalid reason (400 `INVALID_REASON`,
  validated against `Report.REASONS`); unknown target → 404; `details` > 1000 chars
  → 400 via schema validation. Creating a report has **no** side effects on
  matching/discovery/messaging.
- **`POST /users/:id/block`** → 201 (new) / 200 (already blocked) `{ block }`.
  Rejects self-block (400 `CANNOT_BLOCK_SELF`). A duplicate collides on the unique
  index (11000) and is treated as success — idempotent, same pattern as swipe/
  conversation create.
- **`DELETE /users/:id/block`** → 200 `{ message, removed }`. Idempotent — removing
  an absent block still succeeds with `removed:false`.
- **`GET /users/blocked`** → 200 `{ blocked: [{ id, blockedAt, user: { id,
  profile: { name, photos } } }] }`, newest first. Profiles are batch-loaded by
  `userId` (Block refs `User`; profile data lives in the `Profile` collection) and
  only basic fields (`name`, and `photos` mapped to `{ url, isPrimary }`) are
  exposed — no private `discoverySettings`. Registered before the `/users/:id/*`
  routes so the literal path can't be shadowed by an `:id` match.

**Verification:** 19/19 HTTP assertions passed against the local backend + mongod
(real auth via minted access tokens): both self-guards, `INVALID_REASON`, a valid
report persisted with correct fields, 404 on unknown target, over-long details
rejected, block 201-then-200 idempotency with exactly one doc surviving, the
blocked list populated with the blocked user's name + photos, clean DELETE +
idempotent re-DELETE, and the 401 auth guard.

---

## Backend — Report / Block, Chunk 1: models (App Store Guideline 1.2 safety)

**Built:** `Report` and `Block` Mongoose models — the data layer for user
reporting and blocking (spec safety requirement / App Store Guideline 1.2).

- **`Report`** (`src/models/Report.js`): `reporterId` + `reportedUserId` (both
  `ObjectId ref User`, required, directional), `reason` (enum: `inappropriate_photos`,
  `harassment`, `scam_attempt`, `fake_profile`, `underage`, `other`), `details`
  (optional, `maxlength: 1000`), `status` (enum `pending`/`reviewed`/`actioned`/
  `dismissed`, default `pending`), timestamps. No unique index — repeat reports of
  the same user are distinct incidents. The `reason`/`status` enums are exported on
  the model (`Report.REASONS`/`Report.STATUSES`) so the controller's `INVALID_REASON`
  check reuses the schema's list instead of duplicating it.
- **`Block`** (`src/models/Block.js`): `blockerId` + `blockedUserId` (both
  `ObjectId ref User`, required, **directional** — not the canonical sorted pair
  Match uses, since A→B and B→A are distinct facts that can coexist), timestamps.
  Unique compound index on `(blockerId, blockedUserId)`: a repeat block collides
  with code 11000, treated as success by the controller — the same idempotent-by-
  design pattern as Swipe/Match.

**Verification:** Atlas is unreachable from the build environment (its egress IP
isn't on the Atlas Network Access allowlist — TCP connects, TLS handshake rejected
with alert 80), so model-layer smoke tests ran against a local `mongod` seeded to
mirror the Joe/Girl dev accounts. 9/9 assertions passed: default `status=pending`,
enum + `maxlength` + `required` validation, the 11000 collision on a duplicate
block, and reverse-direction blocks allowed.

---

## Mobile — discovery settings (filters) screen

**Built:** A simple filters form for the current user's discovery preferences,
reached from the Discover header, writing to `PUT /profile/discovery-settings`.

- **Screen** (`src/screens/DiscoverySettingsScreen.tsx`): loads the current
  settings from `GET /profile/me` (the owner's `discoverySettings` is returned in
  full — only stripped from *other* users' profiles), prefilling three controls:
  - `showOnlyNinVerified` → a `Switch`.
  - `maxDistanceKm` → number input (digits only), validated `> 0`; defaults to 25.
  - `ageRange` → min/max number inputs, validated `min >= 18` and `min <= max`;
    defaults 18–60 when the profile has never set a range (the schema has no
    default for `ageRange`, unlike the other two fields).
  On save, sends all three fields (backend applies only what's provided; sending
  all keeps saved == form). Success pops back to Discover.
- **NIN reciprocity (403 `NIN_REQUIRED`)**: enabling the NIN-only filter without
  being NIN-verified returns `403 { code: 'NIN_REQUIRED' }` and persists nothing.
  The screen shows a clear inline notice under the toggle explaining the
  requirement and flips the toggle back off (so a follow-up Save still persists
  the distance/age changes). It deliberately does **not** navigate to a
  verification flow — none exists on mobile yet; the notice says it's coming.
- **Navigation** (`src/navigation/{types,RootNavigator}.tsx`): new `AppStack`
  route `DiscoverySettings` (title "Filters"). The Discover (`Home`) header gains
  a ⚙ filter icon in `headerRight`, left of the existing Sign out.
- **API layer**:
  - `src/api/profile.ts` — added `DiscoverySettings` type, `discoverySettings?`
    on `Profile`, and `updateDiscoverySettings()`.
  - `src/api/errors.ts` — `ApiError` now carries the backend's machine-readable
    `code` (populated from the response body), so the screen branches on
    `status === 403 && code === 'NIN_REQUIRED'` instead of matching message text.

**Deviations / limitations:**
- The open Discover deck does **not** re-query when filters change — `DiscoveryScreen`
  only fetches on mount, and returning to it doesn't remount. New filters take
  effect on the next deck load/refresh. Acceptable for this slice; a future pass
  can refresh the deck on focus.
- Numeric fields use plain text inputs (digits-only) rather than a slider/stepper —
  keeps the dependency footprint unchanged, consistent with `ProfileSetupScreen`'s
  dependency-free `dob` input.

**Verification:** Mobile `tsc --noEmit` clean (strict). Not yet run on a device —
handed over for a live run against the backend.

---

## Mobile — profile creation screen + post-sign-in routing (+ gender enum & opposite-sex discovery filter)

**Built:** After sign-in the app now decides where to land by asking the backend
whether the user has a profile, and a form for creating it. Also closes a spec gap
on `gender` (see "Backend" and "Deviations" below).

- **Routing gate** (`src/navigation/RootNavigator.tsx`, `AppFlow`): once
  authenticated, calls `GET /profile/me`. A `404` (no profile) starts the app
  stack on `ProfileSetup`; a `200` starts it on `Home`. While the check runs it
  shows a spinner; a non-404 failure (network/5xx) shows a retriable error screen
  with "Try again" and "Sign out" rather than guessing a destination. Both screens
  live in the `AppStack`; the fetched flag only sets `initialRouteName`. On future
  sign-ins the profile exists → straight to Home.
- **Screen** (`src/screens/ProfileSetupScreen.tsx`): scrollable form for the
  writable fields — `name`, `dob`, `gender`, `lookingFor`, `bio`, `interests`,
  `state`, `lga`. On submit calls `PUT /profile/me` (upsert), then
  `navigation.reset` to `Home` so Back can't return to setup. `ProfileSetup` hides
  the header back button and disables the swipe-back gesture.
  - `gender` → single-select chips restricted to the server enum
    (`male|female`, labelled Woman/Man) — see Backend below.
  - `lookingFor` → single-select chips restricted to the server enum
    (`casual|serious|marriage|friendship`), so an invalid enum can't be sent.
  - `dob` → dependency-free masked text input (`YYYY-MM-DD`, digits auto-dashed),
    validated client-side as a real past date before sending (no native
    date-picker dependency added).
  - `interests` → add/remove tag chips (case-insensitive de-dupe), sent as a
    string array.
  - Client-side required: `name`, `dob`, `gender`, `lookingFor`. Optional fields
    are omitted from the payload when blank (no empty strings stored).
- **API layer** (`src/api/profile.ts`): typed `getMyProfile()` / `updateMyProfile()`
  wrappers plus `parseFieldErrors(ApiError)`.

**Backend — gender enum + opposite-sex discovery filter (product decision):**
- `Profile.gender` gained an enum `['male', 'female']` (`models/Profile.js`). The
  spec (`technical-build-spec.md`) had `gender: String` with **no enum** and no
  `interestedIn`/preference field, and `DiscoveryController` never filtered on
  gender — so gender was collected but unused, and everyone saw everyone. Product
  decision: **opposite-sex matching only.**
- `DiscoveryController.getDiscovery` now derives the match target from the
  requester's **own** gender — `male` sees only `female` profiles and vice versa
  (one `match.gender = opposite` condition on the base query). This also excludes
  candidates with no gender set (can't confirm opposite sex). If the requester has
  no gender yet, no gender filter is applied. Deliberately **no** separate
  `interestedIn`/preference field — the target is derived, not stored.

**Error handling:** Backend `400`s are shown **inline per field**, not as one
generic banner. The central handler returns the raw Mongoose message as
`{ error }`; `parseFieldErrors` handles both shapes — `ValidationError`
(`"… validation failed: <path>: <detail>, …"`, comma-separated) and `CastError`
(`… at path "<field>"`) — and maps each to its form field. Anything it can't
attribute to a known field falls back to a `_form` banner. Local validation errors
use the same per-field mechanism.

**API contract consumed** (matches `ProfileController`):
- `GET /profile/me` → `200` profile, or `404 { error: 'Profile not found' }`.
- `PUT /profile/me` → `200` upserted profile; `400 { error }` on validation/cast.

**Deviations from spec:**
- Added `gender` enum `['male', 'female']` and a gender filter in
  `DiscoveryController` — the spec had neither. Reason: opposite-sex matching is a
  product decision; without this, discovery ignored gender entirely. Match target
  is derived from the user's own gender (no `interestedIn` field) by design.

**Notes:**
- `dob` uses a manual text mask instead of a native date picker to avoid adding
  `@react-native-community/datetimepicker` for this slice; easy to swap later.
- `name`/`dob`/`gender`/`lookingFor` are treated as **required client-side** for a
  usable profile even though the backend requires none — trivially relaxed if the
  product wants a lighter first step.

**Verification:**
- Mobile `tsc --noEmit` clean. The RN screen itself is not yet exercised from a
  device (same live-OTP blocker noted in project memory); wired to the real
  endpoints and ready to run.
- **Discovery filter — live-tested** against a throwaway local `mongod` + the real
  backend (isolated from the Atlas cluster): three users (two men, one woman) via
  the real OTP dev-echo sign-in → `PUT /profile/me` → `GET /discovery`. 8/8 checks
  passed — a man sees only the woman (both men and self excluded), the woman sees
  both men (self excluded), and an invalid `gender` is rejected with `400`.

---

## Photo upload — `POST /profile/photos`, `DELETE /profile/photos/:photoId`

**Built:** Cloudinary-backed profile photo upload and delete.

- `POST /profile/photos` — authenticated, `multipart/form-data`, single file field
  **`photo`**. Streams the file to Cloudinary (memory buffer, no temp file) into
  `sabipesin/profiles/<userId>/`, then appends to the profile's `photos` array.
  First photo on a profile is set `isPrimary: true` automatically. Returns `201`
  with the full profile. Upserts the profile if the user has none yet.
  - Limits: images only (`image/*`), max 5 MB, one file per request.
  - `409` if the profile already has the maximum number of photos.
- `DELETE /profile/photos/:photoId` — `:photoId` is the photo subdocument `_id`.
  Deletes the Cloudinary asset first, then removes the array entry. If the deleted
  photo was primary, the first remaining photo is promoted. Returns `200` with the
  updated profile. `404` if profile or photo not found.

**Model shape** (`Profile.photos[]`):
```
{ url: String, publicId: String, isPrimary: Boolean }   // + auto _id
```

**Error mapping** (central handler): Multer rejections → `400`; Cloudinary
failures (`CloudinaryError`) → `502`.

**Deviations from spec:**
- Added **`publicId`** to each photo subdoc (spec lists only `{ url, isPrimary }`).
  Reason: without the Cloudinary `public_id`, DELETE could only drop the DB row and
  would orphan the asset in Cloudinary. Additive — does not change the spec fields.
- Added a **6-photo cap per profile** (not in the spec). Reason: bound abuse and
  Cloudinary storage; easy to adjust via `MAX_PHOTOS` in `ProfileController`.

**Verification:** Smoke-tested end-to-end against the live SabiPesin Cloudinary
account (`cloud_name: ux66sa0p`) and live MongoDB — upload lands the asset,
`url` + `publicId` persist to the profile, and delete removes both the asset and
the row. (This surfaced a Mongoose 5.7 issue: subdoc `.deleteOne()` doesn't exist
on this version; switched to `array.pull(id)`.)

---

## Discovery settings — `PUT /profile/discovery-settings`

**Built:** The one write path allowed to set `showOnlyNinVerified`, enforcing the
NIN reciprocity rule (spec §4.5). `PUT /profile/me` remains blocked from writing
`discoverySettings`, so the rule can't be bypassed.

- `PUT /profile/discovery-settings` — authenticated. Body: any of
  `showOnlyNinVerified` (bool), `maxDistanceKm` (number > 0), `ageRange`
  (`{ min, max }` numbers). Applies only the provided fields via dot-path `$set`,
  so a partial update preserves the others. Upserts the profile if none exists.
  Returns `200` with the updated profile.
- **Reciprocity rule (§4.5):** if `showOnlyNinVerified: true` is requested and the
  requesting user's `ninVerifiedAt` is null, returns **`403`** with
  `{ error, code: "NIN_REQUIRED" }` and persists nothing — the client routes this
  straight into the NIN verification flow. Setting it can only succeed once the
  user is NIN-verified themselves. `showOnlyNinVerified: false` is always allowed.

**Persisted shape** (`Profile.discoverySettings`, unchanged from spec):
```
{ showOnlyNinVerified: Boolean(default false), maxDistanceKm: Number(default 25),
  ageRange: { min: Number, max: Number } }
```

**Deviations from spec:**
- Added an **18+ floor** on `ageRange.min` (rejects `< 18` with `400`). Not in the
  spec, but a safety baseline for a dating product. Other validation (types,
  `min <= max`, positive distance) is coherence-only.

**Verification:** Smoke-tested against live MongoDB — unverified user gets
`403 NIN_REQUIRED` with nothing persisted; verified user persists `true`;
partial updates preserve prior fields; defaults apply on insert; and the
validation cases (`min < 18`, `min > max`, negative distance, non-boolean, empty
body) all return `400`.

---

## Swipe & match creation — `Swipe` model, `Match` model, `POST /swipes`

**Built:** The `Swipe` and `Match` Mongoose models (spec §3) and the swipe
endpoint that records a swipe and forms a `Match` on a mutual like/superlike.
`GET /discovery` and `GET /matches` are intentionally **not** built yet — this is
just the swipe-and-match-creation slice.

**Models:**
- `Swipe` — `{ actorId, targetId, action: enum('like','pass','superlike') }`.
  Compound **unique** index on `(actorId, targetId)` — one swipe per pair.
- `Match` — `{ userA, userB, matchedAt, status: enum('active','unmatched') }`.
  The pair is stored **canonically** (`userA` = smaller ObjectId by hex string),
  with a compound **unique** index on `(userA, userB)`, so a match between two
  people is a single document regardless of who liked first. A `pre('validate')`
  hook canonicalizes the pair for direct `.create()`/`.save()` callers; the
  controller sorts the pair itself for its upsert (pre-hooks don't fire on
  `findOneAndUpdate`).

**Endpoint** — `POST /swipes` (authenticated). Body: `{ targetId, action }`.
- Validates `action` against the enum, `targetId` as a real ObjectId, rejects
  self-swipes (`400`), and `404`s if the target user doesn't exist.
- Records the swipe via **upsert** on `(actorId, targetId)`, so re-swiping the
  same person updates the action in place (e.g. a prior `pass` → `like`) instead
  of colliding on the unique index — last action wins.
- If the swipe is a `like`/`superlike` **and** the target has already
  liked/superliked the actor, creates the `Match` (upsert on the sorted pair;
  duplicate-key `11000` from a simultaneous mutual like is caught and the existing
  match re-read). A `pass` never forms a match.
- Returns `201` with `{ swipe, isMatch, match }` (`match` is `null` when no match
  formed).

**Deviations from spec:**
- Both models carry `timestamps: true` (adds `createdAt`/`updatedAt`), matching
  every other model in the codebase. The spec lists only `createdAt` on `Swipe`
  and only `matchedAt` on `Match`; the extra timestamps are additive. `matchedAt`
  is kept as the spec's canonical "when the match formed" field.
- `POST /swipes` **upserts** the swipe rather than rejecting a duplicate. Reason:
  lets a user change their mind (pass → like) and makes retries idempotent instead
  of surfacing a raw duplicate-key error. Not specified either way.
- Match creation leaves an existing `unmatched` match untouched (`$setOnInsert`
  only). Re-activation semantics belong with the unmatch feature, which isn't
  built yet.

**Verification:** Smoke-tested end-to-end against live MongoDB (29 assertions,
all passing) via the real controller with mock req/res, temp users cleaned up
after the run:
- Validation: self-swipe, bad `action`, non-ObjectId `targetId` → `400`;
  non-existent target → `404`.
- One-sided like → `201`, `isMatch: false`, no Match document written.
- Reciprocal like → `isMatch: true`, exactly one Match, pair stored canonically
  (`userA` < `userB`), `status: active`.
- **pass → like on the same target:** the pass leaves one swipe row (no match);
  the later like **upserts that same row in place** (still one row, action flips
  `pass → like`) and forms the match. Confirms upsert-on-repeat-swipe as built.
- **Simultaneous mutual like** (two concurrent `POST /swipes`, both directions):
  no throw, both `201`, exactly one Match. The duplicate-key `11000` recovery
  branch itself was additionally forced with two concurrent raw inserts on one
  pair — the loser raises `11000`, and catch-then-refetch returns the single
  surviving match. (`findOneAndUpdate`+upsert resolves the pair server-side and
  rarely surfaces `11000` on its own, so the invariant and the recovery path were
  verified separately.)

---

## Discovery & match listing — `GET /discovery`, `GET /matches`

**Built:** The two read endpoints that complete Phase 4's discovery slice.
`GET /discovery` returns paginated candidate profiles; `GET /matches` returns the
requester's active matches with each participant's verification tier.

**`GET /discovery`** — authenticated. Query: `page` (1-based, default 1), `limit`
(default 20, max 50). Returns `{ page, limit, hasMore, candidates: [...] }`.
Filters applied, all server-side:
- **Excludes self** and **every already-swiped user** — any `Swipe` row from the
  requester (like, pass, *or* superlike), via `Swipe...distinct('targetId')`.
- **Verification filter (spec §4.6):** if the requester's own
  `discoverySettings.showOnlyNinVerified` is `true`, only candidates with
  `ninVerifiedAt` set; otherwise anyone with at least `phoneVerifiedAt` set.
  Incomplete signups (neither timestamp) never appear. Suspended/banned users are
  excluded (`user.status: 'active'`).
- **Geo-distance (spec §4.6):** only when *both* sides have a location. If the
  requester has a location, candidates must be within their `maxDistanceKm`
  (default 25) **or** have no location of their own; candidates with a location
  beyond the radius are dropped. If the requester has no location, no distance
  filter is applied. Implemented with `$geoWithin`/`$centerSphere` (radius =
  `km / 6378.1` radians) inside an `$or` — `$near` can't be used in `$or` and would
  wrongly drop locationless candidates.
- Each candidate is returned with a small `user` summary
  (`{ id, verificationTier, phoneVerifiedAt, ninVerifiedAt }`) for the badge, and
  the candidate's own private `discoverySettings` are **stripped**.
- Implemented as a single `Profile.aggregate` (`$match` → `$lookup` users →
  `$unwind` → `$match` verification/status → `$sort` → `$skip`/`$limit`) so the
  cross-collection verification filter paginates correctly in one query.
  `hasMore` is computed by fetching `limit + 1` rows (no second count query).

**`GET /matches`** — authenticated. Returns
`{ viewerVerificationTier, matches: [...] }`, newest first, `status: 'active'`
only. Each match: `{ id, matchedAt, status, otherUser: { id, verificationTier,
profile } }`. Per **spec §4.7**, the derived `verificationTier` is always present
(even when `null`) for both the other participant *and* the viewer — never hidden.
The other user's profile is included (with their `discoverySettings` stripped).
Users are loaded hydrated so the model's `verificationTier` virtual runs; users
and profiles are batch-loaded (`$in`) and indexed by id for assembly.

**`GET /matches/:id`** — authenticated. Returns `{ viewerVerificationTier, match }`
where `match` is the same shape as one entry of `GET /matches` (other
participant's `verificationTier` included, §4.7, plus the viewer's own tier). The
lookup is **scoped to the requester** (`_id: id` AND `userA/userB` is the
requester), so a match that doesn't exist *or* isn't one of the requester's both
return **`404`** — deliberately indistinguishable, so the endpoint can't be used
to probe whether an arbitrary match id exists. A malformed (non-ObjectId) `:id`
also `404`s rather than surfacing a cast error. Unlike the list, the detail route
is **not** restricted to `status: 'active'` — a participant can still read a match
that was later `unmatched` (its `status` is in the payload). The list-shaping
logic is shared with `GET /matches` via an internal `shapeMatch` helper.

**New files:**
- `src/controllers/DiscoveryController.js`, `src/controllers/MatchController.js`
- `src/utils/verificationTier.js` — derives the tier from a plain object (the
  aggregation results aren't hydrated docs, so the model virtual can't run there).
  Mirrors the `User.verificationTier` virtual; both cite spec §3/§4.7.

**Deviations from spec:**
- Pagination shape (`page`/`limit`/`hasMore`) and the `limit` cap of 50 are not
  specified — sensible defaults.
- Candidate/other-user `discoverySettings` are stripped from responses (a privacy
  choice, not spec-mandated).
- `GET /matches/:id` returns a match in any `status` (including `unmatched`) as
  long as it belongs to the requester; the spec doesn't state a status filter for
  the detail route, and hiding an unmatched match behind a `404` would be
  surprising for a direct fetch.

**Verification:** Smoke-tested end-to-end against live MongoDB (25 assertions, all
passing) via the real controllers with mock req/res, temp data cleaned up after:
- Default discovery includes phone- and NIN-verified near candidates and a
  no-location candidate; excludes the far candidate (>25km), the unverified user,
  the suspended user, the already-swiped user, and self; strips `discoverySettings`
  and carries each candidate's `verificationTier`.
- `showOnlyNinVerified: true` narrows results to NIN-verified candidates only.
- A requester with **no location** sees the far candidate (distance filter skipped).
- `limit=2` returns 2 with `hasMore: true` and echoes `page`/`limit`.
- `GET /matches` lists one active match with `otherUser.verificationTier: 'nin'`,
  the other user's profile (discoverySettings stripped), and
  `viewerVerificationTier: 'phone'`; an `unmatched` match is not listed.

Separately smoke-tested `GET /matches/:id` (12 assertions, all passing, temp data
cleaned up):
- Own match → `200` with the requested match, the other participant as `otherUser`,
  their `verificationTier: 'nin'`, profile included (discoverySettings stripped),
  and `viewerVerificationTier: 'phone'`.
- Symmetry: the other participant fetching the same match sees the first user as
  `otherUser`, and `viewerVerificationTier` reflects whoever is fetching (`'nin'`).
- Foreign match (requester not a participant) → `404`; non-existent id → `404`;
  malformed (non-ObjectId) id → `404` (not a `500` cast error).

---

## Messaging data layer — `GET /conversations`, `GET /conversations/:id/messages`

**Built:** Phase 5's data layer and its two read endpoints (spec §3, §6). The
`Conversation` and `Message` models, plus listing a user's conversations and
paginating one conversation's messages. **Socket.IO and the anti-scam keyword
flagging are deliberately NOT in this slice** — only the models and the two read
endpoints. The `flagged` field exists now so the schema is stable before that
filter lands (spec §8.5).

**Models:**
- `Conversation` — `matchId` (ref `Match`, **unique** — one conversation per
  match), `participants: [ObjectId ref User]`, `lastMessageAt` (defaults to
  creation time; bumped per message later), plus `timestamps`. Index on
  `participants` for the "my conversations" membership query. `participants` is
  denormalised from the match so listing is one indexed query, no join back
  through `Match`.
- `Message` — `conversationId` (ref `Conversation`, indexed), `senderId`
  (ref `User`), `text: String`, `flagged: Boolean` (**default `false`** — the
  anti-scam filter will set `true` later), `readAt: Date` (**default `null`** —
  set by the future `read` event; nothing writes it yet), plus `timestamps`.
  Compound index `(conversationId, createdAt: -1)` serves the filter + newest-first
  sort in one.

**`GET /conversations`** — authenticated. Returns
`{ viewerVerificationTier, conversations: [...] }`, sorted by `lastMessageAt`
newest-first. Each entry: `{ id, matchId, lastMessageAt, otherUser: { id,
verificationTier, profile } }`. Mirrors `GET /matches`: the other participant is
resolved with their derived `verificationTier` (spec §4.7 — the chat screen shows
the badge, always present even when `null`) and public profile
(`discoverySettings` stripped); users and profiles are batch-loaded (`$in`) and
indexed by id for O(1) assembly.

**`GET /conversations/:id/messages`** — authenticated, **paginated**
(`?page`/`?limit`, `page` 1-based; `limit` defaults to 30, capped at 100).
Returns `{ page, limit, hasMore, messages: [...] }` with messages **newest-first**
(`createdAt: -1, _id: -1` tiebreak), each shaped as `{ id, conversationId,
senderId, text, flagged, readAt, createdAt }`. `hasMore` is computed by fetching
`limit + 1` rows (no second count query), same trick as discovery. The lookup is
**scoped to the requester** (`_id: id` AND `participants: me`), so a conversation
that doesn't exist *or* isn't one the requester participates in both return
**`404`** — deliberately indistinguishable, so the endpoint can't probe whether an
arbitrary conversation id exists (same posture as `GET /matches/:id`). A malformed
(non-ObjectId) `:id` also `404`s rather than surfacing a cast error. Pure read —
nothing sets `readAt` here.

**New files:**
- `src/models/Conversation.js`, `src/models/Message.js`
- `src/controllers/ConversationController.js`

**Deviations from spec:**
- Pagination shape (`page`/`limit`/`hasMore`) and the message `limit` default of 30
  / cap of 100 are not specified — sensible defaults, consistent with discovery.
- `GET /conversations` enriches each row with the other participant's
  `verificationTier` + public profile (a privacy-stripped, §4.7-consistent
  convenience for rendering the chat list) rather than returning the raw
  `participants` id array; not spec-mandated.
- Added an index on `Conversation.participants` (not in the spec) to back the
  membership query.

**Verification:** Smoke-tested end-to-end against live MongoDB (25 assertions, all
passing) via the real controllers with mock req/res, temp data cleaned up after.
Seed: 4 users (A phone-verified, B NIN-verified, C an outsider, D), two of A's
conversations (A-B and A-D) off real matches, and 5 messages in A-B with distinct
`createdAt`s (one `flagged`).
- `GET /conversations` (as A): returns both conversations sorted by
  `lastMessageAt` desc; the other participant is resolved (B, not self) with
  `verificationTier: 'nin'` and profile included, `discoverySettings` **stripped**;
  `viewerVerificationTier: 'phone'`. Outsider C sees an empty list.
- `GET /conversations/:id/messages` **404 scoping** — non-participant C → `404`
  (the key test), valid-but-non-existent id → `404`, malformed (non-ObjectId)
  id → `404` (not a `500` cast error).
- `GET /conversations/:id/messages` **pagination** — with `limit=2`: page 1 =
  `msg-4,msg-3` (newest-first) `hasMore: true`, page 2 = `msg-2,msg-1`
  `hasMore: true`, page 3 = `msg-0` `hasMore: false` (no overflow row); no overlap
  across pages. `flagged: true` round-trips on `msg-2`; message shape carries
  `flagged`/`readAt`/`createdAt`/`senderId`. Participant B reads all 5 at the
  default limit; the empty conversation A-D → `200` with 0 messages,
  `hasMore: false`.

Schema shapes were also asserted directly: `Message.flagged` defaults to `false`,
`Message.readAt` to `null`, `Conversation.matchId` is `unique`.

---

## Messaging real-time layer — Socket.IO + anti-scam flagging

**Built:** The rest of Phase 5 (spec §6, §8.5): Socket.IO wired onto the same HTTP
port as the REST API, the four messaging events, and the anti-scam keyword filter
that flags (never blocks) money-request messages.

**Server wiring** (`src/server.js`): Express is now wrapped in a raw
`http.createServer(app)` so Socket.IO can share the port; `server.listen` is
unchanged. A `Server` is attached with `cors: { origin: '*' }` (matches the
existing permissive REST CORS — tighten both before production) and handed to
`initSocket`.

**Connection auth** (`src/socket/index.js`): an `io.use` handshake middleware
mirrors the HTTP `auth` middleware — it reads the access token from
`handshake.auth.token` **or** a `Bearer` Authorization header, verifies it,
loads the user, and rejects missing/invalid tokens and non-`active` accounts. An
authenticated socket joins a room named after its `userId`, so delivering to a
user is `io.to(userId).emit(...)`: it fans out to all their open devices and is a
no-op when they're offline.

**Events** (`src/socket/messageHandlers.js`) — every handler re-authorizes against
conversation membership on each call (an authenticated socket ≠ access to a
thread), reusing the same 404-scoping posture as the REST endpoints (missing,
malformed, and foreign conversation ids are indistinguishable):
- `message:send` `{ conversationId, text }` → trims text (rejects empty), scans it
  for scam keywords, creates the `Message` (with `flagged`), bumps the
  conversation's `lastMessageAt` to the new message's `createdAt`, and emits
  `message:receive` to the **other** participant's room. The optional ack echoes
  the stored message (id, server timestamp, `flagged` verdict) back to the sender;
  the message is **not** echoed to the sender via `message:receive`.
- `typing` `{ conversationId, isTyping }` → fire-and-forget relay to the other
  participant; not persisted, no ack.
- `read` `{ conversationId }` → sets `readAt = now` on the **peer's** unread
  messages to me (`senderId ≠ me, readAt: null`) via `updateMany`, emits `read`
  `{ conversationId, readerId, readAt }` to the peer, and acks the updated count.
  This is the first writer of `Message.readAt` (the REST endpoints left it null).

**Anti-scam filter** (`src/utils/antiScam.js`, spec §8.5): `isScammy(text)` — a
case-insensitive, whitespace-tolerant set of money-request keyword patterns (send
money, gift card, wire transfer, bank/account details, western union / moneygram,
BVN / NUBAN, crypto) plus a heuristic that flags any run of 10+ digits (a
Nigerian NUBAN account number). A trip only sets `flagged: true`; it never blocks
or edits the message. Because flagging is non-destructive, the heuristics
deliberately favour recall over precision.

**New files:**
- `src/socket/index.js`, `src/socket/messageHandlers.js`
- `src/utils/antiScam.js`

**Dependencies:** added `socket.io` (^4.8.3).

**Deviations from spec:**
- The socket contract (payload shapes, ack callbacks, room-per-user delivery) is
  not specified beyond the four event names — these are sensible, REST-consistent
  choices. `message:send`'s ack echoes the stored message so the sender gets the
  server id/timestamp/`flagged` verdict without a refetch.
- The 10+-digit account-number heuristic can also trip on a pasted phone number.
  Accepted: flagging never blocks, so a false positive only shows the standing
  safety banner.
- `read` marks the whole thread read (not per-message ids) — matches the mockup's
  "opened the chat" semantics; per-message receipts can be added later if needed.

**Verification:** Smoke-tested end-to-end against live MongoDB (24 assertions, all
passing) by driving the real handlers and the real `initSocket` auth middleware
with a mock `io`/`socket` (same approach as the data-layer entry), temp data
cleaned up after. Seed: users A (phone-verified), B (NIN-verified), C (outsider),
a suspended user, a real A-B match and conversation.
- `message:send` (as A): clean text → ack ok, `flagged: false`, message persisted
  with sender+text, `message:receive` delivered to **B only** (not echoed to A),
  `lastMessageAt` bumped to the new message's `createdAt`. Scam text
  (`"send me money via gift card 0123456789"`) → `flagged: true`, still delivered
  (not blocked). Empty/whitespace text → negative ack, no message created.
  Non-participant C and a malformed conversation id → negative ack, no message,
  no cast crash.
- `typing` → relayed to B with `userId` + `isTyping`; non-participant emits nothing.
- `read` (as B) → A's two messages get `readAt` set, ack `updated: 2`, `read`
  receipt emitted to A with `readerId: B`.
- Handshake auth: valid token (via `auth.token` and via `Bearer` header) accepted;
  missing token, garbage token, and a suspended user all rejected.
- The 14-case `isScammy` unit table (send money / gift card / wire transfer /
  bank account digits / BVN / bitcoin / western union, and clean-message
  negatives) also passes.

---

## NIN + selfie verification (start) — `POST /verification/nin/start`

**Built:** The kickoff half of the QoreID KYC integration (Phase 5). Starts a NIN
+ selfie verification session and records a pending `Verification`. The vendor
webhook that actually sets `user.ninVerifiedAt` is a **separate, later slice** —
deliberately not built here.

- `POST /verification/nin/start` — authenticated, no body. Mints a QoreID
  verification session for the caller and returns what the client needs to
  continue on-device:
  ```json
  { "message": "...", "provider": "qoreid", "sessionId": "...",
    "sdkSessionToken": "...", "expiresAt": "...", "mock": false }
  ```
  `sdkSessionToken` is the JWT the QoreID SDK uses to run the NIN lookup + selfie
  liveness capture; `sessionId` is stored as the Verification's `providerRef` so
  the webhook can later resolve the result back to the row.
  - Creates a pending `Verification` with `type: 'nin_selfie'`, `status:
    'pending'`, `provider: 'qoreid'` (spec §3, §6), stamping `expiresAt` from the
    session's expiry.
  - Supersedes any earlier `pending` `nin_selfie` rows for the user to `failed`
    (only one live session at a time — mirrors the OTP supersede in
    `AuthController`).
  - `409` if the user is already NIN-verified (`ninVerifiedAt` set) — nothing to do.

- `src/services/qoreid.js` — new service, same shape as `termii.js`/`cloudinary.js`:
  a `QoreIdError` (matched by name in `errorHandler` → `502`) and
  `startNinVerification({ reference, subjectRef })`. Live path:
  `POST {QOREID_BASE_URL}/v1/sessions` with HTTP Basic auth
  (`base64(clientId:secret)`) and an `Idempotency-Key`, per QoreID's session API.
  Returns `{ sessionId, sdkSessionToken, expiresAt, productCode, mock }`.

- **`QOREID_ENABLED` dev-mode toggle** (the todo-list item). When not `'true'`
  (the dev default), the service skips the vendor entirely and returns a
  well-formed **mocked** session (`mock: true`), so the client flow and the
  pending-record write can be exercised locally without a real (billable) call.
  Mirrors CraftRanked's `QOREID_ENABLED=false` pattern. Set `QOREID_ENABLED=true`
  with sandbox/production credentials to run live.

**New files:**
- `src/services/qoreid.js`
- `src/controllers/VerificationController.js`

**Env:** added `QOREID_ENABLED`, `QOREID_BASE_URL`, `QOREID_NIN_PRODUCT_CODE`,
`QOREID_SESSION_TTL_SECONDS`, `QOREID_SESSION_MAX_ATTEMPTS` to `.env.example`
(alongside the spec's `QOREID_CLIENT_ID`/`QOREID_SECRET`/`QOREID_WEBHOOK_SECRET`).

**Deviations from / additions to spec:**
- The spec (§6) names the route and its purpose ("kicks off KYC vendor session")
  but not the response shape — the session-token payload above is a sensible,
  vendor-driven choice. QoreID's session flow returns an SDK token the client
  runs the capture with, rather than a redirect URL.
- `QOREID_ENABLED` and the session tuning vars aren't in the spec's §1 env list —
  added per the todo-list "QoreID dev-mode toggle" item.
- `productCode` for the NIN-face-match session isn't nailed down in QoreID's
  public sandbox docs, so it's env-configurable (`QOREID_NIN_PRODUCT_CODE`,
  default `nin_face_match`) rather than hardcoded — confirm against the sandbox
  dashboard when live credentials land.
- Webhook (`POST /verification/nin/webhook`) and `GET /verification/status`
  (both spec §6) are intentionally out of scope for this slice.

**Verification:** Exercised the service in isolation (no DB/network needed):
- Dev mode (`QOREID_ENABLED=false`) → returns `mock: true` with
  `mock_sess_`/`mock_sdk_` ids and a future `expiresAt`; no HTTP call made.
- Enabled without credentials → throws `QoreIdError` with the actionable
  "set QOREID_ENABLED=false for dev mode" message (→ `502`).
- `routes.js` loads and registers `POST /verification/nin/start`.
Full request-path (auth → pending row written → 409-when-verified) not yet
smoke-tested against live MongoDB — worth a run alongside the webhook slice.

## Verification status — `GET /verification/status`

**Built:** The read-only status endpoint (spec §6). Returns the authenticated
user's current verification state; makes **no QoreID call** — it only reads what
the phone-OTP verify and the NIN start/webhook slices have already persisted.

- `GET /verification/status` — authenticated, no body. Response:
  ```json
  { "phoneVerifiedAt": "...", "ninVerifiedAt": null,
    "verificationTier": "phone",
    "pendingNinVerification": { "status": "pending", "expiresAt": "..." } }
  ```
  - `phoneVerifiedAt` / `ninVerifiedAt` come straight off the authenticated
    `User` (loaded by the auth middleware).
  - `verificationTier` is the derived value (`ninVerifiedAt ? 'nin' :
    phoneVerifiedAt ? 'phone' : null`), read from the `User.verificationTier`
    virtual (spec §3, §4.7) — never stored.
  - `pendingNinVerification` is the newest `pending` `nin_selfie` `Verification`
    row's `status` + `expiresAt`, or `null` when there's no in-flight attempt.
    `startNin` supersedes older pending rows so there's at most one, but the query
    sorts by newest `createdAt` defensively and `.select`s only the two fields.

- `src/controllers/VerificationController.js` — added `getStatus`.
- `routes.js` — registered `GET /verification/status` (authenticated).

**Deviations from / additions to spec:**
- The spec (§6) names the route but not the response shape. The three top-level
  fields are spec-named (§6); `pendingNinVerification` is nested (rather than
  flattened) so the two Verification-row fields are clearly grouped and the key is
  simply `null` when nothing is in flight.

**Verification:** Live smoke test against real MongoDB (server on `:3333`, four
seeded users, real minted access tokens, actual HTTP `GET /verification/status`,
test data cleaned up afterwards). All four branches returned `HTTP 200`:

| Case | verificationTier | ninVerifiedAt | pendingNinVerification |
| --- | --- | --- | --- |
| phone-only verified | `phone` | `null` | `null` |
| NIN verified | `nin` | set | `null` |
| pending NIN in flight | `phone` | `null` | `{ status: 'pending', expiresAt }` |
| no pending NIN | `phone` | `null` | `null` |

The read path reuses the auth middleware's already-loaded `User` (so
`phoneVerifiedAt`/`ninVerifiedAt`/`verificationTier` need no extra query) plus a
single lean, projected `Verification.findOne`.


## Phase 6 (payments) — Subscription & Transaction models + `GET /subscriptions/me`

**Built:** The data layer for payments (spec §3, §7) and the single read
endpoint that exposes a user's plan. **No** Paystack/StoreKit integration,
payment initialization, verify, or webhook in this slice — deliberately just the
models and the read path.

- `src/models/Subscription.js` — one row per user (`userId` unique). Fields per
  spec §3: `plan` (`free`/`unlimited`, default `free`), `status`
  (`active`/`cancelled`/`expired`, default `active`), `paymentPlatform`
  (`ios_iap`/`paystack`), `paystackSubscriptionCode`, `iosOriginalTransactionId`,
  `currentPeriodEnd`. `timestamps: true` supplies `createdAt`/`updatedAt`.
- `src/models/Transaction.js` — one-off purchases (many rows per user). Fields
  per spec §3: `type` (`boost`/`superlike`, required), `paymentPlatform`,
  `amountKobo`, `paystackReference` (**unique + sparse**), `iosTransactionId`
  (**unique + sparse**), `status` (`pending`/`success`/`failed`, default
  `pending`). Sparse is load-bearing: the many rows without a reference for a
  given platform must not collide on `null` under the unique index.
- `src/controllers/SubscriptionController.js` — `getMe`. Reads the caller's
  Subscription (lean, projected to `plan status paymentPlatform
  currentPeriodEnd`) and returns it; when there's **no row**, returns the free
  default (`plan: 'free'`, `status: 'active'`, `paymentPlatform: null`,
  `currentPeriodEnd: null`). No free-tier row is written on signup — absence
  *is* the free state.
- `routes.js` — registered `GET /subscriptions/me` (authenticated).

**Response shape (`GET /subscriptions/me`):**
```json
{ "plan": "free", "status": "active",
  "paymentPlatform": null, "currentPeriodEnd": null }
```

**Deviations from / additions to spec:**
- The spec (§6) names the route but not the response shape; the four returned
  fields are all spec §3 Subscription fields. The default-when-absent behaviour
  (free plan, no row written) was called out in the task and matches §7's model
  where a user is on the free tier until they actively subscribe.
- For a defaulted (no-row) response, `status: 'active'` means "the free tier is
  in effect," not a paid subscription — it mirrors the schema default so a
  defaulted response and a real free-tier row read identically.

**Verification:** Module smoke-load with `.env` present — Subscription,
Transaction, SubscriptionController, and routes.js all require cleanly and the
route registers. Index dump confirmed: `Subscription { userId: 1 } unique`;
`Transaction { paystackReference: 1 } unique+sparse` and `{ iosTransactionId: 1 }
unique+sparse`.

Live request-path smoke test against real MongoDB (throwaway harness booting the
real `routes.js` on port `3339`, two seeded users, real minted access tokens,
actual HTTP `GET /subscriptions/me`, all seeded docs deleted afterwards —
confirmed 0 leftover). Both cases returned `HTTP 200`:

| Case | Seeded state | Response body |
| --- | --- | --- |
| default (no Subscription row) | user only, no sub | `{ plan: 'free', status: 'active', paymentPlatform: null, currentPeriodEnd: null }` |
| real non-free row | `plan: unlimited`, `status: active`, `paymentPlatform: paystack`, `paystackSubscriptionCode`, `currentPeriodEnd: 2026-12-31` | `{ plan: 'unlimited', status: 'active', paymentPlatform: 'paystack', currentPeriodEnd: '2026-12-31T00:00:00.000Z' }` |

This proves the endpoint reads real persisted data (the unlimited/paystack row
round-trips field-for-field) and does **not** always fall back to the free
default — the two cases return distinct bodies. `paystackSubscriptionCode` is
stored but intentionally not projected into the response (only the four §3
plan-state fields are returned).

---

## Phase 6 (payments) — Paystack subscription init — `POST /subscriptions/subscribe/paystack`

**Built:** The Android/web/PWA path for starting an "Unlimited" subscription
(spec §5, §6, §7): a `paystack.js` service and an authenticated endpoint that
initializes a Paystack transaction and returns the hosted-checkout
`authorizationUrl`. **No** Subscription row is created or updated here, and the
webhook is a separate later slice — this slice only opens checkout.

> **⚠ LAUNCH BLOCKER — receipts break for real payments.** Paystack requires an
> email and mails the payment **receipt** to it, but accounts are phone-only
> (spec §3), so we synthesize a placeholder (`{phone}@users.sabipesin.com`).
> That means **real payers never receive a receipt.** This must be resolved
> before Paystack goes live — *not* just before this feature ships. Fix is its
> own email-capture slice (optional `Profile.email` + a write path); the
> read-side seam is already in `subscribeWithPaystack`
> (`profile?.email || synthesized`). Tracked in `sabipesin-todo-list.md`.

- `src/services/paystack.js` — same shape as `termii.js`/`qoreid.js`/
  `cloudinary.js`. `initializeSubscriptionTransaction({ email, reference,
  metadata })` calls `POST {PAYSTACK_BASE_URL}/transaction/initialize` with a
  `Bearer` secret key and resolves to
  `{ authorizationUrl, accessCode, reference, amount, plan, raw }`. Validates
  Paystack's `{ status, message, data }` envelope; a non-`true` status or a
  missing `authorization_url` throws `PaystackError`. Raw axios/network failures
  are also wrapped as `PaystackError`.
- `src/controllers/SubscriptionController.js` — `subscribeWithPaystack`:
  generates an idempotent `reference` (UUID), synthesizes the Paystack-required
  `email` from the phone-only account, passes `metadata: { userId, plan:
  'unlimited', paymentPlatform: 'paystack' }` for later webhook reconciliation,
  and returns `201 { message, authorizationUrl, accessCode, reference }`.
  Read-only guard: `409` if the caller already has an active `unlimited` row.
- `src/routes.js` — registered `POST /subscriptions/subscribe/paystack` (auth).
- `src/middlewares/errorHandler.js` — `PaystackError` → `502` (mirrors
  Termii/QoreID/Cloudinary mapping).

**Config (env):** `PAYSTACK_SECRET_KEY` (required; fail-fast at boot),
`PAYSTACK_BASE_URL` (default `https://api.paystack.co`),
`PAYSTACK_UNLIMITED_AMOUNT_KOBO` (placeholder `500000` = ₦5,000),
`PAYSTACK_UNLIMITED_PLAN_CODE` (optional `PLN_…`; when set, initializes against a
dashboard Plan so Paystack manages recurring billing — amount then comes from the
plan), `PAYSTACK_CALLBACK_URL` (optional web redirect).

**Response shape:**
```json
{ "message": "Paystack transaction initialized",
  "authorizationUrl": "https://checkout.paystack.com/…",
  "accessCode": "…", "reference": "…" }
```

**Deviations from / additions to spec:**
- **No dev-mode toggle** (unlike `qoreid.js`'s `QOREID_ENABLED`): Paystack's
  `sk_test_`/`pk_test_` keys *are* the sandbox — test calls are free and safe, so
  we always hit the real API and let the key decide test vs. live.
- **Synthesized email** (`{phone}@users.sabipesin.com`): Paystack requires an
  email but spec §3 `User` is phone-only. Stable + well-formed so a user maps to
  a stable Paystack customer. **This is the launch blocker called out above** —
  see the callout and `sabipesin-todo-list.md`, not just a passing TODO.
- **Amount is a placeholder** — the final naira price is still open (spec §9).
  Set `PAYSTACK_UNLIMITED_AMOUNT_KOBO`, or a `PAYSTACK_UNLIMITED_PLAN_CODE`,
  before launch.
- **No persistence** by design: the plan is activated only by the
  signature-verified webhook. `metadata`/`reference` carry the mapping so no
  pre-created DB row is needed.

**Verification:** Genuine live call against Paystack's **sandbox** with the real
`sk_test_` key from `.env` (throwaway harness, since removed). `POST
/transaction/initialize` returned `HTTP 200` with a real hosted-checkout URL
(`https://checkout.paystack.com/…`), an `access_code`, and our `reference` echoed
back verbatim — confirming the request is well-formed and the envelope parsing is
correct. Also smoke-loaded the controller, service, error handler, and
`routes.js`: all require cleanly and the `POST /subscriptions/subscribe/paystack`
route is registered.

---

## Phase 6 (payments) — Paystack webhook — `POST /payments/webhook/paystack`

**Built:** The server-to-server callback that actually activates a paid plan
(spec §5, §6, §7). This is the counterpart to the subscribe-init slice: init
opens Paystack checkout and persists nothing; this webhook is the **only** path
that writes a paid `Subscription` row, and only after verifying the request
genuinely came from Paystack. On a signature-verified `charge.success` it
creates-or-updates the user's single Subscription to `plan: 'unlimited', status:
'active', paymentPlatform: 'paystack'`, sets `currentPeriodEnd` 30 days out, and
records `paystackSubscriptionCode` when present. Idempotent against Paystack's
retries so a redelivered charge never double-activates or double-extends.

- `src/controllers/PaymentsController.js` (new) — `paystackWebhook`. New
  controller because `/payments/webhook/*` is its own namespace distinct from the
  authenticated `/subscriptions/*` endpoints, and it'll grow the Apple
  (App Store Server Notifications v2) handler next. Flow: (1) verify signature →
  `401` on failure, before trusting any field; (2) ignore every event type but
  `charge.success`, acking `200` so Paystack stops retrying unhandled events;
  (3) pull our planted `metadata` (`userId`, `paymentPlatform`) + `data.reference`
  and bail to `200` if the charge can't be mapped to our flow; (4) idempotent
  upsert of the Subscription row.
- `src/services/paystack.js` — added `verifyWebhookSignature(rawBody, signature)`.
  Recomputes `HMAC-SHA512(rawBody)` keyed by `PAYSTACK_SECRET_KEY` and
  constant-time-compares (`crypto.timingSafeEqual`) against the
  `x-paystack-signature` header. Returns `false` on any missing input or a
  length/content mismatch. Lives in the service (not the controller) to keep the
  secret-handling in one place, mirroring `initializeSubscriptionTransaction`.
- `src/server.js` — `express.json({ verify })` now stashes the raw body bytes on
  `req.rawBody`. The signature is computed over the exact bytes Paystack sent;
  re-serializing the parsed object would change whitespace/key order and break
  verification, so the buffer is captured before parsing discards it.
- `src/models/Subscription.js` — added `paystackLastReference` (String): the
  charge reference that last activated/renewed the row, used as the webhook's
  idempotency key.
- `src/routes.js` — registered `POST /payments/webhook/paystack`. **No `auth`
  middleware** — Paystack has no JWT; trust comes from the signature check.

**Idempotency (the subtle part):** the upsert filter is
`{ userId, paystackLastReference: { $ne: reference } }`. A retry of an
already-applied charge matches no document, so `upsert` attempts an INSERT and
hits the unique `userId` index — that `E11000` collision *is* the idempotency
signal (charge already applied), so it's caught and swallowed. This is what stops
a retry from pushing `currentPeriodEnd` out another 30 days. A genuinely new
checkout carries a new `reference`, matches the existing row (or inserts the
first one), and legitimately renews. The whole apply is a single atomic
`findOneAndUpdate`, so concurrent duplicate deliveries can't both win.

**Response shape:** `200 { "received": true }` for anything accepted or
intentionally ignored (so Paystack stops retrying); `401 { "error": "Invalid
signature" }` for an unsigned/forged request.

**Deviations from / additions to spec:**
- **Route path** is `POST /payments/webhook/paystack` (spec §6), not the
  `POST /payments/webhook` mentioned in the §5 prose — the §6 route table is the
  canonical one and already splits Paystack vs. Apple.
- **Fixed 30-day period** rather than a real recurring `next_payment_date`:
  there's no dashboard Plan yet (spec §9 pricing is open). `currentPeriodEnd`
  should switch to the subscription's `next_payment_date` once a `PLN_…` Plan
  drives billing.
- **New `paystackLastReference` field** on `Subscription` (not in the §3 model) —
  needed as the idempotency key; the model had no per-charge reference.

**Verification:** Genuine live test against the running server + real MongoDB,
driving the full stack (raw-body capture → route → signature verify → DB write)
with correctly-computed signatures (throwaway harness, since removed). 14/14
assertions passed: (T1) a valid `charge.success` returns `200` and creates the
row with `plan/status/paymentPlatform` set, `paystackLastReference` recorded, and
`currentPeriodEnd` exactly 30 days out; (T2) a well-formed-but-wrong signature →
`401`; (T3) a missing `x-paystack-signature` header → `401`; (T4) a duplicate
delivery of the same charge → `200`, still exactly one row, and
`currentPeriodEnd` unchanged (idempotent — no double-extension); (T5) a
`charge.failed` event → `200` with no Subscription created. Test rows cleaned up
afterward.

---

## One-off purchases (Paystack) — `POST /purchases/boost/paystack`, `POST /purchases/superlike/paystack`

**Built:** The Paystack (Android/web) path for one-off purchases — profile boost
and super like (spec §6) — plus the webhook branch that settles them.

- **`POST /purchases/boost/paystack`** and **`POST /purchases/superlike/paystack`**
  — authenticated. Both share one controller helper and differ only in `type` and
  price. Each initializes a one-off Paystack transaction, then persists a
  **`pending`** `Transaction` (`type` `'boost'|'superlike'`, `paymentPlatform:
  'paystack'`, `amountKobo`, `paystackReference` = our reference) and returns
  `201 { message, authorizationUrl, accessCode, reference }`. Nothing is *granted*
  here — the row flips to `success` only via the signature-verified webhook (spec
  §5 — never trust a client-reported purchase). The `pending` row is written
  **after** a successful init, so a failed init (→ 502) leaves no orphan row.
- **`POST /payments/webhook/paystack`** (extended) — on `charge.success` it now
  **routes on the metadata `type`**: a `'boost'|'superlike'` charge settles the
  matching `Transaction`; anything else is the subscription flow and activates the
  `Subscription` (unchanged). Exactly one branch owns Transaction-vs-Subscription.

**New service function** (`src/services/paystack.js`): `initializeOneOffTransaction
({ email, amount, reference, metadata })` — a generic one-off charge (never
attaches a `plan`; caller supplies the exact kobo amount). The shared HTTP call +
error mapping + success-envelope validation were extracted into a private
`initializeTransaction(payload)` helper that both `initializeSubscriptionTransaction`
and `initializeOneOffTransaction` call, so there's no duplicated axios/validation.

**New files:** `src/controllers/PurchasesController.js`.

**Idempotency (same approach as the subscription webhook):** the charge
`reference` is the idempotency key. The settle is a single atomic
`Transaction.findOneAndUpdate({ paystackReference: reference, status: 'pending' },
{ $set: { status: 'success' } })`. A duplicate delivery of an already-settled
charge (or an unknown reference) matches the `status: 'pending'` filter on nothing
→ harmless no-op; concurrent duplicate deliveries can't both win. (An
update-only, not upsert: the `pending` row is always created at init, before the
payer can complete checkout, so the webhook is guaranteed a row to match.)

**Deviations from / additions to spec:**
- **Route paths** use the spec §6 route-table form with the `/paystack` suffix
  (`/purchases/boost/paystack`, `/purchases/superlike/paystack`) — consistent with
  the existing `/subscriptions/subscribe/paystack` and leaving room for the
  `/purchases/{type}/ios/verify` StoreKit counterparts (§6, later slice).
- **New env `PAYSTACK_BOOST_AMOUNT_KOBO` / `PAYSTACK_SUPERLIKE_AMOUNT_KOBO`**
  (placeholders ₦1,500 / ₦500) — boost/super-like pricing is still open (spec §9),
  mirroring the `PAYSTACK_UNLIMITED_AMOUNT_KOBO` placeholder pattern.
- **Genericized the Paystack `502` message** ("Could not start the payment…") since
  it now also covers purchase inits, not just the subscription.

**Verification:** Genuine live test — real Express app (with raw-body capture) +
real MongoDB + real Paystack **test** API for both init calls, correctly-signed
webhooks (throwaway harness, since removed). 19/19 assertions passed: (T1) boost
init → `201` with `authorizationUrl` and a `pending` boost Transaction at
₦1,500/kobo; (T2) super like init → `201` with a `pending` superlike Transaction
at ₦500/kobo; (T3) a boost `charge.success` → `200`, boost Transaction now
`success`, and **no Subscription row created**; (T4) a superlike `charge.success`
→ Transaction `success`; (T5) a duplicate boost delivery → `200`, still exactly
one Transaction, still `success` (idempotent); (T6) a subscription
`charge.success` (no `type`) → `200`, a `Subscription` row is activated and **no
new Transaction created** (webhook routes correctly); (T7) a forged signature →
`401`. Test rows cleaned up afterward.

---

## Mobile app scaffold + phone OTP sign-in flow (`mobile/`)

**Built:** Replaced the untouched React Native 0.60.4 boilerplate in `mobile/`
with a real Expo (managed, SDK 51, TypeScript) project and shipped the first flow:
phone-number entry → OTP verification → secure token storage → placeholder Home.

- **Toolchain:** Expo managed workflow (`npx expo start`, no Xcode/Android Studio
  required for Expo Go). React Navigation v6 native-stack. axios API client.
- **API base URL is config, not hardcoded:** `EXPO_PUBLIC_API_BASE_URL` (Expo
  build-time public env), read once in `src/config/env.ts`, with a platform-aware
  localhost fallback (`10.0.2.2:3333` on Android emulator) and a warning if unset.
  Backend has no `/api` prefix — routes are mounted at root on port `3333`.
- **Secure token storage:** `expo-secure-store` (iOS Keychain / Android Keystore)
  in `src/auth/tokenStorage.ts` for the JWT access/refresh pair — never
  AsyncStorage. `AuthContext` bootstraps the session from it on launch and drives
  the auth-stack ↔ app-stack switch in `RootNavigator`.
- **Screens** (`src/screens/`): `PhoneEntryScreen` → `POST /auth/otp/request`;
  `OtpEntryScreen` → `POST /auth/otp/verify` (auto-submit at 6 digits, resend with
  cooldown); `HomeScreen` placeholder with sign-out (clears tokens → back to auth).

**API contract consumed** (matches `AuthController`):
- `POST /auth/otp/request { phone }` → `200 { message, phone }` (phone normalized
  to `234XXXXXXXXXX`, reused verbatim by verify).
- `POST /auth/otp/verify { phone, code }` → `200 { accessToken, refreshToken,
  verificationTier, ... }`.

**Error handling:** All axios rejections are normalized in `src/api/errors.ts` to
an `ApiError { kind, status, retryAfterSeconds, attemptsLeft }`:
- invalid phone / missing code / **expired code** (`400`) → backend message shown;
- **wrong code** (`400` + `attemptsLeft`) → message with "N attempts left" appended;
- **rate limit** (`429`) → `Retry-After` header (or the "wait Ns" message) seeds the
  resend countdown; hourly-cap message shown as-is;
- **SMS provider failure** (`502`) and **no-response/network** → retriable messages.

**Deviations / notes:**
- Removed the RN 0.60 native `android/` & `ios/` folders and stale RN config
  (Flow/Buck/metro/jest) — Expo manages native code; run `expo prebuild` if bare
  native projects are ever needed. Old `assets/` (tindev like/dislike PNGs) left
  in place, unreferenced by `app.json`.
- Light client-side phone pre-check only (length by format); the backend's
  `normalizePhone` remains the source of truth.

**Verification:** `tsc --noEmit` clean. Not yet run end-to-end against the live
backend from a device (blocked on the Termii OTP send limitation noted in the
project memory); the flow is wired to the real endpoints and ready to run.

---

## Mobile — photo upload screen (`PhotoUploadScreen`, onboarding step 2)

**Built:** A new onboarding step between profile setup and Home. A user who has
just created a profile now lands on a photo grid, adds photos from the library or
camera, and can't reach Home until at least one photo is uploaded (a photoless
profile can't appear in discovery).

- **Screen** (`src/screens/PhotoUploadScreen.tsx`): a 3-column grid of photo
  tiles plus a dashed "Add photo" tile (hidden once at the `MAX_PHOTOS = 6` cap,
  mirroring the backend). "Add photo" opens a native `Alert` action sheet →
  **Photo Library** (multi-select, `selectionLimit` = remaining slots) or **Take
  Photo** — no third-party action-sheet dependency. Uses `expo-image-picker`
  (added via `expo install`, v15.1.0) with runtime permission requests; a denied
  permission shows an explanatory `Alert` rather than failing silently.
  - **Serial upload queue.** Each selected photo is `POST`ed one at a time. The
    primary flag is decided by array position server-side (`isPrimary:
    photos.length === 0`), so serial uploads keep "first chosen = main" and
    avoid two photos both landing as primary from a race. A re-entrant guard
    (`processingRef`) lets adding more photos mid-run just extend the same queue.
  - **Per-photo status** (`pending | uploading | uploaded | error | deleting`)
    rendered as tile overlays: spinner while in flight, a tap-to-retry surface on
    failure, a "Main" badge on the server-marked primary, and a remove (×) button.
  - **Graceful failure.** A failed upload marks only that tile `error` and leaves
    the rest of the queue and selections intact — retry re-enqueues just that one,
    no re-picking. The local file URI is kept for the retry.
  - **Remove.** Uploaded photos call `DELETE /profile/photos/:photoId` and
    reconcile from the returned profile (so a promoted primary updates its badge);
    not-yet-uploaded selections are dropped locally only.
  - **Continue** is disabled until ≥1 photo is `uploaded` and nothing is in
    flight, then `navigation.reset`s to Home so Back can't return into onboarding.
- **Routing gate** (`src/navigation/RootNavigator.tsx`, `AppFlow`): the
  post-sign-in `GET /profile/me` check is now three-way — `404` → `ProfileSetup`,
  `200` with zero `photos` → `PhotoUpload`, `200` with photos → `Home`. This makes
  the "≥1 photo" requirement durable across app restarts (killing the app after
  profile save resumes on the photo step, not Home). `PhotoUpload` is registered
  in the `AppStack` with the header back button hidden and swipe-back disabled,
  like `ProfileSetup`. `ProfileSetupScreen` now resets to `PhotoUpload` (was Home)
  on successful save.
- **API layer** (`src/api/profile.ts`): added `ProfilePhoto` type, `photos?` on
  `Profile`, and `uploadProfilePhoto()` / `deleteProfilePhoto()`.
  `uploadProfilePhoto` sends `multipart/form-data` with the single field name
  **`photo`** (the exact name the backend's multer expects) and a per-request
  `Content-Type: multipart/form-data` override (RN fills the boundary), returning
  the full updated profile so callers can read back each photo's `_id`/`isPrimary`.

**API contract consumed** (matches `ProfileController` / `routes.js`):
- `POST /profile/photos` — multipart field `photo`, one image ≤ 5 MB, `image/*`.
  `201` full profile; first photo auto-primary; `409` at 6 photos.
- `DELETE /profile/photos/:photoId` — `200` updated profile; promotes a new
  primary if the deleted one was primary.
- `GET /profile/me` — now also read for `photos` to drive the routing gate.

**Config:** Added the `expo-image-picker` config plugin to `app.json` with iOS
photo-library and camera usage strings (needed for dev/standalone builds; Expo Go
already ships its own usage descriptions).

**Notes / deviations:**
- `MediaTypeOptions.Images` is used (correct for SDK 51 / picker v15; the
  `mediaTypes: ['images']` array form lands in a later SDK).
- Camera is unavailable on the iOS simulator — "Take Photo" is expected to no-op
  there; test the camera path on a physical device. Library selection works on
  the simulator.
- The local `MAX_PHOTOS = 6` mirrors the backend constant; the server remains the
  source of truth (a `409` surfaces as a per-tile error).

**Verification:** Mobile `tsc --noEmit` clean. Not yet run on a device — handed to
the user to test live with real photos on the simulator (their request); wired to
the real endpoints and ready to run.

### Fix — routing gate keys on profile completeness, not existence

**Bug:** `POST /profile/photos` upserts a bare profile (`new Profile({ userId })`)
the first time a user uploads, and `name/dob/gender/lookingFor` are all optional
in the schema — so a fieldless profile persists and `GET /profile/me` returns
`200`. The onboarding gate treated any `200` as "has profile" and skipped
`ProfileSetup`, so a user who reached photos before setup (only possible via the
earlier Fast Refresh state glitch, but a latent hole) could land on Home with an
empty profile.

**Fix** (`src/api/profile.ts`, `src/navigation/RootNavigator.tsx`): added
`isProfileComplete(profile)` (all of `name/dob/gender/lookingFor` populated —
mirrors ProfileSetup's client-required set, exported as `REQUIRED_PROFILE_FIELDS`)
and made the gate route on completeness: `404` **or** an incomplete `200` →
`ProfileSetup`; complete + 0 photos → `PhotoUpload`; complete + ≥1 photo → `Home`.
Confirmed the only in-app paths to `PhotoUpload` are the gate and ProfileSetup's
post-save `reset` (which fires only after the required fields validate and `PUT
/profile/me` succeeds) — no stray `navigate('PhotoUpload')`.

**Verification — live, against the running backend on Atlas** (`sabipesin`
cluster): a throwaway verified user driven through six states via real HTTP
`GET`/`PUT /profile/me`, evaluating the shipped gate logic on the actual
responses. 6/6 passed — (A) no profile `404`→ProfileSetup; (B) bare profile
(`PUT {}`, 0 photos) `200`→ProfileSetup; (C) **incomplete (no required fields)
+1 photo** `200`→ProfileSetup (the exact reported bug shape — a photo no longer
forces Home); (D) complete, 0 photos →PhotoUpload; (E) complete +1 photo →Home;
(F) **partial (optional `bio` set, required `name` missing) +1 photo**
→ProfileSetup (the gate requires *all* required fields, and isn't fooled by a
partially-filled profile that already has a photo). Test user/profile fixtures
deleted afterward; DB confirmed restored (4 users, 0 profiles). Mobile
`tsc --noEmit` clean.

## Mobile — discovery feed (`DiscoveryScreen`, replaces the Home placeholder)

**Built:** the real Home experience a user with a complete profile + ≥1 photo
lands on after the onboarding gate — a one-card-at-a-time discovery feed wired to
the live `GET /discovery` and `POST /swipes` endpoints. No swipe-gesture physics
yet (buttons only, by request); gesture-based swiping is a later polish pass.

- **API layer** (`src/api/discovery.ts`, new): `getDiscovery(page)` →
  `{ page, limit, hasMore, candidates }` and `postSwipe(targetId, action)` →
  `{ isMatch, match }`. Types (`Candidate`, `VerificationTier`, `SwipeAction`, …)
  mirror `DiscoveryController.shapeCandidate` / `SwipeController`; `ProfilePhoto`,
  `Gender`, `LookingFor` are reused from `api/profile.ts` (single source of truth).
- **Screen** (`src/screens/DiscoveryScreen.tsx`, new):
  - **Card.** Primary photo (falls back to first photo, then a "No photo"
    placeholder), name + age, location (`lga, state`), bio, and interest chips.
  - **Verification badge** overlaid on the photo — `✓✓ NIN Verified` (filled
    orange) vs `✓ Phone Verified` (subtle outline). Derived from the candidate's
    `user.verificationTier`; a core trust signal, always shown (discovery only
    returns phone-verified-or-better users, so the badge is never absent).
  - **Age** computed from `dob` client-side (whole years; omitted for missing /
    unparseable / out-of-range dates rather than showing junk).
  - **Pass / Like** buttons `POST /swipes` with `action: 'pass' | 'like'` and
    `targetId = candidate.userId` (the USER id the backend expects, **not** the
    profile `_id`). Buttons disable while a swipe is in flight; a failed swipe
    shows an inline banner and does **not** advance (the decision wasn't recorded).
  - **Match confirmation.** On `isMatch: true` a full-screen "It's a match!"
    overlay (their photo + name) appears over the deck; "Keep swiping" dismisses
    it to reveal the next card — never a silent advance.
  - **Paging.** Loads page 1 on mount; prefetches the next page when the cursor is
    within two cards of the end (`hasMore` gates it). Swiped cards stay in the
    array and the cursor just advances — the backend excludes already-swiped users
    from later pages, so no risk of re-showing.
  - **Empty pool** (deck exhausted, `hasMore` false): a clear "You're all caught
    up" message with a Refresh button — never a blank screen. While later pages
    are still loading, a spinner shows instead of a premature empty state.
  - **Error handling.** A failed *first* load is a full-screen retriable error; a
    failed *prefetch* is swallowed (current deck stays usable, retried on the next
    advance).
- **Navigation** (`src/navigation/RootNavigator.tsx`): the `Home` route now
  renders `DiscoveryScreen` (title "Discover") instead of the placeholder
  `HomeScreen`, which is deleted. Sign-out — previously the placeholder's only
  action — moves to a header-right button on the route so it stays reachable. The
  route name stays `Home` (the onboarding gate and `AppStackParamList` are
  unchanged).

**API contract consumed** (matches `DiscoveryController` / `SwipeController`):
- `GET /discovery?page=` — `200 { page, limit, hasMore, candidates[] }`; each
  candidate carries the profile fields + a public `user`
  `{ id, verificationTier, phoneVerifiedAt, ninVerifiedAt }`.
- `POST /swipes { targetId, action }` — `201 { swipe, isMatch, match }`;
  `targetId` is the candidate's user id; `action ∈ { like, pass, superlike }`
  (this slice sends only `like`/`pass`).

**Notes / deviations:**
- No gesture physics this slice (explicitly deferred) — Pass/Like buttons only.
- `superlike` is typed in the API layer but unused (no button yet).
- Placeholder photo path is defensive only — discovery candidates normally have
  photos; the gate requires the *requester* to have ≥1, and the backend doesn't
  currently filter candidates by photo count.

**Verification:** Mobile `tsc --noEmit` clean. Not yet run on a device — handed to
the user to run live against the backend (their request); wired to the real
endpoints and ready.

---

## Get-or-create conversation for a match — `POST /matches/:id/conversation`

**Built:** The missing bridge between a Match and its chat thread. A Match is
created on a mutual like (`SwipeController`), but nothing ever created its
`Conversation`, so the messaging layer (`GET /conversations/:id/messages` and the
Socket.IO events) had no thread to attach to — a freshly matched user had a
`matchId` but no `conversationId`, and `message:send` would fail
`"Conversation not found"`. This endpoint closes that gap: the mobile chat is
keyed by `matchId` and resolves its `conversationId` here on first open.

- `POST /matches/:id/conversation` (`src/controllers/ConversationController.js`,
  `getOrCreateConversation`) — authenticated, no body. Returns the existing
  conversation for the match, or **creates it on first open** (lazy — so matches
  nobody chats on never spawn an empty thread). Response is the same shape as one
  entry of `GET /conversations`:
  ```json
  { "viewerVerificationTier": "phone",
    "conversation": {
      "id": "...", "matchId": "...", "lastMessageAt": "...",
      "otherUser": { "id": "...", "verificationTier": "nin", "profile": { ... } } } }
  ```
  `201` on the create, `200` on every subsequent hit.
- **Idempotent.** The `Conversation.matchId` unique index guarantees one thread
  per match; the handler `findOne`s first (to report 201-vs-200 honestly) and
  wraps the insert in a `try/catch` on duplicate-key (`11000`) that re-reads the
  winner — so two devices opening the same match at once still converge on one
  conversation. Mirrors `SwipeController.upsertMatch`'s race handling.
- **Participant-scoped, info-leak-safe.** `Match.findOne({ _id, $or: [{userA:
  me},{userB: me}] })` — a match that isn't the requester's, a missing id, and a
  malformed (non-ObjectId) id all `404 "Match not found"` indistinguishably, the
  same posture as `GET /matches/:id` and the message read layer. The endpoint
  can't be used to probe whether an arbitrary match id exists.
- Refactored the conversation-shaping into a shared `shapeConversation` helper
  used by both `listConversations` and this endpoint (mirrors
  `MatchController.shapeMatch`).

**New route:** `src/routes.js` — `POST /matches/:id/conversation`.

**Deviations from spec:**
- The get-or-create endpoint isn't named in the spec; it's the natural home for
  the lazy conversation creation the messaging slice assumed but never built.
  Chosen over creating the conversation eagerly in `SwipeController` so existing
  matches self-heal on first open with no backfill migration, and no empty
  threads accumulate for matches that never chat.
- Match `status` is not checked (an `active`-only filter isn't applied) — mirrors
  `GET /matches/:id` and the conversation read layer, which also don't. When an
  unmatch path lands it can gate all three together.

**Verification:** Smoke-tested end-to-end against live MongoDB (20 assertions, all
passing) by driving the real `getOrCreateConversation` handler with mock req/res
(same approach as the messaging-slice entry), temp data cleaned up after. Seed:
users A (phone-verified), B (NIN-verified), C (outsider), a real canonical A–B
match.
- First open as A → `201`, returns a conversation tied to the match,
  `otherUser` resolves to **B** with B's `nin` tier and public profile,
  `viewerVerificationTier` is A's `phone`, exactly one conversation row exists.
- Second open as A → `200`, **same** conversation id, still one row (idempotent).
- Open as B → `200`, same conversation id, `otherUser` resolves to A with A's
  `phone` tier; still one row after both sides opened.
- Non-participant C → `404 "Match not found"` (no thread created, no leak).
- Malformed id → `404` (no cast crash). Well-formed but non-existent id → `404`.

---

## Mobile chat screen — real-time messaging (Phase 5, mobile)

**Built:** The mobile chat experience: a conversation screen wired to the backend
Socket.IO contract, a minimal matches list to reach it, and a "Send a message"
entry point on the match overlay. Keyed by `matchId` throughout — the chat
resolves its `conversationId` on open via `POST /matches/:id/conversation` (the
get-or-create endpoint above), so the overlay/matches-list only ever need the
`matchId` the swipe response and `GET /matches` already provide.

**New files:**
- `src/api/messaging.ts` — typed wrappers: `getOrCreateConversation(matchId)`,
  `getMessages(conversationId, page)` (newest-first, paginated), `listMatches()`;
  plus `Message`/`Conversation`/`MatchSummary`/`OtherUser` types and
  `otherUserPhotoUrl` / `otherUserName` helpers. Reuses the shared `apiClient`
  (bearer token attached automatically).
- `src/realtime/chatSocket.ts` — `useChatSocket` hook. Opens one Socket.IO
  connection authenticating with the stored access token in the handshake
  `auth.token` (the field the backend `io.use` reads), `transports: ['websocket']`.
  Exposes `connectionState` (`connecting` / `connected` / `disconnected`),
  `sendMessage` (promise that resolves on the server ack, rejects when offline or
  the server rejects), `setTyping`, `markRead`. Listens for `message:receive`,
  `typing`, `read`. Handlers are held in a ref so the socket opens once per mount,
  not on every re-render.
- `src/components/SafetyBanner.tsx` — the standing anti-scam reminder ("Never send
  money to a match"), always visible at the top of the thread (brand mockup, spec
  §8.5). On-brand orange tint, non-dismissible this slice.
- `src/screens/ChatScreen.tsx` — resolves conversation → loads history → connects
  socket. Inverted `FlatList` (newest at bottom), backward paging via
  `onEndReached`. A message is "mine" iff `senderId !== otherUser.id` (a thread has
  exactly two participants — no need for the app to know its own user id, which
  `AuthContext` doesn't expose). Optimistic-free send (append on ack). Typing
  indicator (debounced emit, 2s off), read receipts (Sent/Read on my bubbles;
  `markRead` on open, on each inbound peer message). Per-message scam warning under
  a `flagged` bubble, on top of the standing banner. Honest connection state: a
  notice bar shows Connecting…/offline and the composer is disabled while not
  connected, so a send is never silently dropped.
- `src/screens/MatchesScreen.tsx` — minimal active-matches list (`GET /matches`):
  avatar + name + verification tier, tap opens the chat. No last-message previews
  (would need `GET /conversations`) — deliberately lightweight so a match dismissed
  from the overlay is still reachable.

**Navigation** (`src/navigation/types.ts`, `RootNavigator.tsx`):
- New `AppStack` routes `Matches` (undefined) and `Chat`
  (`{ matchId, otherUserName?, otherUserPhotoUrl? }` — the optional name/photo let
  the header render instantly before the get-or-create round-trip resolves).
- `Home` (Discover) header gains a **Matches** button on the left (Sign out stays
  on the right).
- The match overlay's **Send a message** button (`DiscoveryScreen`) navigates to
  `Chat` with the `matchId` captured from the swipe response; **Keep swiping**
  still dismisses. `matched` state widened from `Candidate` to
  `{ candidate, matchId }` to carry the id.

**Dependencies:** added `socket.io-client` (^4.8.3, matches backend `socket.io`).

**Deviations from spec:**
- Chat is keyed by `matchId` (not `conversationId`) at the navigation layer, since
  that's all the overlay and `GET /matches` expose; the `conversationId` is an
  internal detail resolved on open. Depends on the get-or-create endpoint above.
- The matches list is intentionally minimal (no previews/unread). A richer inbox
  over `GET /conversations` can come later; the user opted for the minimal list.
- No token refresh: the app has no refresh-on-401 path today, so if the access
  token expires mid-session the socket drops and the connection notice shows —
  honest rather than silently broken. Reconnect on a fresh token (re-open screen).

**Verification:** Mobile `tsc --noEmit` clean (strict). Not yet run on a device —
per the user's request, handed over for a live run against the backend; wired to
the real REST endpoints and the real Socket.IO contract and ready. The backend
get-or-create endpoint it depends on is live-tested above (20 assertions).

