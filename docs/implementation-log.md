# Implementation Log

A running record of what was actually built, the real endpoint/model shapes, and
any deviations from `technical-build-spec.md` (with the reason). One entry per
feature, committed together with that feature's code.

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
