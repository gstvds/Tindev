import { apiClient } from './client';
import { TokenPair } from '../auth/tokenStorage';

// Typed wrappers around the two auth endpoints (spec §6). Request/response
// shapes mirror the backend AuthController exactly.

export type RequestOtpResponse = {
  message: string;
  phone: string; // normalized to 234XXXXXXXXXX by the backend
};

export type VerifyOtpResponse = TokenPair & {
  message: string;
  phone: string;
  verificationTier: string;
};

// POST /auth/otp/request  { phone }
// The backend accepts common local formats (08012345678, +234…, 234…) and
// normalizes server-side, so we send whatever the user typed.
export async function requestOtp(phone: string): Promise<RequestOtpResponse> {
  const { data } = await apiClient.post<RequestOtpResponse>('/auth/otp/request', { phone });
  return data;
}

// POST /auth/otp/verify  { phone, code } -> access + refresh tokens
export async function verifyOtp(phone: string, code: string): Promise<VerifyOtpResponse> {
  const { data } = await apiClient.post<VerifyOtpResponse>('/auth/otp/verify', { phone, code });
  return data;
}
