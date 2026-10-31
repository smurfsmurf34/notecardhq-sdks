from __future__ import annotations

import asyncio

import httpx
import pytest

from notecardhq import APIConnectionError, AsyncNotecardHQ, IdempotencyConflictError

from .helpers import KEY, Recorder, json_response

NOTE = {"id": "n_1", "status": "created"}


def client(rec: Recorder, **kwargs) -> AsyncNotecardHQ:
    kwargs.setdefault("max_retries", 0)
    return AsyncNotecardHQ(KEY, http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec)), **kwargs)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    async def instant(_):
        return None

    monkeypatch.setattr("notecardhq._client.asyncio.sleep", instant)


def run(coro):
    return asyncio.run(coro)


def test_async_every_method():
    page = {"notes": [{"id": "a"}], "nextCursor": None}
    rec = Recorder([
        json_response(NOTE),
        json_response(NOTE),
        json_response(page),
        json_response(page),
        httpx.Response(200, text="<svg/>"),
        json_response({"matched": 1}),
        json_response({"from": "2026-01-01", "to": "2026-02-01", "totals": {}, "months": []}),
        json_response({"name": "notecardHQ notes API"}),
    ])

    async def go():
        c = client(rec)
        assert await c.notes.create({"recipient": {"firstName": "A", "address1": "1 St", "city": "X"}, "content": "Hi"}, idempotency_key="k") == NOTE
        assert await c.notes.get("n_1") == NOTE
        assert (await c.notes.list_recent(limit=5))["notes"] == [{"id": "a"}]
        assert [n["id"] async for n in c.notes.iterate_recent()] == ["a"]
        assert await c.notes.proof("n_1") == "<svg/>"
        assert (await c.redactions.create(note_ids=["n_1"]))["matched"] == 1
        assert (await c.holdout.report(from_="2026-01-01"))["from"] == "2026-01-01"
        assert (await c.describe())["name"] == "notecardHQ notes API"

    run(go())
    assert [(r.method, r.url.path) for r in rec.requests] == [
        ("POST", "/api/v1/notes"),
        ("GET", "/api/v1/notes/n_1"),
        ("GET", "/api/v1/notes/recent"),
        ("GET", "/api/v1/notes/recent"),
        ("GET", "/api/v1/notes/n_1/proof"),
        ("POST", "/api/v1/redactions"),
        ("GET", "/api/v1/holdout"),
        ("GET", "/api/v1/notes"),
    ]
    assert rec.requests[0].headers["idempotency-key"] == "k"
    assert rec.requests[2].url.params["limit"] == "5"


def test_async_errors_and_retries():
    rec = Recorder([
        json_response({"error": "Idempotency-Key already used"}, 409),
        httpx.ConnectError("boom"),
        json_response(NOTE),
        httpx.ConnectError("boom"),
    ])

    async def go():
        c = client(rec, max_retries=1)
        with pytest.raises(IdempotencyConflictError) as e:
            await c.notes.create({"recipient": {"firstName": "A", "address1": "1 St", "city": "X"}}, idempotency_key="k")
        assert e.value.status == 409
        assert await c.notes.get("n_1") == NOTE
        with pytest.raises(APIConnectionError):
            await c.notes.create({"recipient": {"firstName": "A", "address1": "1 St", "city": "X"}})

    run(go())
    assert len(rec.requests) == 4


def test_async_context_manager():
    async def go():
        async with AsyncNotecardHQ(KEY) as c:
            http = c._http
            assert c.is_test
        return http

    assert run(go()).is_closed
