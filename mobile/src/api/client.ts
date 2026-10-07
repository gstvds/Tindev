import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

import { API_BASE_URL } from '../config/env';
import { getTokens } from '../auth/tokenStorage';
import { forceSignOut, getOrStartRefresh } from '../auth/refreshSession';
import { toApiError } from './errors';

// One shared axios instance for the whole app. baseURL comes from config (env),
// never hardcoded at call sites. A 20s timeout keeps the OTP screens from
// spinning forever when the backend or SMS provider is slow.
export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach the bearer token when we have one. The OTP endpoints are public, so
// this is a no-op for them, but every authenticated call made later (profile,
// discovery, …) gets the header for free.
apiClient.interceptors.request.use(async (config) => {
  const tokens = await getTokens();
  if (tokens?.accessToken) {
    config.headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  return config;
});

// Axios doesn't type a place to stash retry bookkeeping on a request config,
// so this is our own marker: true once a request has already been retried
// after a refresh, so a 401 on the retry itself doesn't start a second one.
type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

// Normalize every rejection into an ApiError so screens never see raw axios —
// except a genuine 401, which first tries exactly one refresh-and-retry cycle
// (shared with the chat socket's handshake recovery — see auth/refreshSession)
// before falling back to that same normalization.
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    if (status === 401 && config) {
      if (config._retried) {
        // The retry itself came back 401 — the freshly-issued token was
        // rejected too. Don't chase this further.
        await forceSignOut();
        return Promise.reject(toApiError(error));
      }

      config._retried = true;
      try {
        // Storage now holds the new pair; the request interceptor above picks
        // the new access token up on this retry, so there's nothing to set
        // on `config` here.
        await getOrStartRefresh(apiClient.defaults.baseURL as string);
        return apiClient.request(config);
      } catch {
        await forceSignOut();
        return Promise.reject(toApiError(error));
      }
    }

    return Promise.reject(toApiError(error));
  },
);
