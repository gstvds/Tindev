import { Platform } from 'react-native';

// The backend base URL is configuration, never hardcoded into feature code.
// Expo inlines any `EXPO_PUBLIC_*` variable from `.env` at build time, so this is
// the single place that reads it. If it is unset we fall back to a sensible
// localhost default per platform (the host loopback differs on the Android
// emulator) and warn loudly, because a wrong base URL is the most common reason
// the OTP calls appear to "hang" in development.

function defaultBaseUrl(): string {
  // Android emulator cannot reach the host via `localhost`; 10.0.2.2 is the
  // special alias that maps back to the developer machine.
  if (Platform.OS === 'android') return 'http://10.0.2.2:3333';
  return 'http://localhost:3333';
}

const configured = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

if (!configured) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] EXPO_PUBLIC_API_BASE_URL is not set — falling back to ' +
      `${defaultBaseUrl()}. Copy mobile/.env.example to mobile/.env to configure it.`,
  );
}

// Strip any trailing slash so path joins like `${API_BASE_URL}/auth/...` stay clean.
export const API_BASE_URL = (configured || defaultBaseUrl()).replace(/\/+$/, '');
