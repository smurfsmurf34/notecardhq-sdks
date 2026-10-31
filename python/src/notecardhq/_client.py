from __future__ import annotations

import asyncio
import json
import random
import time
from datetime import datetime
from typing import Any, AsyncIterator, Dict, Iterator, Optional, Sequence, Union, cast
from urllib.parse import quote

import httpx

from ._errors import APIConnectionError, NotecardHQError, error_from_response
from ._types import HoldoutReport, Note, NoteParams, RecentNote, RecentNotesPage, RedactionResult, WebhookEvent
from ._version import __version__
from ._webhooks import DEFAULT_TOLERANCE_SECONDS, Payload, verify_webhook, verify_webhook_signature

DEFAULT_BASE_URL = "https://app.notecardhq.com/api/v1"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 2

_Query = Dict[str, Optional[str]]


class _Call:
    __slots__ = ("method", "path", "query", "body", "headers", "retryable", "text")

    def __init__(
        self,
        method: str,
        path: str,
        *,
        query: Optional[_Query] = None,
        body: Any = None,
        headers: Optional[Dict[str, str]] = None,
        retryable: bool,
        text: bool = False,
    ) -> None:
        self.method = method
        self.path = path
        self.query = {k: v for k, v in (query or {}).items() if v is not None}
        self.body = body
        self.headers = headers or {}
        self.retryable = retryable
        self.text = text


def _note_path(note_id: str, suffix: str = "") -> str:
    if not note_id:
        raise ValueError("A note id is required.")
    return f"/notes/{quote(note_id, safe='')}{suffix}"


def _iso(value: Union[datetime, str, None]) -> Optional[str]:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("updated_since must be timezone-aware (the API needs a time zone).")
        return value.isoformat()
    return value


def _create_call(note: NoteParams, idempotency_key: Optional[str]) -> _Call:
    headers = {} if idempotency_key is None else {"Idempotency-Key": idempotency_key}
    # Retried only with a key: a retry without one could mail a second card.
    return _Call("POST", "/notes", body=note, headers=headers, retryable=idempotency_key is not None)


def _recent_call(limit: Optional[int], updated_since: Union[datetime, str, None], cursor: Optional[str]) -> _Call:
    return _Call(
        "GET",
        "/notes/recent",
        query={"limit": None if limit is None else str(limit), "updatedSince": _iso(updated_since), "cursor": cursor},
        retryable=True,
    )


class _Base:
    def __init__(
        self,
        api_key: str,
        base_url: Optional[str],
        timeout: float,
        max_retries: int,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required (mos_... or mos_test_...).")
        self.api_key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_retries = max(0, max_retries)

    @property
    def is_test(self) -> bool:
        """True for a test key (mos_test_...): notes are validated and stored but never written, mailed or billed."""
        return self.api_key.startswith("mos_test_")

    def _headers(self, call: _Call) -> Dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "*/*" if call.text else "application/json",
            "User-Agent": f"notecardhq-python/{__version__}",
        }
        if call.body is not None:
            headers["Content-Type"] = "application/json"
        headers.update(call.headers)
        return headers

    def _content(self, call: _Call) -> Optional[bytes]:
        return None if call.body is None else json.dumps(call.body, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def _result(call: _Call, response: httpx.Response) -> Any:
        return response.text if call.text else response.json()

    @staticmethod
    def _error(response: httpx.Response) -> NotecardHQError:
        text = response.text
        body: Any
        try:
            body = json.loads(text) if text else None
        except ValueError:
            body = text
        return error_from_response(response.status_code, body, response.headers)

    @staticmethod
    def _connection_error(exc: httpx.HTTPError, timeout: float) -> APIConnectionError:
        if isinstance(exc, httpx.TimeoutException):
            err = APIConnectionError(f"No response within {timeout} s.", code="timeout")
        else:
            err = APIConnectionError("Could not reach notecardHQ.", code="connection_error")
        err.__cause__ = exc
        return err

    @staticmethod
    def _retry_status(status: int) -> bool:
        return status == 429 or status >= 500

    @staticmethod
    def _backoff(attempt: int, retry_after: Optional[str] = None) -> float:
        if retry_after is not None:
            try:
                seconds = float(retry_after)
                if seconds >= 0:
                    return min(seconds, 60.0)
            except ValueError:
                pass
        return min(8.0, 0.5 * 2.0**attempt) * (0.75 + random.random() * 0.5)


class NotecardHQ(_Base):
    """The notecardHQ API client.

    >>> notecard = NotecardHQ(api_key=os.environ["NOTECARDHQ_API_KEY"])
    >>> note = notecard.notes.create({"recipient": {...}, "content": "Thank you!"}, idempotency_key="welcome:42")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        super().__init__(api_key, base_url, timeout, max_retries)
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)
        self.notes = Notes(self)
        self.redactions = Redactions(self)
        self.holdout = Holdout(self)
        self.webhooks = Webhooks()

    def describe(self) -> Dict[str, Any]:
        """GET /notes: a machine-readable summary of the API for this host."""
        return cast(Dict[str, Any], self._request(_Call("GET", "/notes", retryable=True)))

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "NotecardHQ":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _request(self, call: _Call) -> Any:
        attempt = 0
        while True:
            last = not call.retryable or attempt >= self.max_retries
            try:
                response = self._http.request(
                    call.method,
                    self.base_url + call.path,
                    params=call.query,
                    content=self._content(call),
                    headers=self._headers(call),
                    timeout=self.timeout,
                )
            except httpx.HTTPError as exc:
                if last:
                    raise self._connection_error(exc, self.timeout) from exc
                time.sleep(self._backoff(attempt))
                attempt += 1
                continue
            if response.is_success:
                return self._result(call, response)
            if last or not self._retry_status(response.status_code):
                raise self._error(response)
            time.sleep(self._backoff(attempt, response.headers.get("retry-after")))
            attempt += 1


class AsyncNotecardHQ(_Base):
    """The asyncio client: the same methods as NotecardHQ, awaited."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        super().__init__(api_key, base_url, timeout, max_retries)
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=timeout)
        self.notes = AsyncNotes(self)
        self.redactions = AsyncRedactions(self)
        self.holdout = AsyncHoldout(self)
        self.webhooks = Webhooks()

    async def describe(self) -> Dict[str, Any]:
        """GET /notes: a machine-readable summary of the API for this host."""
        return cast(Dict[str, Any], await self._request(_Call("GET", "/notes", retryable=True)))

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncNotecardHQ":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def _request(self, call: _Call) -> Any:
        attempt = 0
        while True:
            last = not call.retryable or attempt >= self.max_retries
            try:
                response = await self._http.request(
                    call.method,
                    self.base_url + call.path,
                    params=call.query,
                    content=self._content(call),
                    headers=self._headers(call),
                    timeout=self.timeout,
                )
            except httpx.HTTPError as exc:
                if last:
                    raise self._connection_error(exc, self.timeout) from exc
                await asyncio.sleep(self._backoff(attempt))
                attempt += 1
                continue
            if response.is_success:
                return self._result(call, response)
            if last or not self._retry_status(response.status_code):
                raise self._error(response)
            await asyncio.sleep(self._backoff(attempt, response.headers.get("retry-after")))
            attempt += 1


class Notes:
    def __init__(self, client: NotecardHQ) -> None:
        self._client = client

    def create(self, note: NoteParams, *, idempotency_key: Optional[str] = None) -> Note:
        """POST /notes: create a note. With a live key this mails a real card; a
        test key (mos_test_...) never writes, mails or bills one.

        ``idempotency_key``: one stable key per event, e.g. ``f"welcome:{user_id}"``.
        Required by standard workspaces; retries happen only when it is set.
        """
        return cast(Note, self._client._request(_create_call(note, idempotency_key)))

    def get(self, note_id: str) -> Note:
        """GET /notes/{id}: a note and its current status."""
        return cast(Note, self._client._request(_Call("GET", _note_path(note_id), retryable=True)))

    def list_recent(
        self,
        *,
        limit: Optional[int] = None,
        updated_since: Union[datetime, str, None] = None,
        cursor: Optional[str] = None,
    ) -> RecentNotesPage:
        """GET /notes/recent: one page of notes, newest status change first."""
        return cast(RecentNotesPage, self._client._request(_recent_call(limit, updated_since, cursor)))

    def iterate_recent(
        self,
        *,
        limit: Optional[int] = None,
        updated_since: Union[datetime, str, None] = None,
        cursor: Optional[str] = None,
    ) -> Iterator[RecentNote]:
        """Every note from GET /notes/recent, following nextCursor page by page."""
        while True:
            page = self.list_recent(limit=limit, updated_since=updated_since, cursor=cursor)
            yield from page["notes"]
            cursor = page["nextCursor"]
            if not cursor:
                return

    def proof(self, note_id: str) -> str:
        """GET /notes/{id}/proof: the card's proof as SVG text (workspaces with proof images)."""
        return cast(str, self._client._request(_Call("GET", _note_path(note_id, "/proof"), retryable=True, text=True)))


class AsyncNotes:
    def __init__(self, client: AsyncNotecardHQ) -> None:
        self._client = client

    async def create(self, note: NoteParams, *, idempotency_key: Optional[str] = None) -> Note:
        """See Notes.create."""
        return cast(Note, await self._client._request(_create_call(note, idempotency_key)))

    async def get(self, note_id: str) -> Note:
        """See Notes.get."""
        return cast(Note, await self._client._request(_Call("GET", _note_path(note_id), retryable=True)))

    async def list_recent(
        self,
        *,
        limit: Optional[int] = None,
        updated_since: Union[datetime, str, None] = None,
        cursor: Optional[str] = None,
    ) -> RecentNotesPage:
        """See Notes.list_recent."""
        return cast(RecentNotesPage, await self._client._request(_recent_call(limit, updated_since, cursor)))

    async def iterate_recent(
        self,
        *,
        limit: Optional[int] = None,
        updated_since: Union[datetime, str, None] = None,
        cursor: Optional[str] = None,
    ) -> AsyncIterator[RecentNote]:
        """See Notes.iterate_recent."""
        while True:
            page = await self.list_recent(limit=limit, updated_since=updated_since, cursor=cursor)
            for note in page["notes"]:
                yield note
            cursor = page["nextCursor"]
            if not cursor:
                return

    async def proof(self, note_id: str) -> str:
        """See Notes.proof."""
        return cast(str, await self._client._request(_Call("GET", _note_path(note_id, "/proof"), retryable=True, text=True)))


def _redaction_call(note_ids: Optional[Sequence[str]], idempotency_keys: Optional[Sequence[str]], external_id: Optional[str]) -> _Call:
    body: Dict[str, Any] = {}
    if note_ids is not None:
        body["noteIds"] = list(note_ids)
    if idempotency_keys is not None:
        body["idempotencyKeys"] = list(idempotency_keys)
    if external_id is not None:
        body["externalId"] = external_id
    if not body:
        raise ValueError("Give note_ids, idempotency_keys or external_id.")
    # The server documents redaction as safe to repeat.
    return _Call("POST", "/redactions", body=body, retryable=True)


class Redactions:
    def __init__(self, client: NotecardHQ) -> None:
        self._client = client

    def create(
        self,
        *,
        note_ids: Optional[Sequence[str]] = None,
        idempotency_keys: Optional[Sequence[str]] = None,
        external_id: Optional[str] = None,
    ) -> RedactionResult:
        """POST /redactions (workspaces with retention on): delete recipients'
        personal data. Notes not yet written are cancelled and never mailed. Safe to repeat."""
        return cast(RedactionResult, self._client._request(_redaction_call(note_ids, idempotency_keys, external_id)))


class AsyncRedactions:
    def __init__(self, client: AsyncNotecardHQ) -> None:
        self._client = client

    async def create(
        self,
        *,
        note_ids: Optional[Sequence[str]] = None,
        idempotency_keys: Optional[Sequence[str]] = None,
        external_id: Optional[str] = None,
    ) -> RedactionResult:
        """See Redactions.create."""
        return cast(RedactionResult, await self._client._request(_redaction_call(note_ids, idempotency_keys, external_id)))


def _holdout_call(from_: Optional[str], to: Optional[str]) -> _Call:
    return _Call("GET", "/holdout", query={"from": from_, "to": to}, retryable=True)


class Holdout:
    def __init__(self, client: NotecardHQ) -> None:
        self._client = client

    def report(self, *, from_: Optional[str] = None, to: Optional[str] = None) -> HoldoutReport:
        """GET /holdout: cards vs holdout per month ("YYYY-MM-DD" bounds), with externalIds."""
        return cast(HoldoutReport, self._client._request(_holdout_call(from_, to)))


class AsyncHoldout:
    def __init__(self, client: AsyncNotecardHQ) -> None:
        self._client = client

    async def report(self, *, from_: Optional[str] = None, to: Optional[str] = None) -> HoldoutReport:
        """See Holdout.report."""
        return cast(HoldoutReport, await self._client._request(_holdout_call(from_, to)))


class Webhooks:
    """``client.webhooks.verify(...)``: the module-level verifiers, for discoverability."""

    def verify(
        self, payload: Payload, header: Optional[str], secret: str, *, tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS
    ) -> WebhookEvent:
        return verify_webhook(payload, header, secret, tolerance_seconds=tolerance_seconds)

    def verify_signature(
        self, payload: Payload, header: Optional[str], secret: str, *, tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS
    ) -> bool:
        return verify_webhook_signature(payload, header, secret, tolerance_seconds=tolerance_seconds)


__all__ = ["NotecardHQ", "AsyncNotecardHQ", "DEFAULT_BASE_URL"]
