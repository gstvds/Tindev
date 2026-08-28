const jwt = require('jsonwebtoken');

const {
    JWT_SECRET,
    JWT_REFRESH_SECRET,
    JWT_ACCESS_EXPIRES_IN = '15m',
    JWT_REFRESH_EXPIRES_IN = '30d',
} = process.env;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
    throw new Error(
        'JWT_SECRET and JWT_REFRESH_SECRET must be set. Copy .env.example to .env and provide values.'
    );
}

// Access and refresh tokens are signed with separate secrets so that a leaked
// access secret cannot be used to mint long-lived refresh tokens. The `type`
// claim is a second guard: verifyAccessToken rejects a refresh token and vice
// versa, even in the unlikely event the secrets were ever misconfigured to match.

function signAccessToken(payload) {
    return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, {
        expiresIn: JWT_ACCESS_EXPIRES_IN,
    });
}

function signRefreshToken(payload) {
    return jwt.sign({ ...payload, type: 'refresh' }, JWT_REFRESH_SECRET, {
        expiresIn: JWT_REFRESH_EXPIRES_IN,
    });
}

function verifyAccessToken(token) {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'access') {
        throw new jwt.JsonWebTokenError('Expected an access token');
    }
    return decoded;
}

function verifyRefreshToken(token) {
    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
        throw new jwt.JsonWebTokenError('Expected a refresh token');
    }
    return decoded;
}

// Convenience: mint both tokens for a user in one call.
function issueTokens(user) {
    const payload = { sub: String(user._id || user.id), role: user.role };
    return {
        accessToken: signAccessToken(payload),
        refreshToken: signRefreshToken(payload),
    };
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    issueTokens,
};
