const { Schema, model } = require('mongoose');

const UserSchema = new Schema({
    phone: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    phoneVerifiedAt: {
        type: Date,
        default: null,
    },
    ninVerifiedAt: {
        type: Date,
        default: null,
    },
    ninVerificationRef: {
        type: String,
        default: null, // vendor's reference ID
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user',
    },
    status: {
        type: String,
        enum: ['active', 'suspended', 'banned'],
        default: 'active',
    },
}, {
    timestamps: true,
});

// verificationTier is never stored — derive it at read time (spec §3, §4.7).
UserSchema.virtual('verificationTier').get(function () {
    if (this.ninVerifiedAt) return 'nin';
    if (this.phoneVerifiedAt) return 'phone';
    return null;
});

// Ensure the derived tier is present when a User is serialized to JSON/objects.
UserSchema.set('toJSON', { virtuals: true });
UserSchema.set('toObject', { virtuals: true });

module.exports = model('User', UserSchema);
