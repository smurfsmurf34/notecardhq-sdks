from __future__ import annotations

import json
from typing import Any, Dict, List, Union

import httpx

KEY = "mos_test_" + "a" * 64

Reply = Union[httpx.Response, Exception]


def json_response(body: Any, status: int = 200, headers: Dict[str, str] = {}) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


class Recorder:
    """An httpx transport answering from a queue and recording each request."""

    def __init__(self, replies: List[Reply]) -> None:
        self.replies = list(replies)
        self.requests: List[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.replies:
            raise AssertionError("no reply queued")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def body(self, i: int = 0) -> Any:
        content = self.requests[i].content
        return json.loads(content) if content else None


