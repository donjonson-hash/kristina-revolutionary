"""Exercise delivery retries and private conversation boundaries, without an LLM."""

import asyncio
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
