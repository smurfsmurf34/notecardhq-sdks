from __future__ import annotations

import json
from pathlib import Path

import pytest

import notecardhq
from notecardhq import (
    SIGNATURE_HEADER,
    NotecardHQ,
    WebhookVerificationError,
    sign_webhook_payload,
    verify_webhook,
    verify_webhook_signature,
)

# Headers made by the server's own signing code (lib/webhooks.ts); the Node
# test suite checks this file still matches it.
VECTORS = json.loads((Path(__file__).parent / "fixtures" / "webhook_vectors.json").read_text("utf-8"))["vectors"]

SECRET = "whsec_" + "ab" * 24
NOW = 1792900000
BODY = json.dumps(
    {"id": "evt_1", "type": "note.card_dispatched", "created": NOW, "test": False, "data": {"id": "n_1", "status": "card_dispatched", "content": "Merci, Zoë!"}},
    ensure_ascii=False,
)


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("notecardhq._webhooks.time.time", lambda: NOW + 0.5)


def at(t):
    return lambda: t


def test_header_name():
    assert SIGNATURE_HEADER == "notecardHQ-Signature"


@pytest.mark.parametrize("v", VECTORS, ids=lambda v: str(v["t"]))
def test_server_vectors_verify(v, monkeypatch):
    monkeypatch.setattr("notecardhq._webhooks.time.time", at(v["t"] + 10))
    assert sign_webhook_payload(v["body"], v["secret"], v["t"]) == v["header"]
    event = verify_webhook(v["body"].encode("utf-8"), v["header"], v["secret"])
    assert event == json.loads(v["body"])
    assert verify_webhook(v["body"], v["header"], v["secret"])["id"] == event["id"]


def test_server_vectors_reject_other_secret(monkeypatch):
    v = VECTORS[0]
    monkeypatch.setattr("notecardhq._webhooks.time.time", at(v["t"]))
    assert verify_webhook_signature(v["body"], v["header"], VECTORS[1]["secret"]) is False


def test_good_signature_bytes_str_bytearray():
    header = sign_webhook_payload(BODY, SECRET, NOW)
    assert verify_webhook(BODY, header, SECRET)["type"] == "note.card_dispatched"
    assert verify_webhook(BODY.encode("utf-8"), header, SECRET)["data"]["id"] == "n_1"
    assert verify_webhook_signature(bytearray(BODY.encode("utf-8")), header, SECRET) is True


def test_within_tolerance():
    assert verify_webhook_signature(BODY, sign_webhook_payload(BODY, SECRET, NOW - 299), SECRET)


def rejects(payload, header, secret=SECRET, **kw):
    with pytest.raises(WebhookVerificationError):
        verify_webhook(payload, header, secret, **kw)
    assert verify_webhook_signature(payload, header, secret, **kw) is False


def test_rejects_wrong_secret():
    rejects(BODY, sign_webhook_payload(BODY, SECRET, NOW), "whsec_other")


def test_rejects_tampered_body():
    rejects(BODY.replace("n_1", "n_2"), sign_webhook_payload(BODY, SECRET, NOW))


def test_rejects_tampered_signature():
    header = sign_webhook_payload(BODY, SECRET, NOW)
    rejects(BODY, header[:-1] + ("1" if header.endswith("0") else "0"))


def test_rejects_expired():
    rejects(BODY, sign_webhook_payload(BODY, SECRET, NOW - 301))


def test_rejects_future():
    rejects(BODY, sign_webhook_payload(BODY, SECRET, NOW + 302))


def test_rejects_outside_custom_tolerance():
    rejects(BODY, sign_webhook_payload(BODY, SECRET, NOW - 61), tolerance_seconds=60)


@pytest.mark.parametrize("header", [None, "", "garbage", f"t={NOW}", "v1=abcd", "t=abc,v1=" + "0" * 64, "t=١٢٣,v1=" + "0" * 64])
def test_rejects_missing_or_malformed_header(header):
    rejects(BODY, header)


def test_rejects_empty_secret():
    rejects(BODY, sign_webhook_payload(BODY, SECRET, NOW), "")


def test_non_json_body():
    header = sign_webhook_payload("not json", SECRET, NOW)
    with pytest.raises(WebhookVerificationError, match="not JSON"):
        verify_webhook("not json", header, SECRET)
    assert verify_webhook_signature("not json", header, SECRET) is True


def test_any_of_several_v1():
    good = sign_webhook_payload(BODY, SECRET, NOW).split("v1=")[1]
    assert verify_webhook_signature(BODY, f"t={NOW},v1={'0' * 64},v1={good}", SECRET)


def test_client_webhooks():
    header = sign_webhook_payload(BODY, SECRET, NOW)
    c = NotecardHQ("mos_test_x")
    assert c.webhooks.verify(BODY, header, SECRET)["id"] == "evt_1"
    assert c.webhooks.verify_signature(BODY, "t=1,v1=00", SECRET) is False
    c.close()


def test_public_api():
    for name in notecardhq.__all__:
        assert hasattr(notecardhq, name), name
