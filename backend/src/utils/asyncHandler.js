// Wraps an async route handler or middleware so that a thrown error or a
// rejected promise is forwarded to Express's error-handling middleware via
// next(err), instead of becoming an unhandled promise rejection that crashes
// the process. Express 4 does not catch async rejections on its own, so every
// async handler/middleware is wrapped with this.
function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        return Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = asyncHandler;
