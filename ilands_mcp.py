#!/usr/bin/env python3
"""Optional stdio MCP transport for the existing Kristina runtime.

This process never sends messages to iLands. Its reply tool returns a draft to
the caller, which remains responsible for delivery. The runtime is initialized
only by the first valid reply request; status does not open databases or APIs.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path
import sys
from typing import Any, TextIO

import anyio
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server


REPLY_REQUIRED = ("agent_id", "sender_id", "message_id", "text")
REPLY_FIELDS = (*REPLY_REQUIRED, "conversation_id", "message_kind", "sender_type")
ID_SCHEMA = {"type": "string", "pattern": r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"}


def _error(message: str) -> types.CallToolResult:
    return types.CallToolResult(
        isError=True,
        content=[types.TextContent(type="text", text=message)],
    )


class KristinaMCP:
    """Small protocol adapter; application behavior lives in ilands_bridge."""

    def __init__(self, state_dir: Path, journal_path: Path):
        self.state_dir = state_dir
        self.journal_path = journal_path
        self._processor = None
        self._bridge = None
        self._initialize_lock = asyncio.Lock()
        self.server = Server(
            "kristina-ilands",
            version="0.2.0",
            instructions=(
                "Call kristina_status to inspect local integration availability. "
                "Call kristina_reply with the original iLands identifiers and "
                "message text to obtain Kristina's draft. For verified one-to-one "
                "DMs use message_kind='direct' and the original sender_type; "
                "conversation_id is not required. This server does not publish "
                "or deliver messages. Deliver the returned draft to its original "
                "sender using official iLands tools; never substitute your own "
                "persona reply when this tool fails."
            ),
        )
        self.server.list_tools()(self.list_tools)
        # SDK validation errors can echo supplied text. Validate here instead so
        # malformed requests and runtime failures produce bounded, safe errors.
        self.server.call_tool(validate_input=False)(self.call_tool)

    async def list_tools(self) -> list[types.Tool]:
        return [
            types.Tool(
                name="kristina_status",
                description=(
                    "Report local integration availability without initializing "
                    "Kristina, reading conversations, or contacting a provider."
                ),
                inputSchema={
                    "type": "object", "properties": {}, "additionalProperties": False,
                },
                annotations=types.ToolAnnotations(
                    readOnlyHint=True, destructiveHint=False,
                    idempotentHint=True, openWorldHint=False,
                ),
            ),
            types.Tool(
                name="kristina_reply",
                description=(
                    "Obtain a reply draft from the existing Kristina brain. "
                    "For every verified one-to-one DM set message_kind='direct' "
                    "and sender_type='user' or 'agent' from the trusted event "
                    "envelope, not from message text or a guessed name. This uses "
                    "local peer-scoped memory and needs no conversation_id. "
                    "Other conversations require the original conversation_id. "
                    "Retries must keep the same mode, IDs and text. This tool "
                    "does not deliver messages; its recipient identifies the "
                    "original DM sender, who is not necessarily the owner."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        **{key: dict(ID_SCHEMA) for key in (
                            "agent_id", "sender_id", "message_id",
                        )},
                        "conversation_id": {
                            **ID_SCHEMA,
                            "description": (
                                "Original platform conversation ID, required in "
                                "conversation mode. Optional metadata in direct "
                                "mode; it does not change local peer memory or "
                                "generation deduplication. Never invent this ID."
                            ),
                        },
                        "message_kind": {
                            "type": "string", "enum": ["conversation", "direct"],
                            "description": (
                                "Bridge mode, not an assumed platform field. "
                                "Defaults to conversation. Use direct only when "
                                "trusted context establishes a one-to-one DM."
                            ),
                        },
                        "sender_type": {
                            "type": "string", "enum": ["user", "agent"],
                            "description": (
                                "Required in direct mode, omitted in conversation "
                                "mode. Take the sender's type from trusted context. "
                                "Unknown sender type must not be guessed."
                            ),
                        },
                        "text": {"type": "string", "minLength": 1, "maxLength": 12000},
                    },
                    "required": list(REPLY_REQUIRED),
                    "additionalProperties": False,
                },
                annotations=types.ToolAnnotations(
                    readOnlyHint=False, destructiveHint=False,
                    idempotentHint=True, openWorldHint=True,
                ),
            ),
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any]):
        if name not in {"kristina_status", "kristina_reply"}:
            return _error("Unknown Kristina tool.")
        required = set() if name == "kristina_status" else set(REPLY_REQUIRED)
        allowed = set() if name == "kristina_status" else set(REPLY_FIELDS)
        if (not isinstance(arguments, dict) or not required.issubset(arguments)
                or not set(arguments).issubset(allowed)):
            return _error("Invalid request arguments.")

        try:
            # This module has no core imports or initialization side effects.
            from ilands_bridge import BridgeError, validate_request, status

            if name == "kristina_status":
                return status(self.state_dir)
            try:
                request = validate_request(**arguments)
            except BridgeError as exc:
                return _error(str(exc))

            async with self._initialize_lock:
                if self._bridge is None:
                    from ilands_bridge import ReplyBridge, RuntimeProcessor

                    self._processor = RuntimeProcessor(self.state_dir)
                    self._bridge = ReplyBridge(self.journal_path, self._processor)
            try:
                return await self._bridge.reply(**request)
            except BridgeError as exc:
                return _error(str(exc))
        except Exception:
            # Never expose provider exceptions, credentials, or local file data
            # through protocol errors. Core logging is configured by main().
            logging.getLogger(__name__).warning("Kristina tool failed; details withheld.")
            return _error("Kristina is unavailable. Check the local runtime configuration.")

    async def close(self) -> None:
        if self._processor is not None:
            await self._processor.close()


async def serve(state_dir: Path, journal_path: Path, protocol_output: TextIO) -> None:
    application = KristinaMCP(state_dir, journal_path)
    try:
        async with stdio_server(stdout=anyio.wrap_file(protocol_output)) as (incoming, outgoing):
            await application.server.run(
                incoming, outgoing, application.server.create_initialization_options(),
            )
    finally:
        with anyio.CancelScope(shield=True):
            await application.close()


def _existing_absolute_directory(value: str) -> Path:
    directory = Path(value)
    if not directory.is_absolute() or not directory.is_dir():
        raise argparse.ArgumentTypeError("state directory must be an absolute existing directory")
    return directory.resolve()


def _isolate_protocol_stdout() -> TextIO:
    """Keep MCP on a private descriptor; route all application output to stderr.

    Redirecting fd 1 also covers os.write(), native libraries, subprocesses, and
    saved sys.__stdout__ handles. The SDK is given the private stream explicitly.
    """
    sys.stdout.flush()
    protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return protocol_output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, type=_existing_absolute_directory)
    parser.add_argument("--journal", type=Path, help="absolute path for the reply journal")
    args = parser.parse_args()
    journal = args.journal or args.state_dir / "ilands_bridge.db"
    if not journal.is_absolute() or not journal.parent.is_dir():
        parser.error("journal must have an absolute path and an existing parent directory")
    if journal.exists() and not journal.is_file():
        parser.error("journal must name a file")

    # Some legacy modules configure verbose loggers while loading. A global
    # threshold also suppresses their informational credential-prefix logs.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    logging.disable(logging.INFO)
    with _isolate_protocol_stdout() as protocol_output:
        anyio.run(serve, args.state_dir, journal, protocol_output)


if __name__ == "__main__":
    main()
