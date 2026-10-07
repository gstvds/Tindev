import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

import { apiClient } from '../api/client';
import { getTokens } from '../auth/tokenStorage';
import { forceSignOut, getOrStartRefresh } from '../auth/refreshSession';
import { Message } from '../api/messaging';

// The mobile half of the Socket.IO messaging contract (backend
// src/socket/messageHandlers.js). The connection authenticates with the stored
// access token in the handshake `auth.token` — the same field the backend's
// io.use middleware reads — and delivers to the user's own room, so there's no
// per-conversation "join": every one of the user's threads arrives on this one
// socket and the chat screen filters by conversationId.
//
// Connection state is surfaced honestly (connecting / connected / disconnected)
// so the UI can tell the user when messages can't be sent, rather than silently
// dropping them.

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

// Server → client event payloads (mirror the backend emits exactly).
export type TypingEvent = { conversationId: string; userId: string; isTyping: boolean };
export type ReadEvent = { conversationId: string; readerId: string; readAt: string };

// The ack the server sends back to `message:send`.
type SendAck = { ok: true; message: Message } | { ok: false; error: string };

type Handlers = {
  onMessage: (message: Message) => void;
  onTyping: (event: TypingEvent) => void;
  onRead: (event: ReadEvent) => void;
};

export type ChatSocket = {
  connectionState: ConnectionState;
  // Resolves with the stored message (server id/timestamp/flagged verdict) once
  // the server acks; rejects if we're offline or the server rejects the send.
  sendMessage: (conversationId: string, text: string) => Promise<Message>;
  setTyping: (conversationId: string, isTyping: boolean) => void;
  markRead: (conversationId: string) => void;
};

// A rejected handshake (the backend's `io.use` calling `next(new Error(...))`
// for a missing/expired/invalid token, or a user that's gone/suspended —
// src/socket/index.js) surfaces on the client as a plain `Error` with no
// `.type`. A transport-level failure (offline, wrong host, server down)
// surfaces instead as socket.io-client's own `TransportError`, which DOES
// carry `.type === 'TransportError'`. Verified directly against the real
// backend (see docs/implementation-log.md): socket.io-client's Manager
// auto-retries the latter on its own, but by design does NOT retry a
// rejected handshake at all — left alone, that case just goes silently dead.
function isHandshakeAuthRejection(err: Error): boolean {
  return (err as Error & { type?: string }).type !== 'TransportError';
}

export function useChatSocket(handlers: Handlers): ChatSocket {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const socketRef = useRef<Socket | null>(null);

  // Keep the latest handlers in a ref so the effect that opens the socket runs
  // exactly once (on mount) instead of tearing down and reconnecting whenever the
  // screen re-renders with new closures.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    let socket: Socket | null = null;
    // True once a refresh has already been tried for the CURRENT handshake
    // failure. Reset on a successful connect, so a later, independent auth
    // rejection (e.g. the refresh token eventually expiring on its own 30-day
    // clock) can try again — but a refresh whose new token the server ALSO
    // rejects doesn't loop.
    let refreshedForThisFailure = false;

    (async () => {
      const tokens = await getTokens();
      if (cancelled) return;
      if (!tokens?.accessToken) {
        // No token to authenticate the handshake — reflect that instead of
        // spinning forever on "connecting".
        setConnectionState('disconnected');
        return;
      }

      socket = io(apiClient.defaults.baseURL as string, {
        // A function, not a static object: socket.io-client calls this fresh
        // on the initial connect AND every reconnect/manual-reconnect
        // attempt, so it always sends whatever token is CURRENTLY in storage
        // — never the value captured once when the hook mounted.
        auth: (cb) => {
          getTokens().then((current) => cb({ token: current?.accessToken ?? null }));
        },
        transports: ['websocket'], // RN has no XHR polling fallback worth using
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        refreshedForThisFailure = false;
        setConnectionState('connected');
      });
      // Covers server-initiated drops, network loss, and the manager giving up.
      socket.on('disconnect', () => setConnectionState('disconnected'));

      // A failed handshake. Transport-level failures (offline, server
      // unreachable) fall through to socket.io-client's own automatic
      // reconnection, unchanged — those should just keep retrying with
      // whatever token is currently valid, not trigger a refresh.
      socket.on('connect_error', (err: Error) => {
        if (cancelled) return;

        if (!isHandshakeAuthRejection(err)) {
          setConnectionState('connecting');
          return;
        }

        if (refreshedForThisFailure) {
          // The refreshed token was rejected too — don't chase this further.
          setConnectionState('disconnected');
          socket?.disconnect();
          void forceSignOut();
          return;
        }
        refreshedForThisFailure = true;

        getOrStartRefresh(apiClient.defaults.baseURL as string)
          .then(() => {
            if (cancelled) return;
            // The Manager does not retry a rejected handshake on its own —
            // ask it to try again now that storage holds a fresh token, which
            // the `auth` function above will pick up.
            socket?.connect();
          })
          .catch(() => {
            if (cancelled) return;
            setConnectionState('disconnected');
            socket?.disconnect();
            void forceSignOut();
          });
      });

      socket.io.on('reconnect_attempt', () => setConnectionState('connecting'));

      socket.on('message:receive', (message: Message) => handlersRef.current.onMessage(message));
      socket.on('typing', (event: TypingEvent) => handlersRef.current.onTyping(event));
      socket.on('read', (event: ReadEvent) => handlersRef.current.onRead(event));
    })();

    return () => {
      cancelled = true;
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
      }
      socketRef.current = null;
    };
  }, []);

  const sendMessage = useCallback((conversationId: string, text: string) => {
    return new Promise<Message>((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        reject(new Error('You’re offline. Reconnect to send this message.'));
        return;
      }
      socket.emit('message:send', { conversationId, text }, (ack: SendAck) => {
        if (ack && ack.ok) resolve(ack.message);
        else reject(new Error((ack && !ack.ok && ack.error) || 'Failed to send message.'));
      });
    });
  }, []);

  const setTyping = useCallback((conversationId: string, isTyping: boolean) => {
    // Fire-and-forget — the backend doesn't ack typing, and a lost indicator is
    // harmless. Guard on connected so we don't queue stale typing state.
    if (socketRef.current?.connected) {
      socketRef.current.emit('typing', { conversationId, isTyping });
    }
  }, []);

  const markRead = useCallback((conversationId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('read', { conversationId });
    }
  }, []);

  return { connectionState, sendMessage, setTyping, markRead };
}
