"""Exercise delivery retries and private conversation boundaries, without an LLM."""

import asyncio
import hashlib
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ilands_bridge import BridgeError, ReplyBridge, RuntimeProcessor, status
from conversation_context import conversation_session_id


def event(**overrides):
    return {
        "agent_id": "agent-1", "conversation_id": "chat-1", "sender_id": "sender-1",
        "message_id": "message-1", "text": "Привет, Кристина!", **overrides,
    }


def direct_event(**overrides):
    return event(**{
        "conversation_id": None, "message_kind": "direct", "sender_type": "user", **overrides,
    })


async def test_retry_after_restart_reuses_response_without_second_model_call(tmp_path):
    process = AsyncMock(return_value=SimpleNamespace(content="Привет!"))
    journal = tmp_path / "replies.db"
    first = await ReplyBridge(journal, process).reply(**event())
    retry = await ReplyBridge(journal, process).reply(**event())
    assert first["text"] == retry["text"] == "Привет!"
    assert first["reply_id"] == retry["reply_id"]
    assert retry["replayed"] and not first["replayed"]
    assert retry["delivery"] == "not_managed_by_bridge"
    process.assert_awaited_once()


@pytest.mark.parametrize("changed", [{"text": "Changed"}, {"sender_id": "other-person"}])
async def test_reused_message_id_cannot_change_payload(tmp_path, changed):
    process = AsyncMock(return_value=SimpleNamespace(content="Reply"))
    bridge = ReplyBridge(tmp_path / "replies.db", process)
    await bridge.reply(**event())
    with pytest.raises(BridgeError, match="different content or sender"):
        await bridge.reply(**event(**changed))
    assert process.await_count == 1


async def test_interrupted_generation_is_not_replayed_automatically(tmp_path):
    process = AsyncMock(side_effect=asyncio.CancelledError)
    journal = tmp_path / "replies.db"
    with pytest.raises(asyncio.CancelledError):
        await ReplyBridge(journal, process).reply(**event())
    replacement = AsyncMock(return_value=SimpleNamespace(content="Duplicate"))
    with pytest.raises(BridgeError, match="unresolved"):
        await ReplyBridge(journal, replacement).reply(**event())
    replacement.assert_not_awaited()


async def test_errors_are_sanitized_and_retry_does_not_repeat_side_effects(tmp_path):
    process = AsyncMock(side_effect=RuntimeError("private credential provider-details"))
    bridge = ReplyBridge(tmp_path / "replies.db", process)
    with pytest.raises(BridgeError) as error:
        await bridge.reply(**event())
    assert "private" not in str(error.value)
    with pytest.raises(BridgeError, match="unresolved"):
        await bridge.reply(**event())
    assert process.await_count == 1


async def test_concurrent_instances_cannot_generate_twice(tmp_path):
    started, release = asyncio.Event(), asyncio.Event()
    async def process(message, context):
        started.set()
        await release.wait()
        return SimpleNamespace(content="Only once")
    journal = tmp_path / "replies.db"
    task = asyncio.create_task(ReplyBridge(journal, process).reply(**event()))
    await started.wait()
    try:
        with pytest.raises(BridgeError, match="another event"):
            await ReplyBridge(journal, process).reply(**event())
    finally:
        release.set()
        await task


async def test_real_router_history_isolated_from_telegram_and_other_ilands_agents(tmp_path):
    from agents.router import AgentRouter
    from agents.base_agent import BaseAgent, AgentResponse
    from persistent_memory import PersistentMemory
    memory = PersistentMemory(str(tmp_path / "memory.db"))
    observed = []
    class Persona(BaseAgent):
        async def process(self, text, context):
            observed.append(context)
            return AgentResponse(content="Saved reply", agent_name="Kristina", confidence=1.0,
                                 emotion="neutral", suggested_actions=[], context_used={})
    router = AgentRouter(memory=memory)
    router.register_agent(Persona("Kristina", "test", "test"), is_default=True)
    telegram_id = conversation_session_id({"channel": "telegram", "user_id": "sender-1", "chat_id": "chat-1"})
    memory.save_message(telegram_id, "user", "TELEGRAM-PRIVATE")
    bridge = ReplyBridge(tmp_path / "journal.db", router.process)
    try:
        await bridge.reply(**event(text="ILANDS-MARKER"))
        await bridge.reply(**event(message_id="message-2", text="Continue"))
        assert "ILANDS-MARKER" in str(observed[-1]["history"])
        assert "TELEGRAM-PRIVATE" not in str(observed)
        await bridge.reply(**event(agent_id="other-agent"))
        assert observed[-1]["history"] == []
        await bridge.reply(**event(sender_id="other-sender", message_id="message-3"))
        assert observed[-1]["history"] == []
    finally:
        memory.close()


@pytest.mark.parametrize("changed", [{"sender_id": ""}, {"sender_id": "../private"},
    {"agent_id": 123}, {"message_id": "x" * 129}, {"text": " "}, {"text": "x" * 12001}])
async def test_bad_events_do_not_create_journal_or_call_core(tmp_path, changed):
    process = AsyncMock()
    with pytest.raises(BridgeError):
        await ReplyBridge(tmp_path / "replies.db", process).reply(**event(**changed))
    assert list(tmp_path.iterdir()) == []
    process.assert_not_awaited()


def test_status_and_runtime_construction_do_not_open_state_or_initialize_core(tmp_path):
    (tmp_path / ".env").write_text("DEEPSEEK_API_KEY=private")
    processor = RuntimeProcessor(tmp_path)
    assert not status(tmp_path)["available"]
    assert processor._router is None
    assert [p.name for p in tmp_path.iterdir()] == [".env"]


async def test_missing_existing_memory_is_not_replaced_with_empty_identity(tmp_path):
    with pytest.raises(BridgeError, match="conversation memory"):
        await RuntimeProcessor(tmp_path)("Hello", {})
    assert not (tmp_path / "kristina_memory.db").exists()


async def test_direct_retry_after_restart_ignores_optional_platform_conversation_id(tmp_path):
    process = AsyncMock(return_value=SimpleNamespace(content="Reply for this peer"))
    journal = tmp_path / "replies.db"
    request = direct_event()
    request.pop("conversation_id")
    first = await ReplyBridge(journal, process).reply(**request)
    retry = await ReplyBridge(journal, process).reply(**{
        **request, "conversation_id": "platform-conversation-later-disclosed",
    })
    assert retry == {**first, "replayed": True}
    assert first["conversation_scope"] == "local_direct_peer"
    assert first["recipient"] == {"type": "user", "id": "sender-1"}
    assert first["source_message_id"] == "message-1"
    assert first["delivery"] == "not_managed_by_bridge"
    process.assert_awaited_once()


async def test_direct_retry_rejects_changed_text_without_second_generation(tmp_path):
    process = AsyncMock(return_value=SimpleNamespace(content="One reply"))
    journal = tmp_path / "replies.db"
    await ReplyBridge(journal, process).reply(**direct_event())
    with pytest.raises(BridgeError, match="different content or sender"):
        await ReplyBridge(journal, process).reply(**direct_event(text="Changed text"))
    process.assert_awaited_once()


@pytest.mark.parametrize("first,second", [
    (direct_event(), event()),
    (event(), direct_event()),
    (event(), event(conversation_id="different-conversation")),
])
async def test_scope_change_cannot_regenerate_an_event_after_restart(tmp_path, first, second):
    process = AsyncMock(return_value=SimpleNamespace(content="One reply"))
    journal = tmp_path / "replies.db"
    await ReplyBridge(journal, process).reply(**first)
    with pytest.raises(BridgeError, match="different conversation scope"):
        await ReplyBridge(journal, process).reply(**second)
    process.assert_awaited_once()


@pytest.mark.parametrize("changed", [
    {"sender_type": None}, {"sender_type": "group"}, {"sender_type": []},
    {"message_kind": "group"}, {"message_kind": None},
    {"sender_id": ""}, {"agent_id": 123}, {"message_id": "../message"},
    {"conversation_id": "../invented"}, {"conversation_id": ""},
    {"text": " "},
])
async def test_invalid_direct_requests_have_no_side_effects(tmp_path, changed):
    process = AsyncMock()
    request = {**direct_event(), **changed}
    with pytest.raises(BridgeError):
        await ReplyBridge(tmp_path / "replies.db", process).reply(**request)
    assert list(tmp_path.iterdir()) == []
    process.assert_not_awaited()


async def test_canonical_mode_does_not_silently_accept_sender_type(tmp_path):
    process = AsyncMock()
    with pytest.raises(BridgeError, match="sender_type"):
        await ReplyBridge(tmp_path / "replies.db", process).reply(**event(sender_type="user"))
    assert list(tmp_path.iterdir()) == []
    process.assert_not_awaited()


async def test_scope_guard_is_committed_before_generation_can_be_interrupted(tmp_path):
    process = AsyncMock(side_effect=asyncio.CancelledError)
    journal = tmp_path / "replies.db"
    with pytest.raises(asyncio.CancelledError):
        await ReplyBridge(journal, process).reply(**direct_event())
    replacement = AsyncMock(return_value=SimpleNamespace(content="Duplicate"))
    with pytest.raises(BridgeError, match="different conversation scope"):
        await ReplyBridge(journal, replacement).reply(**event())
    with pytest.raises(BridgeError, match="unresolved"):
        await ReplyBridge(journal, replacement).reply(**direct_event())
    replacement.assert_not_awaited()


async def test_existing_canonical_journal_replays_and_acquires_scope_guard(tmp_path):
    """A real v1 row must survive upgrade without model calls or altered IDs."""
    def old_digest(value):
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(data.encode()).hexdigest()

    request = event()
    key = old_digest([request["agent_id"], request["conversation_id"], request["message_id"]])
    result = {
        "status": "generated", "reply_id": key, "text": "Previously generated",
        "origin": "kristina_python_pipeline", "replayed": False,
        "delivery": "not_managed_by_bridge",
    }
    journal = tmp_path / "replies.db"
    with sqlite3.connect(journal) as conn:
        conn.execute("""CREATE TABLE ilands_replies (
            request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending', 'failed', 'generated')),
            response TEXT
        )""")
        conn.execute("INSERT INTO ilands_replies VALUES (?, ?, 'generated', ?)",
                     (key, old_digest(request), json.dumps(result)))
    process = AsyncMock()
    assert await ReplyBridge(journal, process).reply(**request) == {**result, "replayed": True}
    with pytest.raises(BridgeError, match="different conversation scope"):
        await ReplyBridge(journal, process).reply(**direct_event())
    process.assert_not_awaited()


async def test_real_router_direct_history_isolated_by_mode_agent_peer_and_peer_type(tmp_path):
    from agents.router import AgentRouter
    from agents.base_agent import BaseAgent, AgentResponse
    from persistent_memory import PersistentMemory
    memory = PersistentMemory(str(tmp_path / "memory.db"))
    observed = []

    class Persona(BaseAgent):
        async def process(self, text, context):
            observed.append(context)
            return AgentResponse(content="Saved reply", agent_name="Kristina", confidence=1.0,
                                 emotion="neutral", suggested_actions=[], context_used={})

    router = AgentRouter(memory=memory)
    router.register_agent(Persona("Kristina", "test", "test"), is_default=True)
    telegram_id = conversation_session_id({
        "channel": "telegram", "user_id": "sender-1", "chat_id": "chat-1",
    })
    memory.save_message(telegram_id, "user", "TELEGRAM-PRIVATE")
    bridge = ReplyBridge(tmp_path / "journal.db", router.process)
    try:
        await bridge.reply(**event(message_id="canonical-1", text="CANONICAL-PRIVATE"))
        await bridge.reply(**direct_event(text="DIRECT-USER-PRIVATE"))
        assert observed[-1]["history"] == []
        user_session = observed[-1]["session_id"]
        await bridge.reply(**{**direct_event(message_id="message-2", text="Continue"),
                              "conversation_id": "chat-1"})
        assert observed[-1]["session_id"] == user_session
        assert "DIRECT-USER-PRIVATE" in str(observed[-1]["history"])
        assert "CANONICAL-PRIVATE" not in str(observed[-1]["history"])
        assert "TELEGRAM-PRIVATE" not in str(observed)

        # IDs may overlap between users and agents. The same message ID must
        # remain independently processable for these distinct typed peers.
        agent_reply = await bridge.reply(**direct_event(sender_type="agent", text="AGENT-PRIVATE"))
        assert agent_reply["recipient"] == {"type": "agent", "id": "sender-1"}
        assert observed[-1]["history"] == []
        assert observed[-1]["session_id"] != user_session
        await bridge.reply(**direct_event(sender_id="other-peer"))
        assert observed[-1]["history"] == []
        await bridge.reply(**direct_event(agent_id="other-kristina"))
        assert observed[-1]["history"] == []
        await bridge.reply(**direct_event(message_id="message-3", text="Continue again"))
        assert "DIRECT-USER-PRIVATE" in str(observed[-1]["history"])
        assert "AGENT-PRIVATE" not in str(observed[-1]["history"])
    finally:
        memory.close()
