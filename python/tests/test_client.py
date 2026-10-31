from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from notecardhq import (
    DEFAULT_BASE_URL,
    APIConnectionError,
    APIError,
    AuthenticationError,
    IdempotencyConflictError,
    InvalidRequestError,
    NotecardHQ,
    NotecardHQError,
    NotFoundError,
    RateLimitError,
)
from notecardhq._client import _Base

from .helpers import KEY, Recorder, json_response

NOTE = {"id": "n_1", "status": "created", "test": True, "externalId": "user_123"}
PARAMS = {
    "recipient": {"firstName": "Brandy", "lastName": "Lee", "address1": "123 Main St", "city": "Austin", "state": "TX", "postalCode": "78701", "country": "US"},
    "content": "Hi Brandy, congrats on your first dollar!",
    "externalId": "user_123",
}


def client(rec: Recorder, **kwargs) -> NotecardHQ:
    kwargs.setdefault("max_retries", 0)
    return NotecardHQ(KEY, http_client=httpx.Client(transport=httpx.MockTransport(rec)), **kwargs)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr("notecardhq._client.time.sleep", lambda s: None)


def test_defaults_and_test_key():
    c = NotecardHQ(KEY)
    assert c.base_url == DEFAULT_BASE_URL == "https://app.notecardhq.com/api/v1"
    assert c.is_test is True
    assert NotecardHQ("mos_" + "b" * 64).is_test is False
    c.close()


def test_requires_api_key():
    with pytest.raises(ValueError, match="api_key is required"):
        NotecardHQ("")


def test_base_url_trailing_slash():
    rec = Recorder([json_response(NOTE)])
    client(rec, base_url="https://whop.notecardhq.com/api/v1/").notes.get("n_1")
    assert str(rec.requests[0].url) == "https://whop.notecardhq.com/api/v1/notes/n_1"


def test_create_sends_key_json_and_idempotency_key():
    rec = Recorder([json_response(NOTE)])
    assert client(rec).notes.create(PARAMS, idempotency_key="first-dollar:user_123") == NOTE
    r = rec.requests[0]
    assert r.method == "POST"
    assert str(r.url) == "https://app.notecardhq.com/api/v1/notes"
    assert r.headers["authorization"] == f"Bearer {KEY}"
    assert r.headers["content-type"] == "application/json"
    assert r.headers["idempotency-key"] == "first-dollar:user_123"
    assert r.headers["user-agent"].startswith("notecardhq-python/")
    assert rec.body() == PARAMS


def test_create_without_idempotency_key():
    rec = Recorder([json_response(NOTE)])
    client(rec).notes.create(PARAMS)
    assert "idempotency-key" not in rec.requests[0].headers


def test_create_202_drafting():
    rec = Recorder([json_response({**NOTE, "status": "drafting"}, 202)])
    note = client(rec).notes.create({"recipient": PARAMS["recipient"], "context": {"source": "x"}}, idempotency_key="k")
    assert note["status"] == "drafting"


def test_create_retries_5xx_with_same_key_and_body():
    rec = Recorder([json_response({"error": "down"}, 503), json_response(NOTE)])
    assert client(rec, max_retries=2).notes.create(PARAMS, idempotency_key="k1") == NOTE
    assert len(rec.requests) == 2
    assert rec.requests[1].headers["idempotency-key"] == "k1"
    assert rec.body(1) == rec.body(0)


def test_create_never_retries_without_key():
    rec = Recorder([json_response({"error": "down"}, 503), json_response(NOTE)])
    with pytest.raises(APIError):
        client(rec, max_retries=2).notes.create(PARAMS)
    assert len(rec.requests) == 1


def test_get_encodes_id():
    rec = Recorder([json_response(NOTE)])
    assert client(rec).notes.get("n/1") == NOTE
    assert rec.requests[0].method == "GET"
    assert rec.requests[0].url.raw_path == b"/api/v1/notes/n%2F1"
    assert rec.requests[0].content == b""


def test_get_requires_id():
    with pytest.raises(ValueError, match="note id is required"):
        client(Recorder([])).notes.get("")


def test_list_recent_params():
    page = {"notes": [{**NOTE, "updatedAt": 1}], "nextCursor": "c2"}
    rec = Recorder([json_response(page), json_response(page), json_response(page)])
    c = client(rec)
    assert c.notes.list_recent(limit=50, updated_since=datetime(2026, 10, 26, 15, tzinfo=timezone.utc), cursor="c1") == page
    assert rec.requests[0].url.path == "/api/v1/notes/recent"
    assert dict(rec.requests[0].url.params) == {"limit": "50", "updatedSince": "2026-10-26T15:00:00+00:00", "cursor": "c1"}
    c.notes.list_recent(updated_since="2026-10-26T15:00:00Z")
    assert dict(rec.requests[1].url.params) == {"updatedSince": "2026-10-26T15:00:00Z"}
    c.notes.list_recent()
    assert rec.requests[2].url.query == b""


def test_list_recent_refuses_naive_datetime():
    with pytest.raises(ValueError, match="timezone-aware"):
        client(Recorder([])).notes.list_recent(updated_since=datetime(2026, 10, 26))


def test_iterate_recent_follows_cursor():
    rec = Recorder([
        json_response({"notes": [{"id": "a"}, {"id": "b"}], "nextCursor": "c1"}),
        json_response({"notes": [{"id": "c"}], "nextCursor": None}),
    ])
    assert [n["id"] for n in client(rec).notes.iterate_recent(limit=2)] == ["a", "b", "c"]
    assert [r.url.params.get("cursor") for r in rec.requests] == [None, "c1"]
    assert all(r.url.params["limit"] == "2" for r in rec.requests)


def test_proof_returns_svg():
    svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    rec = Recorder([httpx.Response(200, text=svg, headers={"content-type": "image/svg+xml"})])
    assert client(rec).notes.proof("n_1") == svg
    assert rec.requests[0].url.path == "/api/v1/notes/n_1/proof"


def test_proof_404_for_test_note():
    rec = Recorder([json_response({"error": "Test notes are never written, so they have no proof."}, 404)])
    with pytest.raises(NotFoundError, match="never written") as e:
        client(rec).notes.proof("n_1")
    assert e.value.status == 404 and e.value.code == "not_found"


def test_redactions_create():
    counts = {"matched": 3, "redacted": 2, "cancelled": 1, "alreadyRedacted": 0, "pendingMailing": 1, "notFound": 0}
    rec = Recorder([json_response(counts)])
    assert client(rec).redactions.create(note_ids=("n_1", "n_2"), idempotency_keys=["k1"], external_id="user_123") == counts
    assert rec.requests[0].method == "POST"
    assert rec.requests[0].url.path == "/api/v1/redactions"
    assert rec.body() == {"noteIds": ["n_1", "n_2"], "idempotencyKeys": ["k1"], "externalId": "user_123"}


def test_redactions_needs_a_selector():
    with pytest.raises(ValueError):
        client(Recorder([])).redactions.create()


def test_redactions_retried():
    rec = Recorder([json_response({"error": "x"}, 503), json_response({"matched": 0})])
    client(rec, max_retries=1).redactions.create(external_id="u")
    assert len(rec.requests) == 2


def test_holdout_report():
    report = {"from": "2026-01-01", "to": "2026-10-31", "totals": {"card": 3, "holdout": 1}, "months": []}
    rec = Recorder([json_response(report), json_response(report)])
    c = client(rec)
    assert c.holdout.report(from_="2026-01-01", to="2026-10-31") == report
    assert rec.requests[0].url.path == "/api/v1/holdout"
    assert dict(rec.requests[0].url.params) == {"from": "2026-01-01", "to": "2026-10-31"}
    c.holdout.report()
    assert rec.requests[1].url.query == b""


def test_describe():
    summary = {"name": "notecardHQ notes API", "version": 1, "docs": "https://app.notecardhq.com/docs", "endpoints": {}}
    rec = Recorder([json_response(summary)])
    assert client(rec).describe() == summary
    assert rec.requests[0].method == "GET" and rec.requests[0].url.path == "/api/v1/notes"


def test_get_retries_network_error_and_429():
    rec = Recorder([httpx.ConnectError("boom"), json_response({"error": "slow"}, 429, {"retry-after": "0"}), json_response(NOTE)])
    assert client(rec, max_retries=2).notes.get("n_1") == NOTE
    assert len(rec.requests) == 3


def test_gives_up_after_max_retries():
    rec = Recorder([json_response({"error": "a"}, 500), json_response({"error": "b"}, 502), json_response({"error": "c"}, 503)])
    with pytest.raises(APIError) as e:
        client(rec, max_retries=2).notes.get("n_1")
    assert e.value.status == 503 and e.value.message == "c"
    assert len(rec.requests) == 3


@pytest.mark.parametrize(
    "status,error_type,code",
    [
        (400, InvalidRequestError, "invalid_request"),
        (401, AuthenticationError, "authentication_failed"),
        (404, NotFoundError, "not_found"),
        (409, IdempotencyConflictError, "idempotency_conflict"),
        (413, InvalidRequestError, "request_too_large"),
        (415, InvalidRequestError, "unsupported_media_type"),
        (422, InvalidRequestError, "validation_failed"),
        (429, RateLimitError, "rate_limited"),
        (500, APIError, "server_error"),
        (503, APIError, "server_error"),
        (418, APIError, "http_error"),
    ],
)
def test_error_types(status, error_type, code):
    body = {"error": f"problem {status}"}
    rec = Recorder([json_response(body, status)])
    with pytest.raises(error_type) as e:
        client(rec).notes.create(PARAMS, idempotency_key="k")
    assert isinstance(e.value, NotecardHQError)
    assert (e.value.status, e.value.code, e.value.body, e.value.message, str(e.value)) == (status, code, body, f"problem {status}", f"problem {status}")


def test_keeps_server_code():
    rec = Recorder([json_response({"error": "nope", "code": "custom_code"}, 422)])
    with pytest.raises(InvalidRequestError) as e:
        client(rec).notes.get("n")
    assert e.value.code == "custom_code"


def test_non_json_and_empty_error_bodies():
    rec = Recorder([httpx.Response(502, text="Bad Gateway"), httpx.Response(500)])
    c = client(rec)
    with pytest.raises(APIError) as e:
        c.notes.get("n")
    assert (e.value.status, e.value.body, e.value.message) == (502, "Bad Gateway", "Bad Gateway")
    with pytest.raises(APIError) as e:
        c.notes.get("n")
    assert (e.value.status, e.value.body, e.value.message) == (500, None, "HTTP 500")


def test_network_error():
    cause = httpx.ConnectError("boom")
    with pytest.raises(APIConnectionError) as e:
        client(Recorder([cause])).notes.get("n")
    assert e.value.status is None and e.value.code == "connection_error" and e.value.__cause__ is cause


def test_timeout():
    with pytest.raises(APIConnectionError) as e:
        client(Recorder([httpx.ReadTimeout("slow")])).notes.get("n")
    assert e.value.code == "timeout"


def test_backoff_honours_retry_after():
    assert _Base._backoff(0, "3") == 3.0
    assert _Base._backoff(0, "999") == 60.0
    assert 0.375 <= _Base._backoff(0, "soon") <= 0.625


def test_context_manager_closes_own_client():
    with NotecardHQ(KEY) as c:
        http = c._http
    assert http.is_closed
