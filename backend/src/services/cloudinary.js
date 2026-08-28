const { v2: cloudinary } = require('cloudinary');

// The SDK auto-reads CLOUDINARY_URL (cloudinary://key:secret@cloud) from the
// environment. Fail fast at boot if it's missing rather than at the first upload.
if (!process.env.CLOUDINARY_URL) {
    throw new Error('CLOUDINARY_URL is not set. Copy .env.example to .env and provide the Cloudinary credentials.');
}

// secure: true so returned URLs are https.
cloudinary.config({ secure: true });

// Raised by the helpers below when Cloudinary rejects a request. Matched by name
// in the central error handler (like TermiiError) and mapped to a 502, so this
// module stays decoupled from the HTTP layer.
class CloudinaryError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'CloudinaryError';
        this.cause = cause;
    }
}

// Uploads an in-memory image buffer (from multer memoryStorage) to Cloudinary
// and resolves to { url, publicId }. upload_stream avoids writing a temp file.
function uploadImage(buffer, folder) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, resource_type: 'image' },
            (err, result) => {
                if (err) {
                    return reject(new CloudinaryError('Cloudinary upload failed', err));
                }
                return resolve({ url: result.secure_url, publicId: result.public_id });
            },
        );
        stream.end(buffer);
    });
}

// Deletes an asset by its public_id. Cloudinary returns { result: 'ok' } on
// success and { result: 'not found' } if it was already gone — we treat both as
// success so a DB row can always be cleaned up even if the asset is missing.
async function deleteImage(publicId) {
    let res;
    try {
        res = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (err) {
        throw new CloudinaryError('Cloudinary delete failed', err);
    }
    if (res.result !== 'ok' && res.result !== 'not found') {
        throw new CloudinaryError(`Cloudinary delete returned "${res.result}"`, res);
    }
    return res;
}

module.exports = { uploadImage, deleteImage, CloudinaryError };
