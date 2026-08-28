// Derives a user's verification tier from their verification timestamps
// (spec §3, §4.7): 'nin' if NIN-verified, else 'phone' if phone-verified, else
// null. Mirrors the `verificationTier` virtual on the User model, for contexts
// where the user is a plain object rather than a hydrated Mongoose doc — e.g. the
// GET /discovery aggregation, whose results don't run schema virtuals.
function verificationTier(user) {
    if (!user) return null;
    if (user.ninVerifiedAt) return 'nin';
    if (user.phoneVerifiedAt) return 'phone';
    return null;
}

module.exports = verificationTier;
