const mongoose = require('mongoose');

const Report = require('../models/Report');
const Block = require('../models/Block');
const User = require('../models/User');
const Profile = require('../models/Profile');

// Basic profile fields surfaced for a blocked user in GET /users/blocked — enough
// to render a recognizable row (name + photos) without leaking their private
// discoverySettings or other users' internal fields. Mirrors the "public profile"
// posture used by MatchController/ConversationController.
function basicProfile(profile) {
    if (!profile) return null;
    return {
        name: profile.name || null,
        photos: (profile.photos || []).map((p) => ({ url: p.url, isPrimary: p.isPrimary })),
    };
}

// POST /users/:id/report  { reason, details? }
// Files a moderation report against another user. Pure audit record: it has NO
// effect on matching, discovery, or messaging (blocking is the separate lever).
async function reportUser(req, res) {
    const reporterId = req.userId;
    const { id: reportedUserId } = req.params;
    const { reason, details } = req.body || {};

    if (String(reportedUserId) === String(reporterId)) {
        return res.status(400).json({ error: 'You cannot report yourself', code: 'CANNOT_REPORT_SELF' });
    }
    if (!Report.REASONS.includes(reason)) {
        return res.status(400).json({
            error: `reason must be one of: ${Report.REASONS.join(', ')}`,
            code: 'INVALID_REASON',
        });
    }
    if (!mongoose.Types.ObjectId.isValid(reportedUserId)) {
        return res.status(404).json({ error: 'User not found' });
    }

    const reported = await User.findById(reportedUserId);
    if (!reported) {
        return res.status(404).json({ error: 'User not found' });
    }

    // `details` length (max 1000) is enforced by the schema via runValidators — an
    // over-long value surfaces as a ValidationError -> 400 through the central handler.
    const report = await Report.create({ reporterId, reportedUserId, reason, details });

    return res.status(201).json({
        report: {
            id: report._id,
            reportedUserId: report.reportedUserId,
            reason: report.reason,
            status: report.status,
            createdAt: report.createdAt,
        },
    });
}

// POST /users/:id/block
// Blocks another user. Idempotent by design: a repeat block collides on the unique
// (blockerId, blockedUserId) index (code 11000), which we treat as success and
// return the already-existing block — the same pattern SwipeController/
// ConversationController use for their unique pairs.
async function blockUser(req, res) {
    const blockerId = req.userId;
    const { id: blockedUserId } = req.params;

    if (String(blockedUserId) === String(blockerId)) {
        return res.status(400).json({ error: 'You cannot block yourself', code: 'CANNOT_BLOCK_SELF' });
    }
    if (!mongoose.Types.ObjectId.isValid(blockedUserId)) {
        return res.status(404).json({ error: 'User not found' });
    }

    const target = await User.findById(blockedUserId);
    if (!target) {
        return res.status(404).json({ error: 'User not found' });
    }

    let block;
    let created = false;
    try {
        block = await Block.create({ blockerId, blockedUserId });
        created = true;
    } catch (err) {
        // Duplicate key on the unique (blockerId, blockedUserId) index — already
        // blocked. Idempotent: re-read the existing block and report success.
        if (err.code === 11000) {
            block = await Block.findOne({ blockerId, blockedUserId });
        } else {
            throw err;
        }
    }

    return res.status(created ? 201 : 200).json({
        block: {
            id: block._id,
            blockedUserId: block.blockedUserId,
            createdAt: block.createdAt,
        },
    });
}

// DELETE /users/:id/block
// Unblocks a user. Idempotent: removing a block that isn't there still succeeds
// (200), so the client never has to special-case "was it actually blocked".
async function unblockUser(req, res) {
    const blockerId = req.userId;
    const { id: blockedUserId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(blockedUserId)) {
        // Nothing could match an invalid id — treat as an already-absent block.
        return res.json({ message: 'Block removed', removed: false });
    }

    const result = await Block.deleteOne({ blockerId, blockedUserId });
    // Mongoose 5 reports deletedCount on the result.
    const removed = (result.deletedCount || 0) > 0;

    return res.json({ message: 'Block removed', removed });
}

// GET /users/blocked
// The authenticated user's blocks, newest first, each with the blocked user's
// basic profile (name + photos). Profiles are batch-loaded and indexed by userId
// for O(1) assembly — the same shape as GET /matches.
async function listBlocked(req, res) {
    const blockerId = req.userId;

    const blocks = await Block.find({ blockerId }).sort({ createdAt: -1 });
    const blockedIds = blocks.map((b) => b.blockedUserId);

    const profiles = await Profile.find({ userId: { $in: blockedIds } });
    const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));

    const blocked = blocks.map((b) => ({
        id: b._id,
        blockedAt: b.createdAt,
        user: {
            id: b.blockedUserId,
            profile: basicProfile(profileByUserId.get(String(b.blockedUserId))),
        },
    }));

    return res.json({ blocked });
}

module.exports = {
    reportUser,
    blockUser,
    unblockUser,
    listBlocked,
};
