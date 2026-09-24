"""Local-only browser interface for the deterministic reconciliation profession.

Run directly; never mount this unauthenticated pilot in the production chatbot.
Uploaded sources exist only in request memory, and no LLM adapter can be invoked.
"""
from __future__ import annotations

import argparse
import base64
import binascii
from functools import partial
import json
from pathlib import Path
from urllib.parse import urlsplit

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException

from avatar_platform.avatar_factory import AvatarFactory
# The pilot deliberately shares the engine's parser; no second CSV interpretation.
from avatar_platform.reconciliation import MAX_SOURCE_BYTES, _source
from reconcile_lists import NoModelAdapter, render_html, render_json

MAX_REQUEST_BYTES = 6 * 1024 * 1024
PREVIEW_RECORDS = 5
STATIC_ROOT = Path(__file__).resolve().parent / "static" / "reconciliation"
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; "
        "connect-src 'self'; img-src 'self' data:; frame-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
}


def _local_host(host: str) -> bool:
    try:
        parsed = urlsplit("http://" + host)
        return (parsed.hostname in {"127.0.0.1", "localhost", "::1"}
                and not parsed.username and not parsed.password
                and not parsed.path and not parsed.query and not parsed.fragment
                and (parsed.port is None or 1 <= parsed.port <= 65535))
    except ValueError:
        return False


class LocalRequestGuard:
    """Validate browser boundaries and bound bytes before JSON decoding."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def secured_send(message):
            if message["type"] == "http.response.start":
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [
                    (key.lower().encode(), value.encode()) for key, value in SECURITY_HEADERS.items()
                ]
            await send(message)

        async def reject(status, error):
            await JSONResponse({"error": error}, status_code=status)(scope, receive, secured_send)

        headers = {}
        for key, value in scope["headers"]:
            key = key.lower()
            if key in headers and key in {b"host", b"origin", b"content-length", b"sec-fetch-site"}:
                return await reject(400, "Duplicate request boundary header")
            headers[key] = value.decode("latin-1")
        host = headers.get(b"host", "")
        if not _local_host(host):
            return await reject(403, "Only localhost requests are allowed")
        if b"origin" in headers and headers[b"origin"] != "http://" + host:
            return await reject(403, "Cross-origin requests are not allowed")
        if headers.get(b"sec-fetch-site", "none") not in {"none", "same-origin"}:
            return await reject(403, "Cross-site requests are not allowed")
        if scope["method"] == "POST":
            if headers.get(b"x-kristina-reconcile") != "1":
                return await reject(403, "Expected X-Kristina-Reconcile: 1")
            if headers.get(b"content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                return await reject(415, "Expected application/json")
            length = headers.get(b"content-length")
            if length is not None:
                if not length.isascii() or not length.isdecimal():
                    return await reject(400, "Invalid Content-Length")
                if len(length) > 12 or int(length) > MAX_REQUEST_BYTES:
                    return await reject(413, "Request exceeds 6 MiB")
            # Read only a bounded stream: Content-Length is not trusted.
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                    return await reject(413, "Request exceeds 6 MiB")
                body.extend(chunk)
                if not message.get("more_body", False):
                    break
            scope = {**scope, "reconciliation_body": bytes(body)}
        await self.app(scope, receive, secured_send)


app = FastAPI(title="Кристина — сверка списков", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(LocalRequestGuard)
# Parsing, comparison, rendering, and response serialization all run off the event loop.
_WORKERS = anyio.CapacityLimiter(2)


@app.exception_handler(HTTPException)
async def http_error(_request, exc):
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


def _invalid_constant(value):
    raise ValueError(f"Non-JSON number: {value}")


def _inputs(body: bytes):
    try:
        payload = json.loads(body, parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("Expected a valid JSON object") from exc
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    delimiter = payload.get("delimiter", ",")
    if not isinstance(delimiter, str) or delimiter not in (",", ";", "\t"):
        raise ValueError("delimiter must be comma, semicolon, or tab")
    sources = {}
    for side in ("left", "right"):
        item = payload.get(side)
        if not isinstance(item, dict):
            raise ValueError(f"{side}: expected name and base64 data")
        name, encoded = item.get("name"), item.get("data")
        if not isinstance(name, str) or not name.strip() or len(name) > 255 or "\x00" in name:
            raise ValueError(f"{side}: name must be a nonblank string of at most 255 characters")
        try:
            name.encode("utf-8")
        except UnicodeError as exc:
            raise ValueError(f"{side}: name must contain valid Unicode characters") from exc
        if not isinstance(encoded, str):
            raise ValueError(f"{side}: data must be base64 text")
        if len(encoded) > 4 * ((MAX_SOURCE_BYTES + 2) // 3):
            raise ValueError(f"{side}: source exceeds 2 MiB")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError(f"{side}: invalid base64 data") from exc
        if len(raw) > MAX_SOURCE_BYTES:
            raise ValueError(f"{side}: source exceeds 2 MiB")
        sources[side] = (raw, name)
    return payload, delimiter, sources


def _process(body: bytes, operation: str):
    try:
        payload, delimiter, sources = _inputs(body)
        if operation == "inspect":
            output = {}
            for side, (raw, name) in sources.items():
                source, rows = _source(raw, name, delimiter)
                output[side] = {**source, "preview": rows[:PREVIEW_RECORDS]}
        else:
            avatar = AvatarFactory(llm_adapter=NoModelAdapter()).create_avatar(
                user_id="local-browser", name="Кристина", role_id="reconciliation_specialist")
            report = avatar.reconcile_lists(
                sources["left"][0], sources["right"][0],
                left_name=sources["left"][1], right_name=sources["right"][1],
                key=payload.get("key"), fields=payload.get("fields"),
                strip=payload.get("strip", False), delimiter=delimiter)
            # Preserve the CLI's independent 16 MiB JSON and HTML output gates.
            render_json(report)
            output = {"report": report, "html": render_html(report)}
        return JSONResponse(output)
    except (ValueError, RecursionError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


@app.post("/api/inspect")
async def inspect_sources(request: Request):
    return await anyio.to_thread.run_sync(partial(_process, request.scope["reconciliation_body"], "inspect"), limiter=_WORKERS)


@app.post("/api/compare")
async def compare_sources(request: Request):
    return await anyio.to_thread.run_sync(partial(_process, request.scope["reconciliation_body"], "compare"), limiter=_WORKERS)


@app.get("/")
async def index():
    return FileResponse(STATIC_ROOT / "index.html", media_type="text/html")


@app.get("/assets/app.js")
async def javascript():
    return FileResponse(STATIC_ROOT / "app.js", media_type="text/javascript")


@app.get("/assets/style.css")
async def stylesheet():
    return FileResponse(STATIC_ROOT / "style.css", media_type="text/css")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Локальный браузерный интерфейс Кристины")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    import uvicorn
    print(f"Кристина: откройте http://127.0.0.1:{args.port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
