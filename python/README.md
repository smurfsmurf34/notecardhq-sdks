# notecardhq

The official Python SDK for the [notecardHQ](https://notecardhq.com) handwritten notes API. Send a real handwritten card from code: a robot writes it with a real pen, then it is stamped and mailed.

- Python 3.9+, one dependency (`httpx`).
- Sync and asyncio clients, type hints (`py.typed`).
- Typed errors, safe retries with idempotency keys, and a webhook signature verifier.

## Install

```sh
pip install notecardhq
```

## Send a card

```python
import os
from notecardhq import NotecardHQ

notecard = NotecardHQ(os.environ["NOTECARDHQ_API_KEY"])

note = notecard.notes.create(
    {
        "recipient": {"firstName": "Brandy", "lastName": "Lee", "address1": "123 Main St", "city": "Austin", "state": "TX", "postalCode": "78701", "country": "US"},
        "content": "Hi Brandy, congrats on your first sale! Cheering you on from Austin.",
        "externalId": "user_123",
    },
    idempotency_key="first-sale:user_123",
)
print(note["id"], note["status"])  # "created": queued for the robots
```

The note is the JSON body the API documents, as a dict (typed as `NoteParams`). `content` is written on the card exactly as sent: 1 to 500 characters, greeting and sign-off included. US addresses are verified; an undeliverable one is refused with a 422 and nothing is created.

## Test keys never mail a card

Create keys under Integrations in your notecardHQ portal. A live key looks like `mos_...`; a test key looks like `mos_test_...`.

A test key runs exactly the same validation as a live key (address verification included) and returns the same errors, but the note is never written, mailed or billed. It comes back with `"test": True` and moves through `created`, `card_printed` and `card_dispatched` a minute apart, firing the same webhooks. Use the test key in development and CI.

```python
notecard = NotecardHQ(os.environ["NOTECARDHQ_TEST_KEY"])
notecard.is_test  # True
```

With a live key, every accepted `notes.create` mails a real card, so never use it as a connectivity check.

## Idempotency

Pass one stable `idempotency_key` per event, such as `f"first-sale:{user_id}"`. Repeating the same key and body returns the same note instead of mailing a second card; the same key with a different body raises `IdempotencyConflictError` (409). Standard workspaces require the key.

The client retries network errors, 429 and 5xx (twice by default, `max_retries`) only when that is safe: reads, redactions, and `notes.create` calls that carry an `idempotency_key`.

## Reading notes

```python
from datetime import datetime, timedelta, timezone

note = notecard.notes.get("k57abc123")
note["status"]  # "created" | "card_printed" | "card_dispatched" | "cancelled" | ...

# Poll for status changes, newest first:
page = notecard.notes.list_recent(updated_since=datetime.now(timezone.utc) - timedelta(days=1), limit=100)
for n in notecard.notes.iterate_recent(limit=100):
    print(n["id"], n["status"], n["updatedAt"])
```

| Method | Endpoint |
| --- | --- |
| `notes.create(note, idempotency_key=...)` | `POST /notes` |
| `notes.get(id)` | `GET /notes/{id}` |
| `notes.list_recent(limit=, updated_since=, cursor=)` | `GET /notes/recent` |
| `notes.iterate_recent(...)` | `GET /notes/recent`, every page |
| `notes.proof(id)` | `GET /notes/{id}/proof` (SVG; workspaces with proof images) |
| `redactions.create(note_ids=, idempotency_keys=, external_id=)` | `POST /redactions` (workspaces with retention on) |
| `holdout.report(from_=, to=)` | `GET /holdout` |
| `describe()` | `GET /notes` (machine-readable API summary) |

There is no cancel endpoint: cancel a note before it is written under Activity in the portal.

### asyncio

```python
from notecardhq import AsyncNotecardHQ

async with AsyncNotecardHQ(os.environ["NOTECARDHQ_API_KEY"]) as notecard:
    note = await notecard.notes.get("k57abc123")
    async for n in notecard.notes.iterate_recent():
        ...
```

## Webhooks

Add an HTTPS endpoint under Integrations and notecardHQ POSTs every status change: `note.created`, `note.needs_review`, `note.card_printed`, `note.card_dispatched`, `note.cancelled` (plus `note.rendered`, `note.scheduled`, `note.released` and `note.redacted` where those features are on). Each request carries a `notecardHQ-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` header signed with your webhook secret (`whsec_...`).

Verify it against the raw body:

```python
# Flask
from flask import Flask, request
from notecardhq import SIGNATURE_HEADER, WebhookVerificationError, verify_webhook

app = Flask(__name__)

@app.post("/webhooks/notecardhq")
def notecardhq_webhook():
    try:
        event = verify_webhook(request.get_data(), request.headers.get(SIGNATURE_HEADER), os.environ["NOTECARDHQ_WEBHOOK_SECRET"])
    except WebhookVerificationError:
        return "bad signature", 400
    # event["id"] is unique: skip repeats. event["test"] is True for test-key notes.
    print(event["type"], event["data"]["id"], event["data"]["status"])
    return "ok"
```

`verify_webhook` raises `WebhookVerificationError` for a missing, malformed or wrong signature, or one older than five minutes (`tolerance_seconds`). `verify_webhook_signature` returns a bool instead. Answer 2xx within 10 seconds; failures are retried for about two days, and order is not guaranteed.

## Errors

Every failed request raises a `NotecardHQError` with `status`, `code`, `body` and the API's own `message`:

| Class | Status | `code` |
| --- | --- | --- |
| `InvalidRequestError` | 400, 413, 415, 422 | `invalid_request`, `request_too_large`, `unsupported_media_type`, `validation_failed` |
| `AuthenticationError` | 401 | `authentication_failed` |
| `NotFoundError` | 404 | `not_found` |
| `IdempotencyConflictError` | 409 | `idempotency_conflict` |
| `RateLimitError` | 429 | `rate_limited` |
| `APIError` | 5xx, other | `server_error`, `http_error` |
| `APIConnectionError` | none | `connection_error`, `timeout` |

```python
from notecardhq import InvalidRequestError

try:
    notecard.notes.create(note, idempotency_key=key)
except InvalidRequestError as e:
    print(e.status, e.message)  # e.g. 422 undeliverable address
```

## Options

```python
NotecardHQ(
    "mos_...",
    base_url="https://app.notecardhq.com/api/v1",  # or your workspace's host, as shown in your docs
    max_retries=2,
    timeout=30.0,
    http_client=httpx.Client(...),  # optional: proxies, custom transports
)
```

## Links

- Developers: https://notecardhq.com/developers
- API reference: https://app.notecardhq.com/docs
- OpenAPI: https://app.notecardhq.com/api/v1/openapi.json

MIT licensed.
