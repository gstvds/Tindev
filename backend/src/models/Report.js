const { Schema, model } = require('mongoose');

// A user reporting another user for moderation (App Store Guideline 1.2 / spec
// safety requirement). Directional: reporterId -> reportedUserId. Reports are a
// pure audit/moderation record — creating one has NO effect on matching,
// discovery, or messaging (blocking is the separate, user-facing lever). Multiple
// reports of the same user by the same reporter are intentionally allowed (each is
// a distinct incident), so there is no unique index here — unlike Block.
const REASONS = ['inappropriate_photos', 'harassment', 'scam_attempt', 'fake_profile', 'underage', 'other'];
const STATUSES = ['pending', 'reviewed', 'actioned', 'dismissed'];

const ReportSchema = new Schema({
    reporterId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    reportedUserId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    reason: {
        type: String,
        enum: REASONS,
        required: true,
    },
    details: {
        type: String,
        maxlength: 1000,
    },
    // Moderation lifecycle — set by a human/admin flow later. New reports land as
    // 'pending'; there is no admin surface in this slice, this just reserves the shape.
    status: {
        type: String,
        enum: STATUSES,
        default: 'pending',
    },
}, {
    timestamps: true,
});

// Lookups for a future moderation queue: reports against a given user, newest first.
ReportSchema.index({ reportedUserId: 1, createdAt: -1 });

const Report = model('Report', ReportSchema);

// Exposed so the controller validates an incoming reason against the SAME source
// of truth as the schema enum (rather than duplicating the list, as SwipeController
// does for swipe actions) — keeps the INVALID_REASON check from drifting.
Report.REASONS = REASONS;
Report.STATUSES = STATUSES;

module.exports = Report;
