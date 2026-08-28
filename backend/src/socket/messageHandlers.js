const mongoose = require('mongoose');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { isScammy } = require('../utils/antiScam');

// Serialize a Message the same shape GET /conversations/:id/messages returns, so
// a client renders a socket-delivered message identically to a fetched one.
function serialize(message) {
    return {
        id: message._id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text: message.text,
        flagged: message.flagged,
        readAt: message.readAt,
        createdAt: message.createdAt,
    };
}

// The other participant's id in a conversation the requester is part of. A
// conversation always holds exactly the two match participants.
function otherParticipant(conversation, me) {
    return String(conversation.participants.find((p) => String(p) !== me));
}

// Load a conversation only if `me` is a participant. Returns null for a missing,
// malformed, or foreign conversation id — the socket handlers treat all three the
// same way (silently ignore / negative ack), never leaking which one it was, the
// same 404-scoping posture as the REST message endpoints.
async function findOwnedConversation(conversationId, me) {
    if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
        return null;
    }
    return Conversation.findOne({ _id: conversationId, participants: me });
}

// Register the messaging events (spec §6) for one authenticated socket. Each
// handler re-authorizes against conversation membership on every call — a socket
// is authenticated as a user, but that alone doesn't grant access to a thread.
function registerMessageHandlers(io, socket) {
    const me = socket.userId;

    // message:send — persist a message, bump the thread, deliver to the peer.
    // The optional `ack` callback echoes the stored message (with its id, server
    // timestamp, and flagged verdict) back to the sender.
    socket.on('message:send', async (payload, ack) => {
        try {
            const { conversationId, text } = payload || {};
            const body = typeof text === 'string' ? text.trim() : '';
            if (!body) {
                return typeof ack === 'function' && ack({ ok: false, error: 'Message text is required' });
            }

            const conversation = await findOwnedConversation(conversationId, me);
            if (!conversation) {
                return typeof ack === 'function' && ack({ ok: false, error: 'Conversation not found' });
            }

            // Anti-scam flagging (spec §8.5): scan but never block — a trip only
            // sets flagged, which keeps the safety warning up on the thread.
            const flagged = isScammy(body);

            const message = await Message.create({
                conversationId: conversation._id,
                senderId: me,
                text: body,
                flagged,
            });

            // Sort threads most-recent-first without scanning Messages.
            conversation.lastMessageAt = message.createdAt;
            await conversation.save();

            const dto = serialize(message);
            // Deliver to the other participant if they're connected; emitting to
            // an empty room is a harmless no-op when they're offline (they'll get
            // it from the REST history on next open).
            io.to(otherParticipant(conversation, me)).emit('message:receive', dto);

            return typeof ack === 'function' && ack({ ok: true, message: dto });
        } catch (err) {
            return typeof ack === 'function' && ack({ ok: false, error: 'Failed to send message' });
        }
    });

    // typing — relay a transient typing indicator to the peer. Not persisted.
    socket.on('typing', async (payload) => {
        const { conversationId, isTyping } = payload || {};
        const conversation = await findOwnedConversation(conversationId, me);
        if (!conversation) return;

        io.to(otherParticipant(conversation, me)).emit('typing', {
            conversationId: String(conversation._id),
            userId: me,
            isTyping: Boolean(isTyping),
        });
    });

    // read — mark the peer's messages to me as read and notify them so their
    // sent bubbles can flip to "read". Only the recipient's unread messages are
    // touched; my own are left alone.
    socket.on('read', async (payload, ack) => {
        try {
            const { conversationId } = payload || {};
            const conversation = await findOwnedConversation(conversationId, me);
            if (!conversation) {
                return typeof ack === 'function' && ack({ ok: false, error: 'Conversation not found' });
            }

            const readAt = new Date();
            const result = await Message.updateMany(
                { conversationId: conversation._id, senderId: { $ne: me }, readAt: null },
                { $set: { readAt } },
            );
            // Mongoose 5 reports the count as nModified; fall back to modifiedCount.
            const updated = result.nModified != null ? result.nModified : result.modifiedCount;

            io.to(otherParticipant(conversation, me)).emit('read', {
                conversationId: String(conversation._id),
                readerId: me,
                readAt,
            });

            return typeof ack === 'function' && ack({ ok: true, updated });
        } catch (err) {
            return typeof ack === 'function' && ack({ ok: false, error: 'Failed to mark read' });
        }
    });
}

module.exports = registerMessageHandlers;
