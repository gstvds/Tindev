const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const registerMessageHandlers = require('./messageHandlers');

// Pull the access token off a socket handshake. Clients may send it either as
// `auth.token` (the socket.io-client convention) or in a Bearer Authorization
// header, mirroring the HTTP auth middleware so the same token works for both.
function extractToken(socket) {
    const fromAuth = socket.handshake.auth && socket.handshake.auth.token;
    if (fromAuth) return fromAuth;
    const header = socket.handshake.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) return token;
    return null;
}

// Wire Socket.IO onto an existing io server (spec §6). Connections are
// authenticated with the same access token as the REST API; an authenticated
// socket joins a room named after its userId, so delivering to a user is just
// `io.to(userId).emit(...)` — this transparently fans out to every device that
// user has open and is a no-op when they're offline.
function initSocket(io) {
    io.use(async (socket, next) => {
        try {
            const token = extractToken(socket);
            if (!token) return next(new Error('Missing access token'));

            const decoded = verifyAccessToken(token);
            const user = await User.findById(decoded.sub);
            if (!user) return next(new Error('User no longer exists'));
            if (user.status !== 'active') {
                return next(new Error(`Account is ${user.status}`));
            }

            socket.userId = String(user._id);
            socket.user = user;
            return next();
        } catch (err) {
            return next(new Error('Invalid or expired token'));
        }
    });

    io.on('connection', (socket) => {
        // Room-per-user: the target of every message/typing/read event.
        socket.join(socket.userId);
        registerMessageHandlers(io, socket);
    });

    return io;
}

module.exports = initSocket;
