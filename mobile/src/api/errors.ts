import axios from 'axios';

// A single, predictable error shape the screens can switch on, instead of every
// screen re-parsing axios internals. `kind` classifies the failure so the UI can
// react (e.g. start a cooldown timer on `rate_limited`) without string-matching
// the human message; `message` is the backend's own text, safe to show as-is.
export type ApiErrorKind =
  | 'validation' // 400 — bad phone format, missing/invalid code, expired code
  | 'unauthorized' // 401 — missing/expired/invalid credential
  | 'rate_limited' // 429 — cooldown or hourly cap
  | 'server' // 5xx — includes 502 when the SMS provider fails
  | 'network' // request never got a response (offline, wrong base URL, CORS)
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Seconds to wait before retrying, from the 429 `Retry-After` header. */
  readonly retryAfterSeconds: number | null;
  /** Remaining OTP attempts, when the backend reports it on a wrong code. */
  readonly attemptsLeft: number | null;
  /**
   * A machine-readable error code the backend sometimes attaches alongside the
   * human message (e.g. `NIN_REQUIRED` on the 403 from PUT
   * /profile/discovery-settings). Lets a screen branch on the specific reason
   * without matching the message text.
   */
  readonly code: string | null;

  constructor(params: {
    message: string;
    kind: ApiErrorKind;
    status: number | null;
    retryAfterSeconds?: number | null;
    attemptsLeft?: number | null;
    code?: string | null;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.kind = params.kind;
    this.status = params.status;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
    this.attemptsLeft = params.attemptsLeft ?? null;
    this.code = params.code ?? null;
  }
}

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return 'unknown';
}

// The backend's 429 cooldown also embeds the seconds in its message
// ("Please wait 42s before requesting another code"). We prefer the Retry-After
// header, but fall back to parsing the message so the UI can still count down.
function parseRetryAfter(headerValue: unknown, message: string): number | null {
  const fromHeader = Number(headerValue);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);

  const match = /(\d+)\s*s/i.exec(message);
  if (match) return Number(match[1]);

  return null;
}

// Convert anything thrown by axios into an ApiError. Called from one place
// (the client interceptor) so screens only ever catch ApiError.
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (axios.isAxiosError(error)) {
    const response = error.response;

    // No response => the request never reached a working server.
    if (!response) {
      return new ApiError({
        message:
          'Could not reach the server. Check your connection and that the API URL is correct.',
        kind: 'network',
        status: null,
      });
    }

    const status = response.status;
    const data = response.data as
      | { error?: string; attemptsLeft?: number; code?: string }
      | undefined;
    const message =
      (typeof data?.error === 'string' && data.error) ||
      'Something went wrong. Please try again.';

    return new ApiError({
      message,
      kind: kindForStatus(status),
      status,
      retryAfterSeconds:
        status === 429 ? parseRetryAfter(response.headers?.['retry-after'], message) : null,
      attemptsLeft: typeof data?.attemptsLeft === 'number' ? data.attemptsLeft : null,
      code: typeof data?.code === 'string' ? data.code : null,
    });
  }

  return new ApiError({
    message: error instanceof Error ? error.message : 'Unexpected error',
    kind: 'unknown',
    status: null,
  });
}
