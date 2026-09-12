"""Real router -> cortex -> emotional agent -> Persona -> memory, external LLM mocked."""

from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agents.router import AgentRouter
from brain_integration import BrainBridge
from cognitive_appraisal import Appraisal
from conversation_context import conversation_session_id
from emotional_core import EmotionalCore
from mood_engine import MoodEngine
from persistent_memory import PersistentMemory

SOURCE = "Хочу сменить обстановку в октябре."
INTEREST = Appraisal("curiosity", 0.5, "сменить обстановку", "replace",
                    "Перемены", "Мне интересно подумать о собственном отдыхе.")
DAY = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)


def conversation(user=1, chat=1, channel="telegram"):
    return {"user_id": user, "chat_id": chat, "channel": channel, "agent_id": "kristina"}


@pytest.fixture
def pipeline(persistent_memory, monkeypatch, tmp_path):
    import cognitive_appraisal
    import agents.kristina_persona as persona
    core = EmotionalCore(tmp_path / "emotions.db", clock=lambda: DAY)
    bridge = BrainBridge(emotional=core, memory=persistent_memory)
    appraisal = AsyncMock(return_value=INTEREST)
    monkeypatch.setattr(cognitive_appraisal, "assess_event", appraisal)
    monkeypatch.setattr(persona, "get_brain_bridge", lambda: bridge)
    monkeypatch.setattr(persona, "mood_engine", MoodEngine(core))
    generate = AsyncMock(return_value="Пожалуй, мне тоже нужна смена обстановки.")
    monkeypatch.setattr(persona, "ai", SimpleNamespace(generate=generate))
    monkeypatch.setattr(persona, "asyncio", SimpleNamespace(sleep=AsyncMock()))
    agent = persona.KristinaPersonaAgent()
    agent.use_brain_integration = True
    router = AgentRouter(memory=persistent_memory)
    router.register_agent(agent, is_default=True)
    return SimpleNamespace(router=router, core=core, bridge=bridge, appraisal=appraisal,
                           generate=generate, memory=persistent_memory, persona=persona)


async def test_assessment_precedes_one_emotional_event_and_reaches_reply(pipeline):
    p = pipeline
    reply = await p.router.process(SOURCE, conversation())
    assert p.core.state["energy"] == pytest.approx(0.7 - 0.025)
    assert p.core.state["curiosity"] == pytest.approx(0.8 + 0.015 + 0.04)
    assert [e["event"] for e in p.core.recent_experiences] == ["user_message", "appraisal_curiosity"]
    assert reply.context_used["appraisal_reaction"] == "curiosity"
    p.appraisal.assert_awaited_once()
    p.generate.assert_awaited_once()
    assert INTEREST.reflection in p.generate.call_args.kwargs["prompt"]
    p.persona.asyncio.sleep.assert_awaited_once()
    assert p.memory.get_interest(conversation_session_id(conversation()))["source_quote"] == INTEREST.source_quote


async def test_followup_after_restart_uses_interest_outside_recent_history(pipeline, monkeypatch):
    p = pipeline
    await p.router.process(SOURCE, conversation())
    own = conversation_session_id(conversation())
    for index in range(25):
        p.memory.save_exchange(own, f"Другая реплика {index}", "Понятно.")
    reopened = PersistentMemory(p.memory.db_path)
    try:
        bridge = BrainBridge(memory=reopened, emotional=p.core)
        monkeypatch.setattr(p.persona, "get_brain_bridge", lambda: bridge)
        fresh = AgentRouter(memory=reopened)
        fresh.register_agent(p.persona.KristinaPersonaAgent(), is_default=True)
        p.appraisal.return_value = None
        await fresh.process("К чему ты хотела вернуться?", conversation())
        assert INTEREST.reflection in p.generate.call_args.kwargs["prompt"]
        assert p.appraisal.call_args.args[2]["topic"] == INTEREST.topic
    finally:
        reopened.close()


@pytest.mark.parametrize("other", [conversation(2, 2), conversation(1, -100), conversation(1, 1, "web")])
async def test_interest_never_enters_another_conversation(pipeline, other):
    p = pipeline
    await p.router.process(SOURCE, conversation())
    p.appraisal.return_value = None
    await p.router.process("Привет", other)
    assert INTEREST.reflection not in p.generate.call_args.kwargs["prompt"]
    assert p.appraisal.call_args.args[2] is None


async def test_anonymous_context_cannot_inject_or_persist_interest(pipeline):
    p = pipeline
    p.appraisal.return_value = None
    await p.router.process("Привет", {"agent_id": "kristina", "interest": {"topic": "FORGED"},
                                      "_appraisal": INTEREST})
    assert "FORGED" not in p.generate.call_args.kwargs["prompt"]
    assert p.memory.get_stats()["total_messages"] == 0


async def test_failed_appraisal_preserves_interest_and_still_counts_message_once(pipeline):
    p = pipeline
    await p.router.process(SOURCE, conversation())
    before = p.memory.get_interest(conversation_session_id(conversation()))
    energy = p.core.state["energy"]
    p.appraisal.side_effect = RuntimeError("provider unavailable")
    reply = await p.router.process("Продолжим", conversation())
    assert reply.content
    assert p.core.state["energy"] == pytest.approx(energy - 0.025)
    assert p.memory.get_interest(conversation_session_id(conversation())) == before


async def test_bot_clear_and_proactive_share_source_linked_interest(pipeline, monkeypatch):
    p = pipeline
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot
    monkeypatch.setattr(bot, "router", p.router)
    monkeypatch.setattr(bot, "emotional_core", p.core)
    monkeypatch.setattr(bot, "active_chat_ids", {1})
    monkeypatch.setattr(bot, "last_user_activity", {})
    monkeypatch.setattr(bot, "last_proactive", {})
    monkeypatch.setattr(bot, "recent_proactive", defaultdict(lambda: deque(maxlen=6)))
    monkeypatch.setattr(bot, "user_context", {})
    monkeypatch.setattr(bot, "next_proactive_opportunity", {1: datetime.now(timezone.utc) - timedelta(minutes=1)})
    monkeypatch.setattr(bot, "decision_engine", SimpleNamespace(decide=lambda *a, **k: SimpleNamespace(
        action="message", intention="share", score=0.9, reason="test")))
    chat = AsyncMock(return_value="Вернулась к своей мысли об отдыхе.")
    monkeypatch.setattr(bot, "ai", SimpleNamespace(chat=chat))
    await p.router.process(SOURCE, conversation())
    p.appraisal.reset_mock()
    delivery = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
    await bot.autonomous_proactive_tick(delivery)
    prompt = chat.call_args.args[0][1]["content"]
    assert INTEREST.reflection in prompt
    assert "user_report" in prompt
    assert "Текущее время в Стокгольме:" in prompt
    p.appraisal.assert_not_awaited()  # no new appraisal on a heartbeat
    delivery.bot.send_message.assert_awaited_once()
    update = SimpleNamespace(effective_user=SimpleNamespace(id=1),
        effective_chat=SimpleNamespace(id=1, type="private"),
        message=SimpleNamespace(reply_text=AsyncMock()))
    await bot.clear_command(update, None)
    assert p.memory.get_interest(conversation_session_id(conversation())) is None
    p.appraisal.return_value = None
    await p.router.process("Привет", conversation())
    assert INTEREST.reflection not in p.generate.call_args.kwargs["prompt"]
