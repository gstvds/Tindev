import type { AddressInfo } from 'net';
import http from 'http';
import { Server as IOServer, Socket as ServerSocket } from 'socket.io';
import * as React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

import { apiClient } from '../../api/client';
import * as tokenStorage from '../../auth/tokenStorage';
import { registerSignOutHandler } from '../../auth/refreshSession';
import { useChatSocket, ChatSocket } from '../chatSocket';

// expo-secure-store is a native module — under Jest there's no device, so it's
// replaced with an in-memory Map, same as client.test.ts.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

// A minimal `renderHook` — no @testing-library/react-hooks in this project,
// and useChatSocket is small enough that a bare react-test-renderer host
// component is simpler than adding a new dependency for one test file.
// Renderers are tracked and unmounted in afterEach below — without that, the
// hook's socket (and its reconnection timers) outlives the test, and Jest
// hangs waiting for the event loop to drain instead of exiting.
const activeRenderers: ReactTestRenderer[] = [];

function renderChatSocket(): { result: { current: ChatSocket } } {
  const result: { current: ChatSocket } = { current: undefined as unknown as ChatSocket };
  function TestHost() {
    result.current = useChatSocket({ onMessage: () => {}, onTyping: () => {}, onRead: () => {} });
    return null;
  }
  act(() => {
    activeRenderers.push(create(React.createElement(TestHost)));
  });
  return { result };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

// A real Socket.IO server (not a mock) — this test is exercising the actual
// socket.io-client wire behavior discovered while building this chunk (a
// rejected handshake does NOT auto-retry, unlike a transport error), so a
// faithful server is what makes the test meaningful.
let httpServer: http.Server;
let io: IOServer;
let serverSocket: ServerSocket | null;
let authCheck: (token: string | null | undefined) => boolean;
let refreshHandler: (refreshToken: string | undefined) => { status: number; body: unknown };
let refreshCallCount: number;

beforeAll((done) => {
  httpServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/auth/refresh') {
      refreshCallCount += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const { status, body: responseBody } = refreshHandler(body.refreshToken);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  io = new IOServer(httpServer, { cors: { origin: '*' } });
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (authCheck(token)) return next();
    return next(new Error('Invalid or expired token'));
  });
  io.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message:send', (_payload, ack) => {
      if (typeof ack === 'function') {
        ack({ ok: true, message: { id: 'm1', conversationId: 'c1', text: 'echo', senderId: 'other' } });
      }
    });
  });

  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = httpServer.address() as AddressInfo;
    apiClient.defaults.baseURL = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  io.close();
  httpServer.close(done);
});

beforeEach(async () => {
  await tokenStorage.clearTokens();
  registerSignOutHandler(null);
  serverSocket = null;
  refreshCallCount = 0;
  authCheck = () => true;
  refreshHandler = () => ({ status: 200, body: { accessToken: 'unused', refreshToken: 'unused' } });
});

afterEach(() => {
  act(() => {
    while (activeRenderers.length) {
      activeRenderers.pop()?.unmount();
    }
  });
});

describe('useChatSocket handshake recovery', () => {
  it('an expired access token at initial connect triggers a refresh, then connects with the fresh token', async () => {
    await tokenStorage.saveTokens({ accessToken: 'expired-access', refreshToken: 'good-refresh' });
    authCheck = (token) => token === 'fresh-access';
    refreshHandler = (refreshToken) => {
      if (refreshToken === 'good-refresh') {
        return { status: 200, body: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' } };
      }
      return { status: 401, body: { error: 'Invalid', code: 'INVALID_REFRESH_TOKEN' } };
    };

    const { result } = renderChatSocket();

    await waitFor(() => result.current.connectionState === 'connected');

    expect(refreshCallCount).toBe(1);
    expect(await tokenStorage.getTokens()).toEqual({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
    });
  });

  it('a token that expires mid-session (rejected on the reconnect after a drop) refreshes instead of looping', async () => {
    await tokenStorage.saveTokens({ accessToken: 'session-access', refreshToken: 'session-refresh' });
    authCheck = (token) => token === 'session-access'; // valid for now — accepted at initial connect

    const { result } = renderChatSocket();
    await waitFor(() => result.current.connectionState === 'connected');
    expect(refreshCallCount).toBe(0);

    // Simulate the access token's 15-minute window elapsing while connected:
    // the token that was fine a moment ago is no longer accepted, and THEN a
    // drop forces socket.io-client's auto-reconnect to attempt a fresh
    // handshake with it — which the server now rejects. Closing the
    // underlying engine.io transport (not the graceful `socket.disconnect()`)
    // is deliberate: a server-initiated `disconnect()` sends reason
    // `"io server disconnect"`, which socket.io-client explicitly does NOT
    // auto-reconnect from (confirmed directly — see
    // docs/implementation-log.md). `conn.close()` produces `"transport
    // close"`, the same reason a real network drop would, which DOES trigger
    // the client's normal automatic reconnection — that's what this test (and
    // the "ordinary network drop" test below) needs to simulate.
    authCheck = (token) => token === 'refreshed-access';
    refreshHandler = (refreshToken) => {
      if (refreshToken === 'session-refresh') {
        return { status: 200, body: { accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' } };
      }
      return { status: 401, body: { error: 'Invalid', code: 'INVALID_REFRESH_TOKEN' } };
    };
    serverSocket?.conn.close();

    // socket.io-client's default reconnection backoff (up to ~5s with
    // jitter) has to elapse before the client even attempts the handshake
    // that gets rejected, so this needs real headroom above Jest's default
    // 5s test timeout — see the `it(...)` timeout argument below.
    await waitFor(() => result.current.connectionState === 'connected' && refreshCallCount > 0, 12000);

    expect(refreshCallCount).toBe(1);
    expect(await tokenStorage.getTokens()).toEqual({
      accessToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
    });
  }, 15000);

  it('a refresh failure during handshake recovery signs out cleanly instead of leaving a stuck socket', async () => {
    await tokenStorage.saveTokens({ accessToken: 'dead-access', refreshToken: 'dead-refresh' });
    authCheck = () => false; // nothing this client ever sends is accepted
    refreshHandler = () => ({ status: 401, body: { error: 'Invalid', code: 'INVALID_REFRESH_TOKEN' } });

    const signOut = jest.fn(async () => {});
    registerSignOutHandler(signOut);

    const { result } = renderChatSocket();

    await waitFor(() => signOut.mock.calls.length > 0);

    expect(result.current.connectionState).toBe('disconnected');
    expect(refreshCallCount).toBe(1); // exactly one attempt, no retry loop
    expect(await tokenStorage.getTokens()).toBeNull();
  });

  it('an ordinary network drop with a still-valid token reconnects normally without touching refresh', async () => {
    await tokenStorage.saveTokens({ accessToken: 'still-good', refreshToken: 'still-good-refresh' });
    authCheck = (token) => token === 'still-good'; // stays valid for the whole test

    const { result } = renderChatSocket();
    await waitFor(() => result.current.connectionState === 'connected');

    serverSocket?.conn.close(); // a transport-level drop, not an auth rejection — see note above
    await waitFor(() => result.current.connectionState === 'disconnected');
    await waitFor(() => result.current.connectionState === 'connected', 12000);

    expect(refreshCallCount).toBe(0);
    // Token in storage is untouched — nothing needed refreshing.
    expect(await tokenStorage.getTokens()).toEqual({
      accessToken: 'still-good',
      refreshToken: 'still-good-refresh',
    });
  }, 15000);

  it('regression: send still works once connected (unrelated to this chunk, but the connection setup around it changed)', async () => {
    await tokenStorage.saveTokens({ accessToken: 'still-good', refreshToken: 'still-good-refresh' });
    authCheck = (token) => token === 'still-good';

    const { result } = renderChatSocket();
    await waitFor(() => result.current.connectionState === 'connected');

    const message = await result.current.sendMessage('c1', 'hello');
    expect(message).toEqual({ id: 'm1', conversationId: 'c1', text: 'echo', senderId: 'other' });
  });
});
