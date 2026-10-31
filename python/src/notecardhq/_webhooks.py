from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Optional, Union, cast

from ._errors import WebhookVerificationError
from ._types import WebhookEvent

SIGNATURE_HEADER = "notecardHQ-Signature"
"""The header carrying ``t=<unix seconds>,v1=<hex HMAC-SHA256>``."""
EVENT_ID_HEADER = "notecardHQ-Event-Id"
DEFAULT_TOLERANCE_SECONDS = 300

Payload = Union[str, bytes, bytearray, memoryview]


def _bytes(payload: Payload) -> bytes:
    return payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)


def sign_webhook_payload(payload: Payload, secret: str, timestamp: Optional[int] = None) -> str:
    """``t=<t>,v1=<hex HMAC-SHA256 of "<t>.<payload>">``: the header the server sends. Useful in your own tests."""
    t = int(time.time()) if timestamp is None else timestamp
    mac = hmac.new(secret.encode("utf-8"), f"{t}.".encode("ascii") + _bytes(payload), hashlib.sha256)
    return f"t={t},v1={mac.hexdigest()}"


def _check(payload: Payload, header: Optional[str], secret: str, tolerance_seconds: int) -> None:
    if not secret:
        raise WebhookVerificationError("No webhook secret given.")
    if not header:
        raise WebhookVerificationError(f"Missing {SIGNATURE_HEADER} header.")
    t: Optional[int] = None
    signatures = []
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if key == "t":
            t = int(value) if value.isascii() and value.isdigit() else None
        elif key == "v1":
            signatures.append(value.lower())
    if t is None or not signatures:
        raise WebhookVerificationError(f"Malformed {SIGNATURE_HEADER} header.")
    if abs(time.time() - t) > tolerance_seconds:
        raise WebhookVerificationError("Signature timestamp is outside the tolerance.")
    expected = sign_webhook_payload(payload, secret, t).split("v1=", 1)[1]
    if not any(hmac.compare_digest(s, expected) for s in signatures):
        raise WebhookVerificationError("Signature does not match.")


def verify_webhook(
    payload: Payload,
    header: Optional[str],
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
) -> WebhookEvent:
    """Verify a webhook and return its event.

    ``payload`` must be the raw request body exactly as received (bytes or
    str), not JSON that was parsed and serialized again. Raises
    WebhookVerificationError when the signature is missing, malformed, wrong,
    or older than ``tolerance_seconds`` (default five minutes).
    """
    _check(payload, header, secret, tolerance_seconds)
    try:
        return cast(WebhookEvent, json.loads(_bytes(payload)))
    except ValueError:
        raise WebhookVerificationError("Payload is not JSON.") from None


def verify_webhook_signature(
    payload: Payload,
    header: Optional[str],
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
) -> bool:
    """True when the signature is valid and recent; False otherwise. Does not parse the payload."""
    try:
        _check(payload, header, secret, tolerance_seconds)
        return True
    except WebhookVerificationError:
        return False
