import * as SecureStore from 'expo-secure-store';

// JWTs are sensitive credentials, so they live in the OS secure enclave
// (Keychain on iOS, Keystore-backed EncryptedSharedPreferences on Android) via
// expo-secure-store — never in AsyncStorage/plain files. Keys are namespaced so
// they don't collide with anything else the app stores later.
const ACCESS_TOKEN_KEY = 'sabipesin.accessToken';
const REFRESH_TOKEN_KEY = 'sabipesin.refreshToken';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

export async function saveTokens(tokens: TokenPair): Promise<void> {
  // Persist both in parallel; either failing rejects the whole save so we never
  // end up with a half-written credential pair.
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken),
  ]);
}

export async function getTokens(): Promise<TokenPair | null> {
  const [accessToken, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
  ]);

  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
  ]);
}
