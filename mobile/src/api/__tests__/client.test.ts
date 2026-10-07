import type { AddressInfo } from 'net';
import http from 'http';

import { apiClient } from '../client';
import { registerSignOutHandler } from '../../auth/refreshSession';
import * as tokenStorage from '../../auth/tokenStorage';
import { parseFieldErrors } from '../profile';

// expo-secure-store is a native module — under Jest there's no device, so it's
// replaced with an in-memory Map. Good enough: tokenStorage.ts only ever calls
// get/set/deleteItemAsync, never anything native-specific.
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

type RouteHandler = (body: unknown, authHeader: string | undefined) => { status: number; body: unknown };

// A minimal real HTTP server standing in for the backend. Each test installs
// its own `routes` map before making requests through the real `apiClient` —
// this exercises the actual interceptor code in client.ts against real
// network round-trips, not a mocked axios. `apiClient.defaults.baseURL` is
// pointed at this server below (NOT the EXPO_PUBLIC_API_BASE_URL env var —
// Expo's babel preset statically inlines that at transform time, so a runtime
// `process.env` write has no effect on the already-compiled config/env.ts).
let server: http.Server;
let routes: Record<string, RouteHandler>;
let requestLog: Array<{ method: string; url: string; authHeader: string | undefined }>;

beforeAll((done) => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;

    requestLog.push({ method: req.method as string, url: req.url as string, authHeader: req.headers.authorization });

    const handler = routes[`${req.method} ${req.url}`];
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `no test route for ${req.method} ${req.url}` }));
      return;
    }
    const { status, body: responseBody } = handler(body, req.headers.authorization);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    apiClient.defaults.baseURL = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(async () => {
  routes = {};
  requestLog = [];
  registerSignOutHandler(null);
  await tokenStorage.clearTokens();
});

describe('apiClient 401 refresh-and-retry', () => {
  it('retries the original request once refresh succeeds — caller never sees the 401', async () => {
    await tokenStorage.saveTokens({ accessToken: 'old-access', refreshToken: 'old-refresh' });

    routes['GET /protected'] = (_body, authHeader) => {
      if (authHeader === 'Bearer new-access') return { status: 200, body: { ok: true } };
      return { status: 401, body: { error: 'Invalid or expired token' } };
    };
    routes['POST /auth/refresh'] = (body) => {
      const b = body as { refreshToken?: string };
      if (b.refreshToken === 'old-refresh') {
        return { status: 200, body: { accessToken: 'new-access', refreshToken: 'new-refresh' } };
      }
      return { status: 401, body: { error: 'Invalid', code: 'INVALID_REFRESH_TOKEN' } };
    };

    const response = await apiClient.get('/protected');

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });

    const refreshCalls = requestLog.filter((r) => r.url === '/auth/refresh');
    expect(refreshCalls).toHaveLength(1);

    const stored = await tokenStorage.getTokens();
    expect(stored).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  });

  it('signs out when the refresh call itself fails — no retry, no loop', async () => {
    await tokenStorage.saveTokens({ accessToken: 'old-access', refreshToken: 'dead-refresh' });

    routes['GET /protected'] = () => ({ status: 401, body: { error: 'Invalid or expired token' } });
    routes['POST /auth/refresh'] = () => ({
      status: 401,
      body: { error: 'This refresh token has already been used', code: 'INVALID_REFRESH_TOKEN' },
    });

    const signOut = jest.fn(async () => {});
    registerSignOutHandler(signOut);

    await expect(apiClient.get('/protected')).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(await tokenStorage.getTokens()).toBeNull();

    // Exactly one attempt at the original request — the interceptor does not
    // retry after a failed refresh.
    expect(requestLog.filter((r) => r.url === '/protected')).toHaveLength(1);
    expect(requestLog.filter((r) => r.url === '/auth/refresh')).toHaveLength(1);
  });

  it('dedupes concurrent 401s into a single refresh call', async () => {
    await tokenStorage.saveTokens({ accessToken: 'old-access', refreshToken: 'old-refresh' });

    let refreshCallCount = 0;
    for (const path of ['/a', '/b', '/c']) {
      routes[`GET ${path}`] = (_body, authHeader) => {
        if (authHeader === 'Bearer new-access') return { status: 200, body: { path } };
        return { status: 401, body: { error: 'Invalid or expired token' } };
      };
    }
    routes['POST /auth/refresh'] = () => {
      refreshCallCount += 1;
      return { status: 200, body: { accessToken: 'new-access', refreshToken: 'new-refresh' } };
    };

    const [a, b, c] = await Promise.all([apiClient.get('/a'), apiClient.get('/b'), apiClient.get('/c')]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(refreshCallCount).toBe(1);
    expect(requestLog.filter((r) => r.url === '/auth/refresh')).toHaveLength(1);
  });

  it('a retry that 401s again does not start a second refresh', async () => {
    await tokenStorage.saveTokens({ accessToken: 'old-access', refreshToken: 'old-refresh' });

    let refreshCallCount = 0;
    routes['GET /protected'] = () => ({ status: 401, body: { error: 'Invalid or expired token' } });
    routes['POST /auth/refresh'] = () => {
      refreshCallCount += 1;
      return { status: 200, body: { accessToken: 'still-rejected', refreshToken: 'new-refresh' } };
    };

    const signOut = jest.fn(async () => {});
    registerSignOutHandler(signOut);

    await expect(apiClient.get('/protected')).rejects.toMatchObject({ kind: 'unauthorized' });

    expect(refreshCallCount).toBe(1);
    expect(requestLog.filter((r) => r.url === '/protected')).toHaveLength(2); // original + one retry
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('does not touch refresh for a non-401 4xx — existing validation-error handling is unaffected', async () => {
    await tokenStorage.saveTokens({ accessToken: 'old-access', refreshToken: 'old-refresh' });

    routes['PUT /profile/me'] = () => ({
      status: 400,
      body: { error: 'Profile validation failed: dob: Cast to Date failed for value "x" at path `dob`.' },
    });

    let caught: unknown;
    try {
      await apiClient.put('/profile/me', {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ kind: 'validation', status: 400 });
    expect(requestLog.filter((r) => r.url === '/auth/refresh')).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseFieldErrors(caught as any)).toEqual({ dob: 'Cast to Date failed for value "x" at path `dob`' });
  });
});
