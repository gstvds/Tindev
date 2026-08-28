// Central Express error handler. Mount LAST, after all routes. Must declare all
// four arguments so Express recognizes it as an error handler. Controllers and
// middleware throw/reject freely (via asyncHandler) and rely on this to map
// errors to HTTP responses; anything unrecognized is a 500.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    // If a response was already started, defer to Express's default handler.
    if (res.headersSent) {
        return next(err);
    }

    // Malformed JSON in the request body (thrown by express.json()).
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON body' });
    }

    // Downstream SMS provider (Termii) failure — matched by name to avoid
    // coupling this module to the service that defines TermiiError.
    if (err.name === 'TermiiError') {
        console.error('Termii error:', err.message, err.data || '');
        return res.status(502).json({ error: 'Could not send verification code, please try again' });
    }

    // Downstream KYC provider (QoreID) failure — matched by name to avoid
    // coupling this module to the service that defines QoreIdError.
    if (err.name === 'QoreIdError') {
        console.error('QoreID error:', err.message, err.data || '');
        return res.status(502).json({ error: 'Could not start NIN verification, please try again' });
    }

    // Downstream payment provider (Paystack) failure — matched by name to avoid
    // coupling this module to the service that defines PaystackError.
    if (err.name === 'PaystackError') {
        console.error('Paystack error:', err.message, err.data || '');
        return res.status(502).json({ error: 'Could not start the payment, please try again' });
    }

    // Multer rejected the upload (too large, wrong field, non-image) — client error.
    if (err.name === 'MulterError') {
        const messages = {
            LIMIT_FILE_SIZE: 'Photo exceeds the 5MB size limit',
            LIMIT_UNEXPECTED_FILE: 'Unexpected file — send a single image in the "photo" field',
            LIMIT_FILE_COUNT: 'Only one photo can be uploaded at a time',
        };
        return res.status(400).json({ error: messages[err.code] || 'Invalid file upload' });
    }

    // Cloudinary (photo storage) failure — matched by name to stay decoupled.
    if (err.name === 'CloudinaryError') {
        console.error('Cloudinary error:', err.message, err.cause || '');
        return res.status(502).json({ error: 'Photo storage is unavailable, please try again' });
    }

    // Mongoose validation / cast failures are client errors.
    if (err.name === 'ValidationError' || err.name === 'CastError') {
        return res.status(400).json({ error: err.message });
    }

    // Unexpected — log the full error and return a generic 500.
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
}

module.exports = errorHandler;
