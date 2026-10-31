from __future__ import annotations

from typing import Any, Dict, Optional, Type

import httpx


class NotecardHQError(Exception):
    """Every error the SDK raises for a failed request.

    ``status`` is the HTTP status (None when no response arrived), ``code`` a
    stable machine-readable name, ``body`` the parsed response body, and the
    message the API's own explanation.
    """

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: str,
        body: Any = None,
        headers: Optional[httpx.Headers] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.body = body
        self.headers = headers

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status!r}, code={self.code!r}, message={self.message!r})"


class InvalidRequestError(NotecardHQError):
    """400, 413, 415 or 422: refused; nothing was created. Do not retry as is."""


class AuthenticationError(NotecardHQError):
    """401: missing or invalid API key."""


class NotFoundError(NotecardHQError):
    """404: no such note in this workspace (or the feature is off for it)."""


class IdempotencyConflictError(NotecardHQError):
    """409: the Idempotency-Key was used with a different body. Investigate; never mint a new key to get past it."""


class RateLimitError(NotecardHQError):
    """429: too many requests."""


class APIError(NotecardHQError):
    """5xx or another unexpected status. Safe to retry with the same Idempotency-Key."""


class APIConnectionError(NotecardHQError):
    """No response: network failure or timeout. Safe to retry with the same Idempotency-Key."""


class WebhookVerificationError(Exception):
    """A webhook whose signature is missing, wrong or too old."""


_CODES: Dict[int, str] = {
    400: "invalid_request",
    401: "authentication_failed",
    404: "not_found",
    409: "idempotency_conflict",
    413: "request_too_large",
    415: "unsupported_media_type",
    422: "validation_failed",
    429: "rate_limited",
}

_TYPES: Dict[int, Type[NotecardHQError]] = {
    400: InvalidRequestError,
    401: AuthenticationError,
    404: NotFoundError,
    409: IdempotencyConflictError,
    413: InvalidRequestError,
    415: InvalidRequestError,
    422: InvalidRequestError,
    429: RateLimitError,
}


def error_from_response(status: int, body: Any, headers: Optional[httpx.Headers] = None) -> NotecardHQError:
    """The error for a non-2xx response. The API answers ``{"error": "<message>"}``."""
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        message = body["error"]
    elif isinstance(body, str) and body:
        message = body[:500]
    else:
        message = f"HTTP {status}"
    if isinstance(body, dict) and isinstance(body.get("code"), str):
        code = body["code"]
    else:
        code = _CODES.get(status, "server_error" if status >= 500 else "http_error")
    return _TYPES.get(status, APIError)(message, status=status, code=code, body=body, headers=headers)
