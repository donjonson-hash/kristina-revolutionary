"""Exercise real conversation assembly with SQLite and mocked external delivery/LLM."""

import asyncio
import sqlite3
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agents.router import AgentRouter
from conversation_context import conversation_session_id, format_conversation_history
from persistent_memory import PersistentMemory


def conversation(user=1, chat=None, agent="kristina", channel="telegram"):
    return {"user_id": user, "chat_id": user if chat is None else chat,
            "channel": channel, "agent_id": agent}


def update_for(user=1, chat=None, text="Привет"):
    chat = user if chat is None else chat
    return SimpleNamespace(
        effective_user=SimpleNamespace(id=user),
        effective_chat=SimpleNamespace(id=chat, type="private" if chat == user else "group"),
        message=SimpleNamespace(text=text, reply_text=AsyncMock()),
        callback_query=SimpleNamespace(data="agent_advisor", answer=AsyncMock(), edit_message_text=AsyncMock()),
    )


@pytest.fixture
def memory(tmp_path):
    db = PersistentMemory(str(tmp_path / "conversation.db"))
    yield db
    db.close()


@pytest.fixture
def persona_router(memory, monkeypatch):
    import agents.kristina_persona as persona
    from agents.kristina_advisor import KristinaAdvisorAgent
    from agents.kristina_creative import KristinaCreativeAgent

    monkeypatch.setattr(persona, "ai", SimpleNamespace(generate=AsyncMock(return_value="Принято.")))
    monkeypatch.setattr(persona, "asyncio", SimpleNamespace(sleep=AsyncMock()))
    from emotional_core import EmotionalCore
    from mood_engine import MoodEngine
    core = EmotionalCore(clock=lambda: datetime(2026, 9, 5, 10, tzinfo=timezone.utc))
    monkeypatch.setattr(persona, "mood_engine", MoodEngine(core))
    bridge = SimpleNamespace(process_signal=AsyncMock(return_value={}))
    monkeypatch.setattr(persona, "get_brain_bridge", lambda: bridge)
    agent = persona.KristinaPersonaAgent()
    agent.use_brain_integration = True
    router = AgentRouter(memory=memory)
    router.register_agent(agent, is_default=True)
    router.register_agent(KristinaAdvisorAgent())
    router.register_agent(KristinaCreativeAgent())
    return router, persona.ai.generate, bridge


@pytest.fixture
def telegram_bot(persona_router, monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot
    router, _, _ = persona_router
    monkeypatch.setattr(bot, "router", router)
    import agents.kristina_persona as persona
    monkeypatch.setattr(bot, "emotional_core", persona.mood_engine.core)
    monkeypatch.setattr(bot, "active_agents", {})
    monkeypatch.setattr(bot, "active_chat_ids", set())
    monkeypatch.setattr(bot, "last_user_activity", {})
    monkeypatch.setattr(bot, "last_proactive", {})
    monkeypatch.setattr(bot, "next_proactive_opportunity", {})
    monkeypatch.setattr(bot, "recent_proactive", defaultdict(lambda: deque(maxlen=6)))
    monkeypatch.setattr(bot, "user_context", {})
    monkeypatch.setattr(bot, "user_tts_enabled", {})
    return bot


async def test_full_turn_survives_restart_and_reaches_persona(persona_router, memory):
    router, generate, bridge = persona_router
    detail = "Описание задачи. " * 20 + "Договорились использовать SQLite без Redis."
    await router.process(detail, conversation())
    memory.close()
    reopened = PersistentMemory(memory.db_path)
    try:
        fresh_router = AgentRouter(memory=reopened)
        from agents.kristina_persona import KristinaPersonaAgent
        fresh_router.register_agent(KristinaPersonaAgent(), is_default=True)
        await fresh_router.process("На чём остановились?", conversation())
        prompt = generate.call_args.kwargs["prompt"]
        assert detail in prompt
        assert "assistant: Принято." in prompt
        session_id = conversation_session_id(conversation())
        assert generate.call_args.kwargs["session_id"] == session_id
        assert bridge.process_signal.call_args.kwargs["context"]["session_id"] == session_id
        assert len(reopened.get_recent_messages(session_id)) == 4
    finally:
        reopened.close()


@pytest.mark.parametrize("other", [conversation(2), conversation(1, -100), conversation(2, -100),
                                       conversation(1, channel="web")])
async def test_private_history_never_enters_other_sessions(persona_router, other):
    router, generate, _ = persona_router
    await router.process("PRIVATE-MARKER-ONE", conversation(1))
    await router.process("Другой разговор", other)
    assert "PRIVATE-MARKER-ONE" not in generate.call_args.kwargs["prompt"]
    assert router.default_agent.conversation_history == []


async def test_group_members_and_other_groups_are_isolated(persona_router):
    router, generate, _ = persona_router
    await router.process("GROUP-MARKER-ONE", conversation(1, -100))
    for other in (conversation(2, -100), conversation(1, -200), conversation(1)):
        await router.process("Новая тема", other)
        assert "GROUP-MARKER-ONE" not in generate.call_args.kwargs["prompt"]


async def test_anonymous_request_cannot_reuse_history(persona_router, memory):
    router, generate, _ = persona_router
    await router.process("PRIVATE-MARKER-ONE", conversation())
    await router.process("ANONYMOUS-MARKER", {"agent_id": "kristina", "session_id": conversation_session_id(conversation())})
    await router.process("Ещё вопрос", {"agent_id": "kristina"})
    prompt = generate.call_args.kwargs["prompt"]
    assert "PRIVATE-MARKER-ONE" not in prompt
    assert "ANONYMOUS-MARKER" not in prompt
    assert memory.get_stats()["total_messages"] == 2


async def test_mode_switch_preserves_only_own_conversation(persona_router):
    router, generate, _ = persona_router
    advisor = await router.process("Нужен план по FEATURE-ALPHA", conversation(agent="advisor"))
    assert advisor.agent_name == "Kristina-Advisor"
    other = await router.process("Привет", conversation(2))
    assert other.agent_name == "Kristina"
    assert "FEATURE-ALPHA" not in generate.call_args.kwargs["prompt"]
    await router.process("Продолжим", conversation())
    assert "FEATURE-ALPHA" in generate.call_args.kwargs["prompt"]
    assert advisor.content in generate.call_args.kwargs["prompt"]


async def test_legacy_unscoped_history_is_preserved_but_not_injected(persona_router, memory):
    memory.save_message("user_1", "user", "AMBIGUOUS-LEGACY-MARKER", channel="web")
    router, generate, _ = persona_router
    await router.process("Привет", conversation())
    assert "AMBIGUOUS-LEGACY-MARKER" not in generate.call_args.kwargs["prompt"]
    assert memory.get_recent_messages("user_1")[0]["content"] == "AMBIGUOUS-LEGACY-MARKER"


async def test_bot_mode_selection_is_per_chat_and_user(telegram_bot):
    bot = telegram_bot
    await bot.button_callback(update_for(1, -100), None)
    chosen = conversation_session_id(conversation(1, -100))
    assert bot.active_agents[chosen] == "advisor"
    bot.router.process = AsyncMock(return_value=SimpleNamespace(content="Ответ"))
    for user, chat, expected in ((1, -100, "advisor"), (2, -100, "kristina"), (1, 1, "kristina")):
        await bot.handle_message(update_for(user, chat), None)
        ctx = bot.router.process.call_args.kwargs["context"]
        assert ctx["agent_id"] == expected
        assert ctx["chat_id"] == chat
    # Speaking in a group must not register unsolicited DMs to either member.
    assert bot.active_chat_ids == {1}


async def test_proactive_is_saved_and_followup_sees_it(telegram_bot, persona_router, memory, monkeypatch):
    bot = telegram_bot
    router, generate, _ = persona_router
    await router.process("Наша задача — FEATURE-BETA", conversation())
    bot.active_chat_ids.add(1)
    bot.next_proactive_opportunity[1] = datetime.now(timezone.utc) - timedelta(minutes=1)
    monkeypatch.setattr(bot, "decision_engine", SimpleNamespace(decide=lambda *a, **k: SimpleNamespace(
        action="message", intention="share", score=0.9, reason="test")))
    proactive = AsyncMock(return_value="Есть идея для FEATURE-BETA: начнём с теста.")
    monkeypatch.setattr(bot, "generate_autonomous_message", proactive)
    delivery = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
    await bot.autonomous_proactive_tick(delivery)
    assert "FEATURE-BETA" in proactive.call_args.kwargs["dialog_history"]
    saved = memory.get_recent_messages(conversation_session_id(conversation()))
    assert saved[-1]["role"] == "assistant"
    assert saved[-1]["content"] == proactive.return_value
    await router.process("Почему ты так решила?", conversation())
    assert proactive.return_value in generate.call_args.kwargs["prompt"]


async def test_failed_proactive_delivery_is_not_a_memory(telegram_bot, memory, monkeypatch):
    bot = telegram_bot
    bot.active_chat_ids.add(1)
    bot.next_proactive_opportunity[1] = datetime.now(timezone.utc) - timedelta(minutes=1)
    monkeypatch.setattr(bot, "decision_engine", SimpleNamespace(decide=lambda *a, **k: SimpleNamespace(
        action="message", intention="share", score=0.9, reason="test")))
    monkeypatch.setattr(bot, "generate_autonomous_message", AsyncMock(return_value="Не доставлено"))
    delivery = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock(side_effect=RuntimeError("offline"))))
    await bot.autonomous_proactive_tick(delivery)
    assert memory.get_recent_messages(conversation_session_id(conversation())) == []
    assert not bot.recent_proactive[1]


async def test_clear_removes_own_history_and_document_context_only(telegram_bot, persona_router, memory):
    bot = telegram_bot
    router, generate, _ = persona_router
    own = conversation_session_id(conversation())
    other = conversation_session_id(conversation(2))
    group = conversation_session_id(conversation(1, -100))
    for key in (own, other, group):
        memory.save_message(key, "assistant", "SAVED-MARKER")
        bot.user_context[key] = {"last_document": {"text": "DOCUMENT-MARKER"}}
    bot.recent_proactive[1].append("PROACTIVE-MARKER")
    bot.recent_proactive[2].append("OTHER-PROACTIVE")
    update = update_for()
    await bot.clear_command(update, None)
    assert memory.get_recent_messages(own) == []
    assert memory.get_recent_messages(other) and memory.get_recent_messages(group)
    assert own not in bot.user_context
    assert other in bot.user_context and group in bot.user_context
    assert not bot.recent_proactive[1] and bot.recent_proactive[2]
    update.message.reply_text.assert_awaited_once_with("🧹 История очищена!")
    await router.process("Продолжим", conversation())
    assert "SAVED-MARKER" not in generate.call_args.kwargs["prompt"]


async def test_clear_failure_does_not_claim_success(telegram_bot, memory, monkeypatch):
    def fail(_):
        raise RuntimeError("database unavailable")
    monkeypatch.setattr(memory, "clear_user", fail)
    update = update_for()
    with pytest.raises(RuntimeError, match="database unavailable"):
        await telegram_bot.clear_command(update, None)
    update.message.reply_text.assert_not_awaited()


async def test_document_context_does_not_cross_from_private_to_group(telegram_bot, memory, monkeypatch):
    import ai_client
    import document_handler
    bot = telegram_bot
    monkeypatch.setattr(document_handler, "user_context", bot.user_context)
    monkeypatch.setattr(document_handler, "get_memory", lambda: memory)
    monkeypatch.setattr(document_handler, "DOCUMENT_PROCESSOR_AVAILABLE", True)
    monkeypatch.setattr(document_handler, "get_document_processor", lambda: SimpleNamespace(
        process_document=AsyncMock(return_value={
            "success": True, "text": "PRIVATE-DOCUMENT", "stats": {"words": 1},
        })))
    monkeypatch.setattr(document_handler.os, "remove", lambda _: None)
    monkeypatch.setattr(ai_client, "get_ai_client", lambda: SimpleNamespace(
        chat=AsyncMock(return_value="PRIVATE-ANALYSIS"), close=AsyncMock()))
    update = update_for()
    update.message.document = SimpleNamespace(file_size=100, file_id="file-1", file_name="brief.txt", mime_type="text/plain")
    update.message.reply_text.return_value = SimpleNamespace(edit_text=AsyncMock())
    delivery = SimpleNamespace(bot=SimpleNamespace(get_file=AsyncMock(return_value=SimpleNamespace(
        download_to_drive=AsyncMock()))))
    await document_handler.handle_document(update, delivery)
    own = conversation_session_id(conversation())
    group = conversation_session_id(conversation(1, -100))
    assert bot.user_context[own]["last_document"]["text"] == "PRIVATE-DOCUMENT"
    assert group not in bot.user_context
    assert "PRIVATE-ANALYSIS" in memory.get_recent_messages(own)[-1]["content"]
    assert memory.get_recent_messages(group) == []
    monkeypatch.setattr(bot, "detect_proposal_intent", lambda _: True)
    bot.router.process = AsyncMock(return_value=SimpleNamespace(content="Пришли документ"))
    await bot.handle_message(update_for(1, -100, text="Составь КП"), None)
    bot.router.process.assert_awaited_once()


def test_exchange_failure_rolls_back_the_entire_turn(memory):
    connection = memory._get_connection()
    connection.execute("""CREATE TRIGGER reject_assistant BEFORE INSERT ON messages
        WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        memory.save_exchange("session", "question", "answer", channel="telegram")
    assert memory.get_recent_messages("session") == []


async def test_clear_waits_for_inflight_reply_then_removes_it(telegram_bot, persona_router, memory):
    router, generate, _ = persona_router
    entered, release = asyncio.Event(), asyncio.Event()
    async def delayed_reply(**kwargs):
        entered.set()
        await release.wait()
        return "INFLIGHT-MARKER"
    generate.side_effect = delayed_reply
    turn = asyncio.create_task(router.process("Задача", conversation()))
    await entered.wait()
    clear = asyncio.create_task(telegram_bot.clear_command(update_for(), None))
    await asyncio.sleep(0)
    assert not clear.done()
    release.set()
    await asyncio.gather(turn, clear)
    assert memory.get_recent_messages(conversation_session_id(conversation())) == []


def test_history_budget_keeps_recent_details():
    recent = "Длинное описание " * 20 + "решение: SQLite"
    history = format_conversation_history([
        {"role": "user", "content": "old " * 5000},
        {"role": "assistant", "content": recent},
    ])
    assert recent in history
    assert len(history) <= 12000
    assert "old " not in history
    assert len(format_conversation_history([{"role": "user", "content": "x" * 20000}])) <= 12000


async def test_proactive_uses_the_state_changed_by_conversation(telegram_bot, persona_router, monkeypatch):
    bot = telegram_bot
    router, _, _ = persona_router
    for _ in range(15):
        await router.process("Продолжим", conversation())
    tired_energy = bot.emotional_core.state["energy"]
    assert tired_energy < 0.4
    bot.active_chat_ids.add(1)
    bot.next_proactive_opportunity[1] = datetime.now(timezone.utc) - timedelta(minutes=1)
    monkeypatch.setattr(bot, "decision_engine", SimpleNamespace(decide=lambda *a, **k: SimpleNamespace(
        action="message", intention="share", score=0.9, reason="test")))
    proactive = AsyncMock(return_value="Давай вернёмся к этому завтра.")
    monkeypatch.setattr(bot, "generate_autonomous_message", proactive)
    await bot.autonomous_proactive_tick(SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock())))
    snapshot = proactive.call_args.args[1]
    assert snapshot["state"]["energy"] == tired_energy
    assert "Уставшая" in snapshot["mood_description"]
