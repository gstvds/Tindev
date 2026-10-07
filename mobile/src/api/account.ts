import { apiClient } from './client';

// Typed wrappers around the account-level email endpoints (receipt delivery —
// see SubscriptionScreen). This is account-level, not profile-level, data:
// it's never shown on the dating profile, never verified, and never used for
// login/OTP/recovery — see backend/src/models/User.js.

// GET /account/email
export async function getMyEmail(): Promise<string | null> {
  const { data } = await apiClient.get<{ email: string | null }>('/account/email');
  return data.email;
}

// PUT /account/email — null or an empty string clears it back to null. The
// backend trims/lowercases and validates format/length, returning a 400 with
// `code: 'INVALID_EMAIL' | 'EMAIL_TOO_LONG'` on a bad value (see
// AccountController.updateEmail) — callers validate locally first so this
// mainly guards against drift between the two.
export async function updateMyEmail(email: string | null): Promise<string | null> {
  const { data } = await apiClient.put<{ email: string | null }>('/account/email', { email });
  return data.email;
}
