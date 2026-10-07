const mongoose = require('mongoose');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Match = require('../models/Match');
const User = require('../models/User');
const Profile = require('../models/Profile');
const { blockedUserIds, isBlockedBetween } = require('../utils/blocks');
const { isUserDeleted } = require('../utils/accounts');

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

// Shape one Conversation for the requester `me`, resolving the OTHER participant
// with their derived verificationTier (spec §4.7 — the chat screen shows the
// badge, so it's always present, even when null) and public profile. Mirrors
// MatchController.shapeMatch; the list batch-loads users/profiles, the
// get-or-create endpoint loads the single other side.
function shapeConversation(conversation, me, otherUser, otherProfile) {
    const otherId = String(conversation.participants.find((p) => String(p) !== me));
    return {
        id: conversation._id,
        matchId: conversation.matchId,
        lastMessageAt: conversation.lastMessageAt,
        otherUser: {
            id: otherId,
            verificationTier: otherUser ? otherUser.verificationTier : null,
            profile: publicProfile(otherProfile),
        },
    };
}

// GET /conversations
// The authenticated user's conversations, most recently active first. Each carries
// the OTHER participant resolved with their derived verificationTier (spec §4.7 —
// the chat screen shows the badge, so it's always present, even when null) and
// their public profile. Users and profiles are batch-loaded and indexed by id for
// O(1) assembly, the same shape as GET /matches.
async function listConversations(req, res) {
    const me = req.userId;

    const allConversations = await Conversation.find({ participants: me })
        .sort({ lastMessageAt: -1 });

    // Soft-exclude blocked pairs (spec safety / App Store Guideline 1.2): a
    // conversation whose other participant is on either side of a block is hidden
    // from the list, but its Conversation (and Message) documents are deliberately
    // NOT deleted — kept for moderation/audit and restored if the block is lifted.
    const blocked = new Set(await blockedUserIds(me));
    const conversations = allConversations.filter((c) => {
        const otherId = String(c.participants.find((p) => String(p) !== me));
        return !blocked.has(otherId);
    });

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

    // Soft-exclude deleted accounts (App Store Guideline 5.1.1(v)): a conversation
    // whose other participant deleted their account (no User doc) is hidden, exactly
    // like a blocked pair above. We reuse the batch load just done — an absent user
    // IS a deleted user — so there's no extra query. The Conversation and Message
    // docs are deliberately KEPT for this side's audit trail.
    const payload = conversations
        .filter((c) => userById.has(String(c.participants.find((p) => String(p) !== me))))
        .map((c) => {
            const otherId = String(c.participants.find((p) => String(p) !== me));
            return shapeConversation(c, me, userById.get(otherId), profileByUserId.get(otherId));
        });

    return res.json({
        viewerVerificationTier: req.user.verificationTier,
        conversations: payload,
    });
}

// POST /matches/:id/conversation
// Get-or-create the chat thread for a match the requester is part of. The Match is
// created when two users mutually like (SwipeController), but its Conversation is
// created lazily here — on first open — so matches nobody chats on never spawn an
// empty thread. Idempotent: the unique index on Conversation.matchId means a match
// has exactly one conversation, and calling this repeatedly always returns that
// same one (201 on the create, 200 on every subsequent hit).
//
// 404s if the match doesn't exist OR isn't one of the requester's — deliberately
// indistinguishable (a malformed id 404s too, not a cast error), the same
// info-leak-safe posture as GET /matches/:id and the message read layer, so this
// can't be used to probe whether an arbitrary match id exists. Returns the same
// shape as one entry of GET /conversations.
async function getOrCreateConversation(req, res) {
    const me = req.userId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(404).json({ error: 'Match not found' });
    }

    // Scope the lookup to matches the requester is part of, so someone else's
    // match reads as "not found" rather than leaking its existence.
    const match = await Match.findOne({
        _id: id,
        $or: [{ userA: me }, { userB: me }],
    });
    if (!match) {
        return res.status(404).json({ error: 'Match not found' });
    }

    // Block gate (spec safety / App Store Guideline 1.2): a blocked pair's match
    // reads as "not found" — don't reveal it, and don't lazily spin up a
    // conversation for it. Consistent with GET /matches and GET /matches/:id.
    const otherId = String(match.userA) === me ? String(match.userB) : String(match.userA);
    if (await isBlockedBetween(me, otherId)) {
        return res.status(404).json({ error: 'Match not found' });
    }

    // Deleted-account gate (App Store Guideline 5.1.1(v)): if the other participant
    // deleted their account, the match reads as "not found" — and, as with a block,
    // don't lazily spin up a conversation for it. Consistent with GET /matches and
    // GET /matches/:id hiding it.
    if (await isUserDeleted(otherId)) {
        return res.status(404).json({ error: 'Match not found' });
    }

    // Look for the existing thread first so we can report 201-vs-200 honestly.
    let conversation = await Conversation.findOne({ matchId: match._id });
    let created = false;
    if (!conversation) {
        // participants mirror the match pair (denormalised — see Conversation model).
        try {
            conversation = await Conversation.create({
                matchId: match._id,
                participants: [match.userA, match.userB],
            });
            created = true;
        } catch (err) {
            // Duplicate key on the unique matchId index — a concurrent open won the
            // race and created it first; re-read the now-existing thread. Keeps this
            // idempotent under two devices opening the same match at once.
            if (err.code === 11000) {
                conversation = await Conversation.findOne({ matchId: match._id });
            } else {
                throw err;
            }
        }
    }

    const [otherUser, otherProfile] = await Promise.all([
        User.findById(otherId),
        Profile.findOne({ userId: otherId }),
    ]);

    return res.status(created ? 201 : 200).json({
        viewerVerificationTier: req.user.verificationTier,
        conversation: shapeConversation(conversation, me, otherUser, otherProfile),
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

    // Block gate (spec safety / App Store Guideline 1.2): a blocked pair's
    // conversation reads as "not found" — consistent with GET /conversations
    // soft-excluding it and the socket refusing sends.
    const otherId = String(conversation.participants.find((p) => String(p) !== me));
    if (await isBlockedBetween(me, otherId)) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    // Deleted-account gate (App Store Guideline 5.1.1(v)): if the other participant
    // deleted their account, the conversation reads as "not found" — consistent with
    // GET /conversations hiding it and the socket refusing sends. The Conversation
    // and its Messages are deliberately KEPT for this side's audit trail.
    if (await isUserDeleted(otherId)) {
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
    getOrCreateConversation,
    listMessages,
};
