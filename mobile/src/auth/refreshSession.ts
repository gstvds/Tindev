import axios from 'axios';

import { clearTokens, getTokens, saveTokens, TokenPair } from './tokenStorage';

// Shared between the REST client (api/client.ts) and the chat socket
// (realtime/chatSocket.ts) — both transports hit the same wall when the
// access token expires (a REST 401, a rejected socket handshake) and both
// need the exact same recovery: one deduped refresh call, then either
// retry/reconnect with the new token or sign out. Keeping this in one place
// means a REST 401 and a socket handshake rejection landing around the same
// moment share ONE refresh call instead of racing two against the backend's
// rotation (POST /auth/refresh invalidates a refresh token the instant it's
// redeemed, so a second concurrent call with the same old token would fail).

// Set by AuthProvider on mount (auth/AuthContext.tsx) so a failure neither
// transport can recover from forces a clean return to the login screen. This
// module can't import AuthContext's `signOut` directly — it only exists as a
// value inside the provider's React state, not a top-level export — so the
// provider hands it to us instead. Left unset (e.g. before the provider has
// mounted), forceSignOut still clears tokens, it just can't flip app state.
type SignOutHandler = () => Promise<void>;
let signOutHandler: SignOutHandler | null = null;
export function registerSignOutHandler(handler: SignOutHandler | null): void {
  signOutHandler = handler;
}

export async function forceSignOut(): Promise<void> {
  await clearTokens();
  if (signOutHandler) {
    await signOutHandler();
  }
}

let refreshPromise: Promise<void> | null = null;

async function performRefresh(baseUrl: string): Promise<void> {
  const tokens = await getTokens();
  if (!tokens?.refreshToken) {
    throw new Error('No refresh token stored');
  }
  // A bare axios.post, not routed through apiClient — this must never run
  // through apiClient's own response interceptor (that would recurse), and it
  // has no access token to attach in the first place.
  const { data } = await axios.post<TokenPair>(`${baseUrl}/auth/refresh`, {
    refreshToken: tokens.refreshToken,
  });
  await saveTokens(data);
}

// `baseUrl` is supplied by the caller (apiClient.defaults.baseURL in
// practice, for both transports) rather than imported directly here, so a
// test can point the whole refresh flow at a local server without fighting
// Expo's static inlining of EXPO_PUBLIC_* vars (see client.test.ts).
export function getOrStartRefresh(baseUrl: string): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = performRefresh(baseUrl).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}
