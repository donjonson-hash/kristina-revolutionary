"""Durable preferences, private-only eligibility and restart-safe proactive gates."""

from collections import defaultdict, deque
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import os
import sqlite3
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agents.router import AgentRouter
from cognitive_appraisal import Appraisal
from conversation_context import conversation_session_id
from dialogue_state import DialogueStore, proactive_block_reason
from emotional_core import EmotionalCore
from persistent_memory import PersistentMemory
from telegram_runtime import TelegramRuntimeStore


DAY = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)


def session(user=1, chat=None):
    return conversation_session_id({"channel": "telegram", "user_id": user,
                                    "chat_id": user if chat is None else chat})


def update(user=1, chat=None, data="agent_advisor"):
    chat = user if chat is None else chat
    return SimpleNamespace(
        effective_user=SimpleNamespace(id=user),
        effective_chat=SimpleNamespace(id=chat, type="private" if chat == user else "group"),
        message=SimpleNamespace(text="Привет", message_id=1, reply_text=AsyncMock(), reply_voice=AsyncMock()),
        callback_query=SimpleNamespace(data=data, answer=AsyncMock(), edit_message_text=AsyncMock()),
    )


@pytest.fixture
def runtime_bot(persistent_memory, monkeypatch, tmp_path):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot
    clock = SimpleNamespace(now=DAY)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.now.astimezone(tz) if tz else clock.now.replace(tzinfo=None)

    for name in ("active_agents", "user_tts_enabled", "last_user_activity",
                 "last_proactive", "next_proactive_opportunity", "user_context"):
        monkeypatch.setattr(bot, name, {})
    monkeypatch.setattr(bot, "active_chat_ids", set())
    monkeypatch.setattr(bot, "recent_proactive", defaultdict(lambda: deque(maxlen=6)))
    monkeypatch.setattr(bot, "datetime", Clock)
    monkeypatch.setattr(bot, "_autonomy_delay_seconds", lambda: 600)
    router = AgentRouter(memory=persistent_memory)
    router.process = AsyncMock(return_value=SimpleNamespace(content="Ответ."))
    monkeypatch.setattr(bot, "router", router)
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: clock.now)
    monkeypatch.setattr(bot, "emotional_core", core)
    monkeypatch.setattr(bot, "decision_engine", SimpleNamespace(decide=lambda *a, **k:
        SimpleNamespace(action="message", intention="share", score=1, reason="test")))
    generate = AsyncMock(return_value="Новая мысль о нашей задаче.")
    monkeypatch.setattr(bot, "generate_autonomous_message", generate)
    delivery = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
    return SimpleNamespace(bot=bot, memory=persistent_memory, store=TelegramRuntimeStore(persistent_memory),
                           core=core, clock=clock, generate=generate, delivery=delivery)


async def test_handlers_persist_private_chat_mode_and_tts_without_enrolling_groups(runtime_bot):
    b = runtime_bot
    await b.bot.start(update(1), None)
    await b.bot.tts_command(update(1), SimpleNamespace(args=["on"]))
    await b.bot.button_callback(update(1), None)
    await b.bot.button_callback(update(2, -100, "agent_creative"), None)
    await b.bot.tts_command(update(2, -100), SimpleNamespace(args=["on"]))
    await b.bot.handle_message(update(3, -200), None)
    b.bot.active_chat_ids.clear()
    b.bot.active_agents.clear()
    b.bot.user_tts_enabled.clear()
    b.bot.restore_telegram_runtime()
    assert b.bot.active_chat_ids == {1}
    assert b.bot.active_agents == {session(1): "advisor", session(2, -100): "creative"}
    assert b.bot.user_tts_enabled == {1: True, 2: True}
    assert b.bot.next_proactive_opportunity[1] > DAY
    # /start is not a reset of restored preferences.
    await b.bot.start(update(1), None)
    assert b.bot.active_agents[session(1)] == "advisor"
    assert b.bot.user_tts_enabled[1] is True


async def test_restored_preferences_are_used_by_new_messages(runtime_bot, monkeypatch):
    b = runtime_bot
    b.store.set_agent(1, 1, "advisor")
    b.store.set_agent(1, -100, "creative")
    b.store.set_tts(1, True)
    b.bot.restore_telegram_runtime()
    synthesize = MagicMock(return_value=None)
    monkeypatch.setattr(b.bot, "tts", SimpleNamespace(synthesize=synthesize))
    await b.bot.handle_message(update(1), None)
    assert b.bot.router.process.call_args.kwargs["context"]["agent_id"] == "advisor"
    synthesize.assert_called_once_with("Ответ.")
    await b.bot.handle_message(update(1, -100), None)
    assert b.bot.router.process.call_args.kwargs["context"]["agent_id"] == "creative"
    assert b.bot.active_chat_ids == {1}


def test_history_and_preferences_alone_never_grant_dm_eligibility(persistent_memory):
    m = persistent_memory
    for key in (session(10), session(20, -100), "user_30"):
        m.save_message(key, "user", "HISTORICAL", channel="telegram")
    store = TelegramRuntimeStore(m)
    store.set_tts(20, True)
    store.set_agent(20, -100, "advisor")
    store.schedule_private(30, DAY + timedelta(hours=1))
    saved = store.restore(DAY, lambda: 600)
    assert saved["chats"] == []
    assert m.get_stats()["total_messages"] == 3


def test_restart_defers_overdue_and_keeps_later_schedule(persistent_memory):
    store = TelegramRuntimeStore(persistent_memory)
    store.touch_private(1, DAY - timedelta(hours=3), DAY - timedelta(hours=2))
    store.touch_private(2, DAY - timedelta(hours=1), DAY + timedelta(hours=2))
    saved = store.restore(DAY, lambda: 600)
    by_id = {row["chat_id"]: row for row in saved["chats"]}
    assert by_id[1]["next_opportunity_at"] == DAY + timedelta(minutes=10)
    assert by_id[1]["last_user_at"] == DAY - timedelta(hours=3)
    assert by_id[2]["next_opportunity_at"] == DAY + timedelta(hours=2)
    with closing(PersistentMemory(persistent_memory.db_path)) as reopened:
        restored = TelegramRuntimeStore(reopened).restore(DAY, lambda: 600)
        assert restored == saved


async def test_startup_sends_nothing_but_eligible_chat_resumes_after_delay(runtime_bot):
    b = runtime_bot
    b.bot.mark_user_active(1)
    b.memory.save_exchange(session(), "Продолжим.", "Хорошо.", now=DAY)
    emotion_before = b.core.get_emotional_state()
    b.bot.restore_telegram_runtime()
    assert b.core.get_emotional_state() == emotion_before
    await b.bot.autonomous_proactive_tick(b.delivery)
    b.generate.assert_not_awaited()
    b.delivery.bot.send_message.assert_not_awaited()
    b.clock.now = DAY + timedelta(minutes=10)
    await b.bot.autonomous_proactive_tick(b.delivery)
    b.delivery.bot.send_message.assert_awaited_once()
    assert b.delivery.bot.send_message.call_args.kwargs["chat_id"] == 1
    assert DialogueStore(b.memory).get(session())["proactive_since_user"] == 1
    saved = b.store.restore(b.clock.now, lambda: 600)
    assert saved["chats"][0]["next_opportunity_at"] > b.clock.now


@pytest.mark.parametrize("gate", ["pause", "question", "cooldown", "sending"])
async def test_restart_preserves_pause_question_cooldown_and_uncertain_send(runtime_bot, gate):
    b = runtime_bot
    b.bot.mark_user_active(1)
    ds = DialogueStore(b.memory)
    if gate == "pause":
        appraisal = Appraisal("neutral", 0, "", "keep", "", "", dialogue={
            "scene_action": "keep", "scene_label": "", "scene_quote": "",
            "contact_action": "pause", "contact_quote": "Дай отдохнуть",
            "answer_to": None, "answer_quote": "",
        })
        b.memory.save_exchange(session(), "Дай отдохнуть", "Хорошо.", appraisal=appraisal, now=DAY)
    else:
        then = DAY - timedelta(hours=1) if gate == "cooldown" else DAY
        b.memory.save_exchange(session(), "Привет", "Как дела?" if gate == "question" else "Привет.", now=then)
        if gate in ("cooldown", "sending"):
            claim = ds.claim_proactive(session(), now=then)
            assert claim and ds.mark_sending(claim, now=then)
            if gate == "cooldown":
                assert ds.finish_proactive(claim, "Мысль.", now=then)
                b.memory.save_exchange(session(), "Продолжим", "Хорошо.", now=then + timedelta(minutes=1))
    before = ds.get(session())
    assert proactive_block_reason(before, DAY)
    b.bot.restore_telegram_runtime()
    assert ds.get(session()) == before
    b.clock.now = DAY + timedelta(minutes=11)
    await b.bot.autonomous_proactive_tick(b.delivery)
    b.generate.assert_not_awaited()
    b.delivery.bot.send_message.assert_not_awaited()
    assert ds.get(session()) == before
    if gate == "pause":
        b.clock.now = DAY + timedelta(hours=8, minutes=1)
        await b.bot.autonomous_proactive_tick(b.delivery)
        b.delivery.bot.send_message.assert_awaited_once()


async def test_failed_preference_write_never_updates_cache_or_acknowledges(runtime_bot):
    b = runtime_bot
    with b.memory._get_connection() as conn:
        conn.execute("""CREATE TRIGGER reject_tts BEFORE INSERT ON telegram_user_preferences
            BEGIN SELECT RAISE(ABORT, 'rejected'); END""")
    event = update()
    with pytest.raises(sqlite3.IntegrityError):
        await b.bot.tts_command(event, SimpleNamespace(args=["on"]))
    assert b.bot.user_tts_enabled == {}
    event.message.reply_text.assert_not_awaited()


def test_failed_private_registration_does_not_enable_proactivity(runtime_bot):
    b = runtime_bot
    with b.memory._get_connection() as conn:
        conn.execute("""CREATE TRIGGER reject_chat BEFORE INSERT ON telegram_private_chats
            BEGIN SELECT RAISE(ABORT, 'rejected'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        b.bot.mark_user_active(1)
    assert b.bot.active_chat_ids == set()
    assert b.bot.next_proactive_opportunity == {}


def test_restore_failure_rolls_back_schedules_and_does_not_publish_partial_cache(runtime_bot):
    b = runtime_bot
    for user in (1, 2):
        b.store.touch_private(user, DAY - timedelta(hours=2), DAY - timedelta(hours=1))
    conn = b.memory._get_connection()
    before = list(conn.execute("SELECT * FROM telegram_private_chats ORDER BY chat_id"))
    with conn:
        conn.execute("""CREATE TRIGGER reject_restore BEFORE UPDATE ON telegram_private_chats
            WHEN NEW.chat_id=2 BEGIN SELECT RAISE(ABORT, 'rejected'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        b.bot.restore_telegram_runtime()
    assert list(conn.execute("SELECT * FROM telegram_private_chats ORDER BY chat_id")) == before
    assert b.bot.active_chat_ids == set()


def test_main_restores_before_registering_jobs_or_polling(runtime_bot, monkeypatch):
    b = runtime_bot
    b.store.touch_private(1, DAY, DAY + timedelta(minutes=1))
    app = MagicMock()
    builder = MagicMock()
    builder.token.return_value.build.return_value = app
    monkeypatch.setattr(b.bot, "Application", SimpleNamespace(builder=lambda: builder))
    monkeypatch.setattr(b.bot, "init_agents", lambda: None)
    checked = []

    def jobs(application):
        assert application is app and b.bot.active_chat_ids == {1}
        assert b.bot.next_proactive_opportunity[1] > DAY
        app.run_polling.assert_not_called()
        checked.append(True)

    monkeypatch.setattr(b.bot, "setup_proactive_messaging", jobs)
    monkeypatch.setattr(b.bot, "setup_weekly_trends", jobs)
    b.bot.main()
    assert checked == [True, True]
    app.run_polling.assert_called_once()


def test_invalid_id_or_settings_do_not_create_recipients(persistent_memory):
    store = TelegramRuntimeStore(persistent_memory)
    for bad in (-100, 0, True, "1"):
        with pytest.raises(ValueError):
            store.touch_private(bad, DAY, DAY + timedelta(minutes=1))
    with pytest.raises(ValueError):
        store.set_agent(1, 1, "unknown")
    with pytest.raises(ValueError):
        store.set_tts(1, "true")
    assert store.restore(DAY, lambda: 600)["chats"] == []


def test_clear_history_does_not_resurrect_text_or_reset_preferences(runtime_bot):
    b = runtime_bot
    b.store.set_agent(1, 1, "advisor")
    b.store.set_tts(1, True)
    b.bot.mark_user_active(1)
    b.memory.save_exchange(session(), "PRIVATE-MARKER", "Ответ.", now=DAY)
    b.memory.clear_user(session())
    b.bot.restore_telegram_runtime()
    assert b.memory.get_context_for_llm(session()) == []
    assert b.bot.active_agents[session()] == "advisor"
    assert b.bot.user_tts_enabled[1] is True


def test_restart_in_two_real_processes_restores_memory_emotions_and_runtime(tmp_path):
    root = Path(__file__).resolve().parents[1]
    env = {
        "PATH": os.environ["PATH"], "HOME": str(tmp_path), "PYTHONPATH": str(root),
        "PYTHON_DOTENV_DISABLED": "1", "DEEPSEEK_API_KEY": "test-key-not-real",
        "KRISTINA_TELEGRAM_TOKEN": "12345:test-not-a-real-token",
        "KRISTINA_STATE_DB": str(tmp_path / "state.db"),
    }
    probe = Path(__file__).with_name("telegram_restart_probe.py")
    results = []
    for mode in ("write", "read"):
        result = subprocess.run([sys.executable, str(probe), mode], cwd=tmp_path,
                                env=env, capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stdout + result.stderr
        results.append(json.loads(next(line.removeprefix("PROBE_JSON=") for line in result.stdout.splitlines()
                                       if line.startswith("PROBE_JSON="))))
    before, after = results
    assert before["pid"] != after["pid"]
    for key in ("history", "emotions", "agents", "tts", "active_chats"):
        assert before[key] == after[key], key
    assert after["active_chats"] == [42]
    assert after["tts"] == {"42": True}
    assert after["all_due_future"] is True
    assert after["generated"] == after["sent"] == 0
