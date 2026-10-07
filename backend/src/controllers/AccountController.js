const User = require('../models/User');
const Profile = require('../models/Profile');
const Swipe = require('../models/Swipe');
const { deleteImage } = require('../services/cloudinary');

// DELETE /account
// Permanently deletes the CALLING user's own account (App Store Guideline
// 5.1.1(v)). Auth-required; there is no admin/other-user deletion path — a user can
// only ever delete themselves (the target is always req.userId).
//
// What is HARD-deleted (the user's own data):
//   - their Cloudinary photo assets (real destroy() calls, verified per photo)
//   - their Profile document
//   - every Swipe where they are either the actor or the target
//   - their User document
//
// What is deliberately KEPT: Match / Conversation / Message documents. Those are
// shared with the other party, who keeps an intact audit trail — the deleted user
// is instead soft-excluded from the other side's view by utils/accounts.js
// (Chunk 1), exactly the way Report/Block keeps the docs and soft-excludes.
//
// Session invalidation: there is no token blacklist — access tokens are stateless
// JWTs. Deleting the User document IS the invalidation: the auth middleware does a
// live `User.findById` on every request (and the socket handshake does the same),
// so once the User is gone every existing token for it fails with 401 "User no
// longer exists" on its next use. No new mechanism is invented.
//
// Ordering is chosen for safe partial-failure behaviour, mirroring
// ProfileController.deletePhoto: delete the irreversible Cloudinary assets FIRST so
// a storage failure (CloudinaryError → 502) aborts before any DB document is
// touched, and delete the User LAST so that if an earlier DB step fails, the
// account still exists and the request can simply be retried (each Cloudinary
// asset is then already "not found", which deleteImage treats as success). This is
// intentionally NOT wrapped in a Mongo transaction: the rest of the codebase
// doesn't use them (they require a replica set and aren't available on a standalone
// mongod), and the ordering above gives graceful degradation without one.
async function deleteAccount(req, res) {
    const me = req.userId;

    // Load the profile first, only for its photo public_ids.
    const profile = await Profile.findOne({ userId: me });

    // 1) Delete every Cloudinary photo asset, verifying each. deleteImage throws a
    //    CloudinaryError (→ 502) on a real failure and treats an already-missing
    //    asset as success, so we either remove them all or abort before any DB
    //    mutation. Done serially so the first failure stops us immediately.
    let photosDeleted = 0;
    if (profile && Array.isArray(profile.photos)) {
        for (const photo of profile.photos) {
            if (photo.publicId) {
                await deleteImage(photo.publicId);
                photosDeleted += 1;
            }
        }
    }

    // 2) Delete the Profile document.
    if (profile) {
        await profile.deleteOne();
    }

    // 3) Delete every Swipe where this user is either party (actor or target), so
    //    no dangling swipe references a user that no longer exists.
    const swipeResult = await Swipe.deleteMany({
        $or: [{ actorId: me }, { targetId: me }],
    });
    const swipesDeleted = swipeResult.deletedCount || 0;

    // 4) Delete the User document LAST — this is what invalidates the caller's
    //    tokens (see the header note). Match/Conversation/Message are untouched.
    await User.deleteOne({ _id: me });

    // 5) Force-disconnect any socket the caller had already open. The auth
    //    middleware and the socket handshake both re-check the User on every
    //    request/connection, so REST and any RECONNECT are already rejected the
    //    moment the User is gone — but a socket established BEFORE deletion isn't
    //    re-checked per event, so it would otherwise keep working for the life of
    //    that connection. Each authenticated socket joins a room named after its
    //    userId (see socket/index.js), so disconnecting that room evicts all of
    //    the user's live connections immediately. `true` closes the underlying
    //    transport so the client sees a real disconnect, not just a namespace
    //    leave. Best-effort: a missing io (e.g. non-socket test harness) is a
    //    no-op and never blocks the deletion response.
    const io = req.app.get('io');
    if (io) {
        io.in(me).disconnectSockets(true);
    }

    // 200 with a body, consistent with the DELETE /users/:id/block precedent.
    return res.json({
        message: 'Account deleted',
        deleted: {
            profile: Boolean(profile),
            photos: photosDeleted,
            swipes: swipesDeleted,
        },
    });
}

// Mirrors the schema validators on User.js (email) so a bad request gets a
// clear 400 + error code before touching the DB, in the same explicit style
// as ProfileController.updateDiscoverySettings.
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const EMAIL_MAX_LENGTH = 254;

// GET /account/email
// Self-only (target is always req.userId, via the auth middleware's own
// User.findById — there is no other-account lookup path). Never verified,
// never used for login/OTP/recovery.
async function getEmail(req, res) {
    return res.json({ email: req.user.email ?? null });
}

// PUT /account/email
// Accepts { email: string | null }. Trims and lowercases; an empty string or
// null clears it back to null — this field is always optional and must never
// block any other action (receipt delivery only). Self-only, same as getEmail.
//
// Deliberately calls req.user.save() rather than an update query: this
// codebase is on Mongoose 5.7, where update queries (updateOne/
// findOneAndUpdate/etc.) do NOT run schema validators unless explicitly
// passed `runValidators: true`. save() always runs them, so the schema's own
// match/maxlength validators on User.js are a real backstop here, not just
// the explicit checks below — a bad value is rejected twice, not once.
async function updateEmail(req, res) {
    const { email } = req.body;

    if (email !== null && typeof email !== 'string') {
        return res.status(400).json({ error: 'email must be a string or null', code: 'INVALID_EMAIL' });
    }

    const trimmed = (email ?? '').trim().toLowerCase();

    if (trimmed === '') {
        req.user.email = null;
        await req.user.save();
        return res.json({ email: null });
    }

    if (trimmed.length > EMAIL_MAX_LENGTH) {
        return res.status(400).json({
            error: `email must be at most ${EMAIL_MAX_LENGTH} characters`,
            code: 'EMAIL_TOO_LONG',
        });
    }

    if (!EMAIL_RE.test(trimmed)) {
        return res.status(400).json({ error: 'email is not a valid address', code: 'INVALID_EMAIL' });
    }

    // Mongoose ValidationError (shouldn't fire given the checks above, but is
    // the real proof the schema validators are wired up) propagates to the
    // central error handler, mapped to 400.
    req.user.email = trimmed;
    await req.user.save();

    return res.json({ email: req.user.email });
}

module.exports = { deleteAccount, getEmail, updateEmail };
