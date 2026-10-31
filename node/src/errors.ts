/**
 * Every error the SDK throws for a failed request. `status` is the HTTP status
 * (undefined when no response arrived), `code` a stable machine-readable name,
 * `body` the parsed response body, and `message` the API's own explanation.
 */
export class NotecardHQError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly body: unknown;
  readonly headers: Headers | undefined;

  constructor(message: string, init: { status?: number; code: string; body?: unknown; headers?: Headers; cause?: unknown }) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
    this.headers = init.headers;
  }
}

/** 400, 413, 415 or 422: the request was refused and nothing was created. Do not retry as is. */
export class InvalidRequestError extends NotecardHQError {}
/** 401: missing or invalid API key. */
export class AuthenticationError extends NotecardHQError {}
/** 404: no such note in this workspace (or the feature is off for it). */
export class NotFoundError extends NotecardHQError {}
/** 409: the Idempotency-Key was already used with a different body. Investigate; never mint a new key to get past it. */
export class IdempotencyConflictError extends NotecardHQError {}
/** 429: too many requests. */
export class RateLimitError extends NotecardHQError {}
/** 5xx or another unexpected status. Safe to retry with the same Idempotency-Key. */
export class APIError extends NotecardHQError {}
/** No response: network failure or timeout. Safe to retry with the same Idempotency-Key. */
export class APIConnectionError extends NotecardHQError {}
/** A webhook whose signature is missing, wrong or too old. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const CODES: Record<number, string> = {
  400: "invalid_request",
  401: "authentication_failed",
  404: "not_found",
  409: "idempotency_conflict",
  413: "request_too_large",
  415: "unsupported_media_type",
  422: "validation_failed",
  429: "rate_limited",
};

/** The error for a non-2xx response. The API answers `{ "error": "<message>" }`. */
export function errorFromResponse(status: number, body: unknown, headers?: Headers): NotecardHQError {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const message =
    typeof b?.error === "string" ? b.error : typeof body === "string" && body ? body.slice(0, 500) : `HTTP ${status}`;
  const code = typeof b?.code === "string" ? b.code : CODES[status] ?? (status >= 500 ? "server_error" : "http_error");
  const init = { status, code, body, headers };
  if (status === 401) return new AuthenticationError(message, init);
  if (status === 404) return new NotFoundError(message, init);
  if (status === 409) return new IdempotencyConflictError(message, init);
  if (status === 429) return new RateLimitError(message, init);
  if (status === 400 || status === 413 || status === 415 || status === 422) return new InvalidRequestError(message, init);
  return new APIError(message, init);
}
