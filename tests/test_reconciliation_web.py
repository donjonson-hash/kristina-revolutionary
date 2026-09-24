"""Real HTTP boundary and deterministic professional reconciliation tests."""
import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import reconciliation_web as web
import reconcile_lists

ROOT = Path(__file__).resolve().parents[1]
HEADERS = {"X-Kristina-Reconcile": "1"}


def source(raw, name="list.csv"):
    return {"name": name, "data": base64.b64encode(raw).decode("ascii")}


def example():
    return {
        "left": source((ROOT / "examples/reconciliation/order.csv").read_bytes(), "order.csv"),
        "right": source((ROOT / "examples/reconciliation/confirmation.csv").read_bytes(), "confirmation.csv"),
        "delimiter": ",", "key": ["sku", "sku"],
        "fields": [["quantity", "quantity", "number"], ["unit", "unit", "text"]], "strip": False,
    }


@pytest.fixture
def client():
    with TestClient(web.app, base_url="http://127.0.0.1:8765", headers=HEADERS) as client:
        yield client


def test_inspect_preserves_leading_zeroes_and_logical_records(client):
    raw = b'sku,description\n001,"two\nlines"\n002,plain\n'
    result = client.post("/api/inspect", json={"left": source(raw), "right": source(raw)})
    assert result.status_code == 200
    left = result.json()["left"]
    assert left["headers"] == ["sku", "description"]
    assert left["row_count"] == 2
    assert left["preview"] == [
        {"record": 2, "values": {"sku": "001", "description": "two\nlines"}},
        {"record": 3, "values": {"sku": "002", "description": "plain"}},
    ]
    assert result.headers["cache-control"] == "no-store"


def test_compare_uses_profession_and_never_model(client, monkeypatch):
    created = []
    original = web.AvatarFactory.create_avatar

    def create(factory, **kwargs):
        assert isinstance(factory.llm_adapter, web.NoModelAdapter)
        created.append(kwargs["role_id"])
        return original(factory, **kwargs)

    async def forbidden(*args, **kwargs):
        pytest.fail("A deterministic browser comparison must not call a model")

    monkeypatch.setattr(web.AvatarFactory, "create_avatar", create)
    monkeypatch.setattr(web.NoModelAdapter, "generate", forbidden)
    response = client.post("/api/compare", json=example())
    assert response.status_code == 200
    result = response.json()
    assert created == ["reconciliation_specialist"]
    assert result["report"]["summary"] == {
        "left_rows": 4, "right_rows": 4, "matched": 1,
        "changed": 2, "only_left": 1, "only_right": 1,
    }
    assert {item["key"] for item in result["report"]["changed"]} == {"DS-200", "LP-300"}
    assert "Исходная запись" in result["html"]


def test_duplicate_keys_return_clarification_with_no_partial_result(client):
    payload = example()
    payload["left"] = source(b"sku,quantity,unit\nx,1,piece\nx,2,piece\n")
    response = client.post("/api/compare", json=payload)
    assert response.status_code == 200
    report = response.json()["report"]
    assert report["status"] == "needs_clarification"
    assert report["summary"] is None and report["changed"] == []
    assert report["issues"][0]["code"] == "duplicate_key"


def test_missing_rules_and_membership_only_are_distinct(client):
    payload = example()
    payload["key"] = None
    payload["fields"] = None
    report = client.post("/api/compare", json=payload).json()["report"]
    assert report["status"] == "needs_clarification"
    payload.update(key=["sku", "sku"], fields=[])
    report = client.post("/api/compare", json=payload).json()["report"]
    assert report["status"] == "complete"
    assert report["summary"]["matched"] == 3 and report["summary"]["changed"] == 0


@pytest.mark.parametrize("updates", [
    {"left": {"name": "x", "data": "@@@="}},
    {"left": {"name": "x", "data": "YQ==\n"}},
    {"left": {"name": "", "data": "YQ=="}},
    {"left": {"name": "\ud800", "data": "YQ=="}},
    {"left": source(b"sku\nx,y\n")},
    {"left": source(b"sku\n\xff\n")},
    {"delimiter": "||"}, {"strip": "false"}, {"key": ["sku"]},
    {"fields": [["quantity", "quantity", "guess"]]},
], ids=["bad-base64", "whitespace-base64", "blank-name", "invalid-unicode-name", "ragged-csv", "non-utf8",
        "delimiter", "strip-type", "invalid-key", "unknown-mode"])
def test_invalid_input_returns_json_error(client, updates):
    payload = {**example(), **updates}
    response = client.post("/api/compare", content=json.dumps(payload),
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    assert isinstance(response.json()["error"], str)
    assert "report" not in response.json()


@pytest.mark.parametrize("raw", [b'{"left":', b'[]', b'{"value":NaN}'])
def test_invalid_json(client, raw):
    response = client.post("/api/inspect", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code == 400 and response.json()["error"]


def test_decoded_source_size_is_bounded(client):
    payload = example()
    payload["left"] = source(b"x" * (web.MAX_SOURCE_BYTES + 1))
    response = client.post("/api/inspect", json=payload)
    assert response.status_code == 400
    assert "2 MiB" in response.json()["error"]


def test_request_stream_is_bounded_without_content_length(client, monkeypatch):
    monkeypatch.setattr(web, "MAX_REQUEST_BYTES", 64)
    response = client.post("/api/inspect", content=iter([b" " * 40, b" " * 40]),
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 413 and response.json()["error"]


def test_declared_large_body_rejected_before_json(client):
    response = client.post("/api/inspect", content=b"{}",
                           headers={"Content-Type": "application/json", "Content-Length": str(web.MAX_REQUEST_BYTES + 1)})
    assert response.status_code == 413


@pytest.mark.parametrize("headers,status", [
    ({"Host": "attacker.example"}, 403),
    ({"Host": "127.0.0.1.evil.example"}, 403),
    ({"Origin": "https://attacker.example"}, 403),
    ({"Origin": "null"}, 403),
    ({"Origin": "http://127.0.0.1:9999"}, 403),
    ({"Sec-Fetch-Site": "cross-site"}, 403),
    ({"Sec-Fetch-Site": "same-site"}, 403),
    ({"X-Kristina-Reconcile": ""}, 403),
    ({"Content-Type": "text/plain"}, 415),
], ids=["host", "host-suffix", "origin", "null-origin", "other-port", "cross-site", "same-site", "marker", "content-type"])
def test_request_boundaries(client, headers, status):
    response = client.post("/api/inspect", json=example(), headers=headers)
    assert response.status_code == status and response.json()["error"]
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["cache-control"] == "no-store"


def test_same_origin_browser_request_allowed(client):
    response = client.post("/api/inspect", json=example(), headers={
        "Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"})
    assert response.status_code == 200


@pytest.mark.parametrize("renderer", ["json", "html"])
def test_output_size_guard_returns_no_partial_report(client, monkeypatch, renderer):
    if renderer == "json":
        monkeypatch.setattr(reconcile_lists, "MAX_REPORT_BYTES", 64)
    else:
        def overflow(_report):
            raise ValueError("HTML report exceeds 16 MiB; split the input lists")
        monkeypatch.setattr(web, "render_html", overflow)
    response = client.post("/api/compare", json=example())
    assert response.status_code == 400
    assert "report" not in response.json()
    assert "exceeds" in response.json()["error"]


def test_static_files_are_allowlisted_and_secure(client, tmp_path, monkeypatch):
    monkeypatch.setattr(web, "STATIC_ROOT", tmp_path)
    for name, content in [("index.html", "<!doctype html><title>Local</title>"),
                          ("app.js", "'use strict';"), ("style.css", "body{color:black}")]:
        (tmp_path / name).write_text(content)
    for path in ("/", "/assets/app.js", "/assets/style.css"):
        response = client.get(path)
        assert response.status_code == 200
        assert "script-src 'self'" in response.headers["content-security-policy"]
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["cache-control"] == "no-store"
    for path in ("/reconciliation_web.py", "/.env", "/docs", "/openapi.json"):
        response = client.get(path)
        assert response.status_code == 404 and response.json()["error"]
