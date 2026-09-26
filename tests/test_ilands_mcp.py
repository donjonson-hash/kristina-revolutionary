"""Exercise the optional transport with the official SDK over real stdio pipes.

Install requirements-ilands.txt for this suite. Missing MCP is an installation
error, not a reason to silently skip all transport coverage in CI.
"""

from contextlib import asynccontextmanager
from datetime import timedelta
import json
from pathlib import Path
import sys
import textwrap

import anyio
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


ROOT = Path(__file__).resolve().parents[1]
REQUEST = {
    "agent_id": "kristina-123", "conversation_id": "conversation:456",
    "sender_id": "visitor_789", "message_id": "message-001", "text": "Привет, Кристина!",
}


@asynccontextmanager
async def _client(state_dir, errlog, bootstrap=""):
    code = textwrap.dedent(bootstrap) + "\nfrom ilands_mcp import main\nmain()\n"
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-c", code, "--state-dir", str(state_dir)],
        cwd=ROOT,
        env={"PYTHONPATH": str(ROOT)},
    )
    with anyio.fail_after(20):
        async with stdio_client(parameters, errlog=errlog) as (incoming, outgoing):
            async with ClientSession(
                incoming, outgoing, read_timeout_seconds=timedelta(seconds=10),
            ) as session:
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "kristina-ilands"
                yield session


async def test_stdio_status_and_invalid_reply_need_no_core_network_or_state_writes(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    bootstrap = """
        import importlib.abc
        import socket
        import sys

        class NoCore(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname.split('.')[0] in {
                    'agents', 'brain_unified', 'persistent_memory',
                    'emotional_core', 'database',
                }:
                    raise AssertionError('Core import attempted during read-only check')
                return None

        sys.meta_path.insert(0, NoCore())
        original_connect = socket.socket.connect
        def no_network(sock, address):
            if sock.family in (socket.AF_INET, socket.AF_INET6):
                raise AssertionError('Network attempted during read-only check')
            return original_connect(sock, address)
        socket.socket.connect = no_network
    """
    with (tmp_path / "stderr.txt").open("w+") as errlog:
        async with _client(state_dir, errlog, bootstrap) as session:
            tools = (await session.list_tools()).tools
            assert {tool.name for tool in tools} == {"kristina_status", "kristina_reply"}
            reply_tool = next(tool for tool in tools if tool.name == "kristina_reply")
            assert set(reply_tool.inputSchema["required"]) == set(REQUEST) - {"conversation_id"}

            status = await session.call_tool("kristina_status", {})
            assert not status.isError
            assert status.structuredContent["available"] is False
            assert status.structuredContent["core_initialization"] == "deferred_until_reply"

            rejected = await session.call_tool(
                "kristina_reply", {**REQUEST, "agent_id": "../invalid-agent"},
            )
            assert rejected.isError
            assert "Invalid agent_id" in rejected.content[0].text
            assert "../invalid-agent" not in rejected.content[0].text
            assert list(state_dir.iterdir()) == []

            direct = {key: value for key, value in REQUEST.items() if key != "conversation_id"}
            for invalid in (
                direct,  # Missing conversation_id does not imply a DM.
                {**direct, "message_kind": "direct"},
                {**direct, "message_kind": "direct", "sender_type": "unknown"},
                {**direct, "message_kind": "group", "sender_type": "user"},
                {**direct, "message_kind": "direct", "sender_type": "agent", "extra": "secret"},
            ):
                result = await session.call_tool("kristina_reply", invalid)
                assert result.isError
                assert "secret" not in str(result.content)
                assert list(state_dir.iterdir()) == []

            extra = await session.call_tool("kristina_status", {"token": "private-value"})
            assert extra.isError
            assert "private-value" not in extra.content[0].text


async def test_noisy_runtime_keeps_stdio_valid_and_provider_errors_private(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    bootstrap = """
        import os
        import sys
        from types import SimpleNamespace
        import ilands_bridge

        class NoisyRuntime:
            def __init__(self, state_dir):
                print('constructor output', flush=True)

            async def __call__(self, message, context):
                print('runtime print', flush=True)
                os.write(1, b'raw fd output\\n')
                sys.__stdout__.write('saved stdout output\\n')
                sys.__stdout__.flush()
                if message == 'fail':
                    raise RuntimeError('private-provider-key-and-message')
                return SimpleNamespace(content='Я здесь. Давай знакомиться!')

            async def close(self):
                print('runtime closed', flush=True)

        ilands_bridge.RuntimeProcessor = NoisyRuntime
    """
    with (tmp_path / "stderr.txt").open("w+") as errlog:
        async with _client(state_dir, errlog, bootstrap) as session:
            reply = await session.call_tool("kristina_reply", REQUEST)
            assert not reply.isError
            assert reply.structuredContent["text"] == "Я здесь. Давай знакомиться!"
            assert reply.structuredContent["replayed"] is False
            assert reply.structuredContent["delivery"] == "not_managed_by_bridge"

            retry = await session.call_tool("kristina_reply", REQUEST)
            assert not retry.isError
            assert retry.structuredContent["reply_id"] == reply.structuredContent["reply_id"]
            assert retry.structuredContent["replayed"] is True

            failed = await session.call_tool(
                "kristina_reply", {**REQUEST, "message_id": "message-002", "text": "fail"},
            )
            assert failed.isError
            assert "private-provider-key-and-message" not in failed.content[0].text

        errlog.seek(0)
        logs = errlog.read()
    assert "constructor output" in logs
    assert "runtime print" in logs
    assert "raw fd output" in logs
    assert "saved stdout output" in logs
    assert "runtime closed" in logs
    assert "private-provider-key-and-message" not in logs


async def test_stdio_direct_dm_without_conversation_id_preserves_peer_and_replay(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    bootstrap = """
        import json
        from types import SimpleNamespace
        import ilands_bridge

        class InspectRuntime:
            def __init__(self, state_dir):
                self.calls = 0

            async def __call__(self, text, context):
                self.calls += 1
                return SimpleNamespace(content=json.dumps({
                    'call': self.calls, 'context': context, 'text': text,
                }))

            async def close(self):
                pass

        ilands_bridge.RuntimeProcessor = InspectRuntime
    """
    direct = {
        key: value for key, value in REQUEST.items() if key != "conversation_id"
    } | {"message_kind": "direct", "sender_type": "agent"}
    with (tmp_path / "stderr.txt").open("w+") as errlog:
        async with _client(state_dir, errlog, bootstrap) as session:
            first = await session.call_tool("kristina_reply", direct)
            assert not first.isError
            result = first.structuredContent
            assert json.loads(result["text"])["call"] == 1
            assert result["conversation_scope"] == "local_direct_peer"
            assert result["recipient"] == {"type": "agent", "id": direct["sender_id"]}
            assert result["source_message_id"] == direct["message_id"]
            assert result["origin"] == "kristina_python_pipeline"
            assert result["delivery"] == "not_managed_by_bridge"

            # Later inbox metadata must not cause a second generation for this DM.
            retry = await session.call_tool(
                "kristina_reply", {**direct, "conversation_id": "real-platform-conversation"},
            )
            assert not retry.isError
            assert retry.structuredContent == {**result, "replayed": True}

            next_message = await session.call_tool(
                "kristina_reply", {**direct, "message_id": "message-002", "text": "Continue"},
            )
            assert not next_message.isError
            payload = json.loads(next_message.structuredContent["text"])
            assert payload["call"] == 2
            assert payload["context"] == json.loads(result["text"])["context"]
