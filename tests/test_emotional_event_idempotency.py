"""At-most-once message impulses across retries, competing writers and process death."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import importlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agents.router import AgentRouter
from brain_integration import BrainBridge
from cognitive_appraisal import Appraisal
from emotional_core import EmotionalCore, EmotionalEvent
from mood_engine import MoodEngine
from persistent_memory import PersistentMemory


DAY = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)
TEXT = "Спасибо за тепло. PRIVATE-TEXT"
APPRAISAL = Appraisal("warmth", 0.5, "тепло", "keep", "", "")
CONTEXT = {"user_message": True, "appraisal": APPRAISAL}


def event(session="private-session", identifier="telegram:1", text=TEXT):
    return EmotionalEvent.from_message(session, identifier, text)


def receipts(path):
    with sqlite3.connect(path) as conn:
        return conn.execute("SELECT * FROM emotional_message_events").fetchall()


@pytest.mark.parametrize("persistent", [False, True])
def test_same_event_applies_once_and_new_event_applies_again(tmp_path, persistent):
    path = tmp_path / "emotion.db" if persistent else None
    core = EmotionalCore(path, clock=lambda: DAY)
    first = core.evolve(CONTEXT, event=event())
    if persistent:
        core = EmotionalCore(path, clock=lambda: DAY)
    assert core.evolve(CONTEXT, event=event()) == first
    assert core.state["energy"] == pytest.approx(0.675)
    assert core.state["happiness"] == pytest.approx(0.63)
    core.evolve(CONTEXT, event=event(identifier="telegram:2"))
    assert core.state["energy"] == pytest.approx(0.65)
    assert sum(item["event"] == "user_message" for item in core.recent_experiences) == 2
    if persistent:
        assert len(receipts(path)) == 2


def test_receipts_store_hashes_not_text_or_raw_session(tmp_path):
    path = tmp_path / "emotion.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    core.evolve(CONTEXT, event=event())
    saved = json.dumps(receipts(path))
    assert TEXT not in saved and "PRIVATE-TEXT" not in saved
    assert "private-session" not in saved
    assert len(receipts(path)[0][0]) == 64


def test_additive_migration_keeps_legacy_state_and_experiment_receipts(tmp_path):
    path = tmp_path / "emotion.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    core.evolve({"user_message": True})
    assert core.record_experiment("a" * 32, "counterexample_found") is True
    before = core.get_emotional_state()
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE emotional_message_events")
    restarted = EmotionalCore(path, clock=lambda: DAY)
    assert restarted.get_emotional_state() == before
    assert restarted.record_experiment("a" * 32, "counterexample_found") is False
    assert receipts(path) == []  # Do not guess receipts for old, unstamped reactions.
    restarted.evolve(CONTEXT, event=event())
    assert len(receipts(path)) == 1


def test_conflicting_payload_is_rejected_without_state_or_receipt_changes(tmp_path):
    path = tmp_path / "emotion.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    before = core.evolve(CONTEXT, event=event())
    rows = receipts(path)
    with pytest.raises(ValueError, match="different input"):
        core.evolve(CONTEXT, event=event(text="Different message"))
    assert core.get_emotional_state() == before
    assert receipts(path) == rows
    assert EmotionalCore(path, clock=lambda: DAY).get_emotional_state() == before


def test_equal_transport_ids_are_scoped_to_session(tmp_path):
    path = tmp_path / "emotion.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    for own in ("telegram-private-one", "telegram-group-one", "telegram-private-two"):
        core.evolve(CONTEXT, event=event(session=own))
    assert core.state["energy"] == pytest.approx(0.625)
    assert len(receipts(path)) == 3


@pytest.mark.parametrize("same_id", [True, False])
def test_independent_sqlite_writers_cannot_double_apply_one_event(tmp_path, same_id):
    path = tmp_path / "emotion.db"
    cores = [EmotionalCore(path, clock=lambda: DAY) for _ in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: cores[i].evolve(
            CONTEXT, event=event(identifier="same" if same_id else f"event-{i}")), range(8)))
    restarted = EmotionalCore(path, clock=lambda: DAY)
    count = 1 if same_id else 8
    assert restarted.state["energy"] == pytest.approx(0.7 - 0.025 * count)
    assert len(receipts(path)) == count


@pytest.mark.parametrize("table", ["emotional_state", "emotional_message_events"])
def test_failed_write_rolls_back_both_impulse_and_receipt_then_retry_succeeds(tmp_path, table):
    path = tmp_path / "emotion.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    before = core.get_emotional_state()
    with sqlite3.connect(path) as conn:
        conn.execute(f"""CREATE TRIGGER reject_write BEFORE INSERT ON {table}
            BEGIN SELECT RAISE(ABORT, 'rejected'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        core.evolve(CONTEXT, event=event())
    assert core.get_emotional_state() == before
    assert receipts(path) == []
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER reject_write")
    after = core.evolve(CONTEXT, event=event())
    assert after["state"]["energy"] == pytest.approx(0.675)
    assert len(receipts(path)) == 1


def test_replay_advances_time_but_never_reinterprets_committed_impulse(tmp_path):
    path = tmp_path / "emotion.db"
    now = [DAY]
    core = EmotionalCore(path, clock=lambda: now[0])
    reference = EmotionalCore(clock=lambda: now[0])
    core.evolve(CONTEXT, event=event())
    reference.evolve(CONTEXT)
    now[0] += timedelta(hours=12)
    expected = reference.evolve()
    restarted = EmotionalCore(path, clock=lambda: now[0])
    # A retry's different appraisal cannot replace or compound the first reaction.
    other = Appraisal("frustration", 1, "тепло", "keep", "", "")
    actual = restarted.evolve({"user_message": True, "appraisal": other}, event=event())
    assert actual == expected
    assert len(receipts(path)) == 1


def test_shadow_observer_only_sees_first_committed_impulse(tmp_path):
    from experiments.appraisal_observer import AppraisalSource
    observer = SimpleNamespace(observe=MagicMock())
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: DAY, appraisal_observer=observer)
    source = AppraisalSource.from_validated(APPRAISAL, user_input=TEXT,
                                           session_id="private-session", event_id="telegram:1")
    for _ in range(2):
        core.evolve(CONTEXT, observation=source, event=event())
    observer.observe.assert_called_once()


def test_unstamped_calls_keep_legacy_behavior_and_bad_stamps_fail_closed(tmp_path):
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: DAY)
    assert EmotionalEvent.from_message(None, "id", TEXT) is None
    assert EmotionalEvent.from_message("session", None, TEXT) is None
    for _ in range(2):
        core.evolve(CONTEXT)
    assert core.state["energy"] == pytest.approx(0.65)
    assert receipts(core.db_path) == []
    for bad in ("", [], "x" * 241):
        with pytest.raises(ValueError):
            event(identifier=bad)
    with pytest.raises(ValueError):
        EmotionalEvent("not-a-hash", "id", "not-a-hash")
    with pytest.raises(ValueError):
        core.evolve({}, event=event())
    with pytest.raises(ValueError):
        core.evolve(CONTEXT, event={})


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    import agents.kristina_persona as persona
    import cognitive_appraisal
    router_module = importlib.import_module("agents.router")

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return DAY.astimezone(tz) if tz else DAY.replace(tzinfo=None)

    monkeypatch.setattr(router_module, "datetime", Clock)
    memory = PersistentMemory(str(tmp_path / "memory.db"))
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: DAY)
    p = SimpleNamespace(memory=memory, core=core, bridge=BrainBridge(memory=memory, emotional=core))
    p.assess = AsyncMock(return_value=APPRAISAL)
    p.generate = AsyncMock(return_value="Рада нашему разговору.")
    monkeypatch.setattr(cognitive_appraisal, "assess_event", p.assess)
    monkeypatch.setattr(persona, "get_brain_bridge", lambda: p.bridge)
    monkeypatch.setattr(persona, "mood_engine", MoodEngine(core))
    monkeypatch.setattr(persona, "asyncio", SimpleNamespace(sleep=AsyncMock()))
    monkeypatch.setattr(persona, "ai", SimpleNamespace(generate=p.generate))
    p.persona = persona
    p.router = AgentRouter(memory=memory)
    p.router.register_agent(persona.KristinaPersonaAgent(), is_default=True)
    p.context = {"channel": "telegram", "user_id": 1, "chat_id": 1,
                 "agent_id": "kristina", "event_id": "telegram:1"}
    yield p
    p.memory.close()


async def test_dialogue_commit_failure_then_fresh_router_retries_without_second_reaction(pipeline, monkeypatch):
    p = pipeline
    conn = p.memory._get_connection()
    with conn:
        conn.execute("""CREATE TRIGGER reject_reply BEFORE INSERT ON messages
            WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'rejected'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        await p.router.process(TEXT, p.context)
    first = p.core.get_emotional_state()
    assert p.memory.get_stats()["total_messages"] == 0
    with conn:
        conn.execute("DROP TRIGGER reject_reply")
    path, emotion_path = p.memory.db_path, p.core.db_path
    p.memory.close()
    p.memory = PersistentMemory(path)
    p.core = EmotionalCore(emotion_path, clock=lambda: DAY)
    p.bridge = BrainBridge(memory=p.memory, emotional=p.core)
    monkeypatch.setattr(p.persona, "mood_engine", MoodEngine(p.core))
    p.router = AgentRouter(memory=p.memory)
    p.router.register_agent(p.persona.KristinaPersonaAgent(), is_default=True)
    await p.router.process(TEXT, p.context)
    assert p.core.get_emotional_state() == first
    assert p.memory.get_stats()["total_messages"] == 2
    assert len(receipts(emotion_path)) == 1
    assert p.assess.await_count == 2  # Model retries are not an exactly-once promise.
    await p.router.process(TEXT, p.context)
    assert p.assess.await_count == 2
    assert p.core.get_emotional_state() == first


async def test_persona_fallback_after_bridge_commit_cannot_apply_second_message(pipeline, monkeypatch):
    p = pipeline
    original = p.bridge.process_signal

    async def fail_after_commit(*args, **kwargs):
        await original(*args, **kwargs)
        raise RuntimeError("failure after reaction")

    monkeypatch.setattr(p.bridge, "process_signal", fail_after_commit)
    await p.router.process(TEXT, {**p.context, "emotion_event": "forged"})
    assert p.core.state["energy"] == pytest.approx(0.675)
    assert p.core.state["happiness"] == pytest.approx(0.63)
    assert len(receipts(p.core.db_path)) == 1


async def test_conflict_before_dialogue_receipt_cannot_bypass_guard_via_fallback(pipeline, monkeypatch):
    p = pipeline
    save = p.memory.save_exchange
    monkeypatch.setattr(p.memory, "save_exchange", MagicMock(side_effect=RuntimeError("interrupted")))
    with pytest.raises(RuntimeError):
        await p.router.process(TEXT, p.context)
    before = p.core.get_emotional_state()
    monkeypatch.setattr(p.memory, "save_exchange", save)
    p.generate.reset_mock()
    with pytest.raises(ValueError, match="different input"):
        await p.router.process("Иное тепло.", p.context)
    assert p.core.get_emotional_state() == before
    assert p.memory.get_stats()["total_messages"] == 0
    p.generate.assert_not_awaited()


def test_process_dies_after_emotion_commit_and_resumes_same_telegram_event_once(tmp_path):
    root = Path(__file__).resolve().parents[1]
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "PYTHONPATH": str(root),
           "PYTHON_DOTENV_DISABLED": "1", "DEEPSEEK_API_KEY": "test-key-not-real",
           "KRISTINA_TELEGRAM_TOKEN": "12345:test-not-a-real-token",
           "KRISTINA_STATE_DB": str(tmp_path / "emotion.db")}
    probe = Path(__file__).with_name("emotional_event_crash_probe.py")

    def run(mode, code=0):
        result = subprocess.run([sys.executable, str(probe), mode], cwd=tmp_path,
                                env=env, capture_output=True, text=True, timeout=20)
        assert result.returncode == code, result.stdout + result.stderr
        if code == 0:
            return json.loads(next(line.removeprefix("PROBE_JSON=") for line in result.stdout.splitlines()
                                   if line.startswith("PROBE_JSON=")))

    run("crash", 72)
    before = run("inspect")
    assert before["messages"] == 0 and before["receipts"] == 1
    assert before["state"]["energy"] == pytest.approx(0.675)
    after = run("resume")
    assert after["pid"] != before["pid"]
    assert after["state"] == before["state"]
    assert after["messages"] == 2 and after["receipts"] == 1
    assert after["user_events"] == 1
    replay = run("resume")
    assert replay["messages"] == 2 and replay["receipts"] == 1
    assert replay["model_calls"] == 0
