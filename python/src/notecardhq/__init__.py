"""notecardHQ: send real handwritten notes and cards by API.

A robot writes each card with a real pen, then it is stamped and mailed.
Docs: https://app.notecardhq.com/docs
"""

from ._client import DEFAULT_BASE_URL, AsyncNotecardHQ, NotecardHQ
from ._errors import (
    APIConnectionError,
    APIError,
    AuthenticationError,
    IdempotencyConflictError,
    InvalidRequestError,
    NotecardHQError,
    NotFoundError,
    RateLimitError,
    WebhookVerificationError,
)
from ._types import (
    Address,
    HoldoutReport,
    Note,
    NoteParams,
    NoteStatus,
    RecentNote,
    RecentNotesPage,
    RedactionResult,
    WebhookEvent,
    WebhookEventType,
    WritingStyle,
)
from ._version import __version__
from ._webhooks import (
    DEFAULT_TOLERANCE_SECONDS,
    EVENT_ID_HEADER,
    SIGNATURE_HEADER,
    sign_webhook_payload,
    verify_webhook,
    verify_webhook_signature,
)

__all__ = [
    "NotecardHQ",
    "AsyncNotecardHQ",
    "DEFAULT_BASE_URL",
    "NotecardHQError",
    "InvalidRequestError",
    "AuthenticationError",
    "NotFoundError",
    "IdempotencyConflictError",
    "RateLimitError",
    "APIError",
    "APIConnectionError",
    "WebhookVerificationError",
    "verify_webhook",
    "verify_webhook_signature",
    "sign_webhook_payload",
    "SIGNATURE_HEADER",
    "EVENT_ID_HEADER",
    "DEFAULT_TOLERANCE_SECONDS",
    "Address",
    "Note",
    "NoteParams",
    "NoteStatus",
    "RecentNote",
    "RecentNotesPage",
    "RedactionResult",
    "HoldoutReport",
    "WebhookEvent",
    "WebhookEventType",
    "WritingStyle",
    "__version__",
]
