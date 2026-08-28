const mongoose = require('mongoose');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const Profile = require('../models/Profile');

// Pagination bounds. Not in the spec — sensible defaults so a client can't ask
// for an unbounded page. Mirrors DiscoveryController.
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// Parse and clamp ?page / ?limit. page is 1-based; both fall back to defaults on
// anything non-numeric or out of range.
function parsePaging(query) {
    let page = parseInt(query.page, 10);
    let limit = parseInt(query.limit, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    return { page, limit };
}

// Strip another user's private discoverySettings before returning their profile —
// those are theirs alone. Mirrors the same helper in MatchController.
function publicProfile(profile) {
    if (!profile) return null;
    const obj = profile.toObject();
    delete obj.discoverySettings;
    return obj;
}

// GET /conversations
// The authenticated user's conversations, most recently active first. Each carries
// the OTHER participant resolved with their derived verificationTier (spec §4.7 —
// the chat screen shows the badge, so it's always present, even when null) and
// their public profile. Users and profiles are batch-loaded and indexed by id for
// O(1) assembly, the same shape as GET /matches.
async function listConversations(req, res) {
    const me = req.userId;

    const conversations = await Conversation.find({ participants: me })
        .sort({ lastMessageAt: -1 });

    // The "other" participant in each conversation is whichever id isn't the
    // requester. A conversation always has the two match participants.
    const otherIds = conversations.map(
        (c) => c.participants.find((p) => String(p) !== me),
    );

    const [users, profiles] = await Promise.all([
        User.find({ _id: { $in: otherIds } }),
        Profile.find({ userId: { $in: otherIds } }),
    ]);
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));

    const payload = conversations.map((c) => {
        const otherId = String(c.participants.find((p) => String(p) !== me));
        const otherUser = userById.get(otherId);
        const otherProfile = profileByUserId.get(otherId);
        return {
            id: c._id,
            matchId: c.matchId,
            lastMessageAt: c.lastMessageAt,
            otherUser: {
                id: otherId,
                verificationTier: otherUser ? otherUser.verificationTier : null,
                profile: publicProfile(otherProfile),
            },
        };
    });

    return res.json({
        viewerVerificationTier: req.user.verificationTier,
        conversations: payload,
    });
}

// GET /conversations/:id/messages
// Paginated messages for one conversation the requester is part of, newest first.
// 404s if the conversation doesn't exist OR the requester isn't a participant —
// the two are deliberately indistinguishable, so this endpoint can't be used to
// probe whether an arbitrary conversation id exists (same posture as
// GET /matches/:id). A malformed (non-ObjectId) id also 404s rather than
// surfacing a cast error. Pure read — nothing marks readAt here (that arrives
// with the `read` WebSocket event in Phase 5).
async function listMessages(req, res) {
    const me = req.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    // Scope the lookup to conversations the requester is a participant of, so a
    // conversation that isn't theirs reads as "not found" rather than leaking it.
    const conversation = await Conversation.findOne({ _id: id, participants: me });
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const { page, limit } = parsePaging(req.query);
    const skip = (page - 1) * limit;

    // Fetch one extra row to compute hasMore without a second count query.
    const messages = await Message.find({ conversationId: id })
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit + 1);

    const hasMore = messages.length > limit;
    const pageItems = hasMore ? messages.slice(0, limit) : messages;

    return res.json({
        page,
        limit,
        hasMore,
        messages: pageItems.map((m) => ({
            id: m._id,
            conversationId: m.conversationId,
            senderId: m.senderId,
            text: m.text,
            flagged: m.flagged,
            readAt: m.readAt,
            createdAt: m.createdAt,
        })),
    });
}

module.exports = {
    listConversations,
    listMessages,
};
