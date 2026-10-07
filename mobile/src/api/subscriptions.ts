import { apiClient } from './client';

// Typed wrappers around the subscription endpoints (spec §6, §7). Android/web
// pays through Paystack's hosted checkout; iOS has no purchase path yet (see
// SubscriptionScreen).

export type SubscriptionPlan = 'free' | 'unlimited';
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired';
export type PaymentPlatform = 'ios_iap' | 'paystack' | null;

// GET /subscriptions/me response. A user who has never subscribed gets the
// defaulted free/active shape rather than a 404 — see SubscriptionController.getMe.
export type SubscriptionStatusResponse = {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  paymentPlatform: PaymentPlatform;
  currentPeriodEnd: string | null; // ISO date string
};

// GET /subscriptions/me
export async function getSubscriptionStatus(): Promise<SubscriptionStatusResponse> {
  const { data } = await apiClient.get<SubscriptionStatusResponse>('/subscriptions/me');
  return data;
}

// POST /subscriptions/subscribe/paystack response. The plan activates only once
// the signature-verified webhook lands — this call starts checkout, nothing more.
export type SubscribeResponse = {
  message: string;
  authorizationUrl: string;
  accessCode: string;
  reference: string;
};

// POST /subscriptions/subscribe/paystack — Android/web only (spec §6). Throws an
// ApiError with status 409 if the caller already has an active Unlimited plan.
export async function subscribeToUnlimited(): Promise<SubscribeResponse> {
  const { data } = await apiClient.post<SubscribeResponse>('/subscriptions/subscribe/paystack');
  return data;
}
