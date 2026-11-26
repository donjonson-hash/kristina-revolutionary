"""Shared cross-chat memory: one person, one memory across all conversations.

Policy (2026-11): what happens in other chats is the character's real
experience and enters the prompt as the ОБЩАЯ ПАМЯТЬ block. The ИСТОРИЯ
block stays strictly per-conversation.
"""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agents.router import AgentRouter
from conversation_context import conversation_session_id, format_shared_memory
from persistent_memory import PersistentMemory


def conversation(user=1, chat=None, agent="kristina", channel="telegram"):
    return {"user_id": user, "chat_id": user if chat is None else chat,
            "channel": channel, "agent_id": agent}


def session_for(user=1, chat=None):
    return conversation_session_id(conversation(user, chat))


@pytest.fixture
def memory(tmp_path):
    db = PersistentMemory(str(tmp_path / "shared_memory.db"))
    yield db
    db.close()


@pytest.fixture
def persona_router(memory, monkeypatch):
    import agents.kristina_persona as persona

    monkeypatch.setattr(persona, "ai", SimpleNamespace(generate=AsyncMock(return_value="Принято.")))
    monkeypatch.setattr(persona, "asyncio", SimpleNamespace(sleep=AsyncMock()))
    from emotional_core import EmotionalCore
    from mood_engine import MoodEngine
    core = EmotionalCore(clock=lambda: datetime(2026, 11, 26, 10, tzinfo=timezone.utc))
    monkeypatch.setattr(persona, "mood_engine", MoodEngine(core))
    bridge = SimpleNamespace(process_signal=AsyncMock(return_value={}))
    monkeypatch.setattr(persona, "get_brain_bridge", lambda: bridge)
    agent = persona.KristinaPersonaAgent()
    agent.use_brain_integration = True
    router = AgentRouter(memory=memory)
    router.register_agent(agent, is_default=True)
    return router, persona.ai.generate


def history_section(prompt: str) -> str:
    return prompt[prompt.index("ИСТОРИЯ:"):prompt.index("КОНЕЦ ИСТОРИИ")]


# ─── PersistentMemory.get_shared_context ─────────────────────────

def test_shared_context_excludes_current_session(memory):
    memory.save_exchange(session_for(1), "Привет", "Здравствуй")
    memory.save_exchange(session_for(2), "Иван из Томска на связи", "Иван, добрый день")
    shared = memory.get_shared_context(session_for(1))
    contents = [m["content"] for m in shared["messages"]]
    assert "Иван из Томска на связи" in contents
    assert "Привет" not in contents
    assert "Здравствуй" not in contents


def test_shared_context_includes_interests_from_other_chats(memory):
    memory.save_exchange(session_for(2), "Иван из Томска на связи", "Иван, добрый день")
    memory._get_connection().execute(
        """INSERT INTO cognitive_interests
           (session_id, topic, reflection, source_quote, source_message_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (session_for(2), "Иван из Томска", "знакомство с братом",
         "Иван из Томска на связи", 1, "2026-11-25T16:30:00+00:00"),
    )
    memory._get_connection().commit()
    shared = memory.get_shared_context(session_for(1))
    assert shared["interests"][0]["topic"] == "Иван из Томска"


def test_shared_context_empty_without_other_conversations(memory):
    memory.save_exchange(session_for(1), "Привет", "Здравствуй")
    assert memory.get_shared_context(session_for(1)) == {"messages": [], "interests": []}


def test_shared_context_skips_legacy_unscoped_sessions(memory):
    memory.save_message("user_1", "user", "AMBIGUOUS-LEGACY-MARKER", channel="web")
    memory.save_exchange(session_for(2), "Иван на связи", "Добрый день")
    shared = memory.get_shared_context(session_for(1))
    contents = [m["content"] for m in shared["messages"]]
    assert "AMBIGUOUS-LEGACY-MARKER" not in contents
    assert "Иван на связи" in contents


def test_anonymous_callers_get_no_shared_memory(memory):
    memory.save_exchange(session_for(2), "Иван из Томска на связи", "Иван, добрый день")
    assert memory.get_shared_context(None) == {"messages": [], "interests": []}


def test_shared_context_keeps_intro_anchor_beyond_recent_window(memory):
    """Regression (2026-11-26): the name in the first message must survive a
    sliding recent window — newer chatter evicted «Иван из Томска на связи»
    and the contact was denied."""
    memory.save_exchange(session_for(2), "Иван из Томска на связи", "Иван, добрый день")
    for i in range(20):
        memory.save_exchange(session_for(2), f"еда-{i}", f"ответ-{i}")
    shared = memory.get_shared_context(session_for(1), message_limit=12)
    anchors = [m for m in shared["messages"] if m["anchor"]]
    assert any("Иван из Томска на связи" in m["content"] for m in anchors)
    assert len([m for m in shared["messages"] if not m["anchor"]]) == 12


# ─── format_shared_memory ────────────────────────────────────────

def test_format_shared_memory_keeps_newest_within_budget():
    shared = {"messages": [
        {"session_id": '["telegram","777","777"]', "role": "user",
         "content": "СТАРОЕ-" + "x" * 400, "timestamp": "2026-11-25T16:28:48"},
        {"session_id": '["telegram","777","777"]', "role": "assistant",
         "content": "НОВОЕ-сообщение", "timestamp": "2026-11-26T14:34:50"},
    ], "interests": []}
    text = format_shared_memory(shared, max_chars=120)
    assert "НОВОЕ-сообщение" in text
    assert "СТАРОЕ-" not in text
    assert "(чат 777)" in text


def test_format_shared_memory_labels_roles_and_interests():
    shared = {"messages": [
        {"session_id": '["telegram","777","777"]', "role": "user",
         "content": "Махачкала", "timestamp": "2026-11-26T05:09:06"},
        {"session_id": '["telegram","777","777"]', "role": "assistant",
         "content": "Каспий, рынок", "timestamp": "2026-11-26T12:31:50"},
    ], "interests": [
        {"session_id": '["telegram","777","777"]', "topic": "Дагестан",
         "reflection": "рынок — правда о городе", "updated_at": "2026-11-26T14:32:50"},
    ]}
    text = format_shared_memory(shared)
    assert "собеседник: Махачкала" in text
    assert "Кристина: Каспий, рынок" in text
    assert "(интерес, чат 777) Дагестан" in text


def test_format_shared_memory_empty():
    assert format_shared_memory(None) == ""
    assert format_shared_memory({"messages": [], "interests": []}) == ""


def test_format_shared_memory_pins_anchor_and_drops_old_recent():
    shared = {"messages": [
        {"session_id": '["telegram","777","777"]', "role": "user",
         "content": "Иван из Томска на связи", "timestamp": "2026-11-25T16:28:48",
         "anchor": True},
        {"session_id": '["telegram","777","777"]', "role": "user",
         "content": "СТАРОЕ-" + "x" * 400, "timestamp": "2026-11-25T19:50:03",
         "anchor": False},
        {"session_id": '["telegram","777","777"]', "role": "assistant",
         "content": "НОВОЕ-сообщение", "timestamp": "2026-11-26T14:34:50",
         "anchor": False},
    ], "interests": []}
    text = format_shared_memory(shared, max_chars=200)
    assert "Иван из Томска на связи" in text
    assert "начало переписки" in text
    assert "НОВОЕ-сообщение" in text
    assert "СТАРОЕ-" not in text


# ─── Prompt wiring (router → persona) ────────────────────────────

async def test_other_chat_enters_prompt_as_shared_block_not_history(persona_router):
    router, generate = persona_router
    await router.process("Иван из Томска на связи", conversation(2))
    await router.process("Как дела?", conversation(3))
    prompt = generate.call_args.kwargs["prompt"]
    assert "ОБЩАЯ ПАМЯТЬ (записанные" in prompt
    assert "Иван из Томска на связи" in prompt
    assert "Иван из Томска на связи" not in history_section(prompt)
    assert "верна ОБЩАЯ ПАМЯТЬ" in prompt


async def test_intro_anchor_reaches_prompt_even_after_newer_chatter(persona_router, memory):
    """The 2026-11-26 incident end-to-end: intro «Иван из Томска на связи»,
    then 20 newer food-talk messages, then «Как пообщалась с Иваном?» —
    the name must still be in the prompt."""
    router, generate = persona_router
    memory.save_exchange(session_for(2), "Иван из Томска на связи", "Иван, добрый день")
    for i in range(20):
        memory.save_exchange(session_for(2), f"еда-{i}", f"ответ-{i}")
    await router.process("Как пообщалась с Иваном?", conversation(3))
    prompt = generate.call_args.kwargs["prompt"]
    assert "Иван из Томска на связи" in prompt
    assert "начало переписки" in prompt


async def test_current_chat_history_stays_session_local(persona_router):
    router, generate = persona_router
    await router.process("ЛИЧНЫЙ-МАРКЕР", conversation(1))
    await router.process("Другая тема", conversation(2))
    prompt = generate.call_args.kwargs["prompt"]
    assert "ЛИЧНЫЙ-МАРКЕР" not in history_section(prompt)
    # under the shared-memory policy the marker is still known — as memory
    assert "ЛИЧНЫЙ-МАРКЕР" in prompt


async def test_single_chat_has_no_shared_block(persona_router):
    router, generate = persona_router
    await router.process("Привет", conversation(1))
    await router.process("Привет ещё раз", conversation(1))
    prompt = generate.call_args.kwargs["prompt"]
    assert "ОБЩАЯ ПАМЯТЬ (записанные" not in prompt


# ─── Proactive generation ────────────────────────────────────────

async def test_proactive_prompt_carries_shared_memory(monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot
    fake = SimpleNamespace(chat=AsyncMock(return_value="Привет от Кристины"))
    monkeypatch.setattr(bot, "ai", fake)
    await bot.generate_autonomous_message(
        "хочу пообщаться",
        {"mood_description": "спокойная", "state": {}},
        shared_memory="[2026-11-26T12:31] (чат 1326334555) собеседник: Махачкала",
    )
    prompt = fake.chat.call_args.args[0][1]["content"]
    assert "Память из других переписок" in prompt
    assert "Махачкала" in prompt


async def test_proactive_prompt_omits_empty_shared_memory(monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot
    fake = SimpleNamespace(chat=AsyncMock(return_value="Привет от Кристины"))
    monkeypatch.setattr(bot, "ai", fake)
    await bot.generate_autonomous_message(
        "хочу пообщаться",
        {"mood_description": "спокойная", "state": {}},
    )
    prompt = fake.chat.call_args.args[0][1]["content"]
    assert "Память из других переписок" not in prompt
