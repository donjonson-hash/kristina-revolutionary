"""An interest must remain scoped, source-linked, atomic and revisable."""

import json
import sqlite3
from dataclasses import asdict, replace

import pytest

from cognitive_appraisal import Appraisal
from persistent_memory import PersistentMemory


SOURCE = "Хочу сменить обстановку в октябре."
INTEREST = Appraisal("curiosity", 0.5, "сменить обстановку", "replace",
                    "Перемены", "Мне интересно подумать о собственном отдыхе.")


def test_interest_survives_restart_with_real_user_source(persistent_memory):
    memory = persistent_memory
    memory.save_exchange("private", SOURCE, "Заманчиво.", appraisal=INTEREST)
    interest = memory.get_interest("private")
    assert interest["source_kind"] == "user_report"
    with sqlite3.connect(memory.db_path) as conn:
        row = conn.execute("SELECT role, content FROM messages WHERE id = ?",
                           (interest["source_message_id"],)).fetchone()
    assert row == ("user", SOURCE)
    memory.close()
    reopened = PersistentMemory(memory.db_path)
    try:
        assert reopened.get_interest("private") == interest
        assert reopened.get_interest("group") is None
    finally:
        reopened.close()


def test_repeated_or_invalid_appraisal_does_not_replace_interest(persistent_memory):
    memory = persistent_memory
    memory.save_exchange("chat", SOURCE, "Да.", appraisal=INTEREST)
    before = memory.get_interest("chat")
    keep = Appraisal("neutral", 0, "", "keep", "", "")
    memory.save_exchange("chat", "Угу", "Хорошо.", appraisal=keep)
    assert memory.get_interest("chat") == before
    with pytest.raises(ValueError):
        memory.save_exchange("chat", "Вот ссылка", "Значит, оплачено.",
                             appraisal=replace(INTEREST, source_quote="Я оплатил"))
    assert memory.get_interest("chat") == before
    assert len(memory.get_recent_messages("chat")) == 4


def test_interest_can_develop_and_be_closed(persistent_memory):
    memory = persistent_memory
    memory.save_exchange("chat", SOURCE, "Да.", appraisal=INTEREST)
    developed = replace(INTEREST, source_quote="Купил билет", reflection="Пора обдумать свой отпуск.")
    memory.save_exchange("chat", "Купил билет", "Поняла.", appraisal=developed)
    assert memory.get_interest("chat")["reflection"] == developed.reflection
    clear = Appraisal("neutral", 0, "Не хочу обсуждать", "clear", "", "")
    memory.save_exchange("chat", "Не хочу обсуждать поездку", "Хорошо.", appraisal=clear)
    assert memory.get_interest("chat") is None


def test_reply_and_interest_roll_back_together(persistent_memory):
    memory = persistent_memory
    conn = memory._get_connection()
    conn.execute("""CREATE TRIGGER reject_interest BEFORE INSERT ON cognitive_interests
        BEGIN SELECT RAISE(ABORT, 'interest failure'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        memory.save_exchange("chat", SOURCE, "Ответ", appraisal=INTEREST)
    assert memory.get_interest("chat") is None
    assert memory.get_recent_messages("chat") == []


def test_clear_deletes_only_own_interest_and_source(persistent_memory):
    memory = persistent_memory
    for session in ("private", "group", "other_user"):
        memory.save_exchange(session, SOURCE, "Да.", appraisal=INTEREST)
    memory.clear_user("private")
    assert memory.get_interest("private") is None
    assert memory.get_recent_messages("private") == []
    for session in ("group", "other_user"):
        assert memory.get_interest(session)
        assert memory.get_recent_messages(session)


def test_v1_emotional_snapshot_migrates_without_losing_state(tmp_path):
    from datetime import datetime, timezone
    from emotional_core import EmotionalCore
    now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
    path = tmp_path / "state.db"
    core = EmotionalCore(path, clock=lambda: now)
    original = core.evolve({"user_message": True})
    with sqlite3.connect(path) as conn:
        payload = json.loads(conn.execute("SELECT payload FROM emotional_state").fetchone()[0])
        payload["version"] = 1
        conn.execute("UPDATE emotional_state SET payload = ?", (json.dumps(payload),))
    reopened = EmotionalCore(path, clock=lambda: now)
    assert reopened.get_emotional_state() == original
    reopened.evolve({"appraisal": INTEREST})
    restarted = EmotionalCore(path, clock=lambda: now)
    assert restarted.get_emotional_state() == reopened.get_emotional_state()
    assert restarted.recent_experiences[-1]["event"] == "appraisal_curiosity"
    with sqlite3.connect(path) as conn:
        assert json.loads(conn.execute("SELECT payload FROM emotional_state").fetchone()[0])["version"] == 2
