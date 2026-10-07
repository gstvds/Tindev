const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');

// Verifies the Bearer access token, loads the user, and attaches both the
// decoded token and the User document to the request. Rejects missing/invalid
// tokens (401) and users that are no longer allowed to act (403).
async function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let decoded;
    try {
        decoded = verifyAccessToken(token);
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = await User.findById(decoded.sub);
    if (!user) {
        return res.status(401).json({ error: 'User no longer exists' });
    }

    if (user.status !== 'active') {
        return res.status(403).json({ error: `Account is ${user.status}` });
    }

    req.auth = decoded;
    req.user = user;
    req.userId = String(user._id);

    return next();
}

module.exports = authMiddleware;
