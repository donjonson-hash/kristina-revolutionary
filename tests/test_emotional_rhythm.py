"""Persistence and real Persona response assembly, without LLM calls or real waits."""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from emotional_core import EmotionalCore
from mood_engine import MoodEngine, MoodState


DAY = datetime(2026, 9, 5, 10, tzinfo=timezone.utc)


def test_restart_keeps_state_traits_and_event_without_message_text(tmp_path):
    path = tmp_path / "state.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    before = core.evolve({"user_message": "PRIVATE-TEXT", "negative_tone": True})
    restarted = EmotionalCore(path, clock=lambda: DAY)
    assert restarted.get_emotional_state() == before
    with sqlite3.connect(path) as conn:
        payload = conn.execute("SELECT payload FROM emotional_state").fetchone()[0]
    assert "PRIVATE-TEXT" not in payload
    assert before["recent_experiences"][-1] == {"event": "negative_tone", "at": DAY.isoformat()}


def test_downtime_and_live_ticks_have_the_same_effect(tmp_path):
    now = DAY
    path = tmp_path / "state.db"
    persisted = EmotionalCore(path, clock=lambda: now)
    live = EmotionalCore(clock=lambda: now)
    for core in (persisted, live):
        core.evolve({"user_message": True, "negative_tone": True})
    for _ in range(48 * 60):
        now += timedelta(minutes=1)
        live.evolve()
    restarted = EmotionalCore(path, clock=lambda: now)
    assert restarted.state == pytest.approx(live.state, abs=1e-12)
    assert restarted.last_update == now
    assert restarted.recent_experiences == live.recent_experiences


def test_independent_writers_do_not_lose_events(tmp_path):
    path = tmp_path / "state.db"
    writers = [EmotionalCore(path, clock=lambda: DAY) for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda core: core.evolve({"user_message": True}), writers))
    reopened = EmotionalCore(path, clock=lambda: DAY)
    assert reopened.state["energy"] == pytest.approx(0.7 - 4 * 0.025)
    assert len(reopened.recent_experiences) == 4


def test_failed_write_rolls_back_disk_and_live_state(tmp_path):
    path = tmp_path / "state.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    before = core.get_emotional_state()
    with sqlite3.connect(path) as conn:
        conn.execute("""CREATE TRIGGER reject_state BEFORE INSERT ON emotional_state
            BEGIN SELECT RAISE(ABORT, 'write rejected'); END""")
        saved = conn.execute("SELECT payload FROM emotional_state").fetchone()[0]
    with pytest.raises(sqlite3.IntegrityError, match="write rejected"):
        core.evolve({"negative_tone": True})
    assert core.get_emotional_state() == before
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT payload FROM emotional_state").fetchone()[0] == saved


@pytest.mark.parametrize("damage", ["invalid json", "unsupported version", "nan", "bad events"])
def test_corrupt_state_is_not_silently_reset(tmp_path, damage):
    path = tmp_path / "state.db"
    EmotionalCore(path, clock=lambda: DAY)
    with sqlite3.connect(path) as conn:
        payload = json.loads(conn.execute("SELECT payload FROM emotional_state").fetchone()[0])
        if damage == "unsupported version":
            payload["version"] = 999
        elif damage == "nan":
            payload["state"]["energy"] = float("nan")
        elif damage == "bad events":
            payload["recent_experiences"] = ["invalid"]
        raw = "{" if damage == "invalid json" else json.dumps(payload)
        conn.execute("UPDATE emotional_state SET payload = ?", (raw,))
    with pytest.raises(ValueError):
        EmotionalCore(path, clock=lambda: DAY)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT payload FROM emotional_state").fetchone()[0] == raw


@pytest.mark.parametrize("utc_hour, night", [(20, False), (21, True), (5, True), (6, False)])
def test_stockholm_night_boundaries(utc_hour, night):
    core = EmotionalCore(clock=lambda: DAY.replace(hour=utc_hour))
    assert core.get_emotional_state()["is_night"] is night


def test_mood_change_event_has_distinct_old_and_new_values(monkeypatch):
    import mood_engine as module
    publish = []
    monkeypatch.setattr(module.event_bus, "publish", lambda event, data: publish.append(data))
    core = EmotionalCore(clock=lambda: DAY)
    mood = MoodEngine(core)
    assert mood.current_mood == MoodState.CURIOUS
    for _ in range(15):
        mood.update()
    assert mood.current_mood == MoodState.TIRED
    assert [(e["old_mood"], e["new_mood"]) for e in publish] == [
        ("любопытная", "спокойная"), ("спокойная", "усталая"),
    ]


def test_restarted_character_keeps_response_rhythm(tmp_path):
    path = tmp_path / "state.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    for _ in range(15):
        core.evolve({"user_message": True})
    restarted = MoodEngine(EmotionalCore(path, clock=lambda: DAY))
    assert restarted.current_mood == MoodState.TIRED
    assert 45 <= restarted.get_delay() <= 90
    assert "устала" in restarted.get_mood_prompt()


@pytest.mark.parametrize("energy,hour,mood,delay_range", [
    (0.8, 10, "любопытная", (15, 30)),
    (0.5, 10, "спокойная", (30, 60)),
    (0.3, 10, "усталая", (45, 90)),
    (0.8, 22, "усталая", (60, 120)),
])
async def test_persona_uses_one_snapshot_for_prompt_pause_and_metadata(
        monkeypatch, energy, hour, mood, delay_range):
    import agents.kristina_persona as module
    core = EmotionalCore(clock=lambda: DAY.replace(hour=hour))
    core.state["energy"] = energy
    monkeypatch.setattr(module, "mood_engine", MoodEngine(core))
    generate = AsyncMock(return_value="Принято.")
    sleep = AsyncMock()
    monkeypatch.setattr(module, "ai", SimpleNamespace(generate=generate))
    monkeypatch.setattr(module, "asyncio", SimpleNamespace(sleep=sleep))
    # A competing update during the wait must not mutate the response snapshot.
    async def during_pause(_):
        core.evolve({"negative_tone": True})
    sleep.side_effect = during_pause
    agent = module.KristinaPersonaAgent()
    agent.use_brain_integration = False
    response = await agent.process("Продолжим?", {"history": []})
    sleep.assert_awaited_once()
    delay = sleep.call_args.args[0]
    assert delay_range[0] <= delay <= delay_range[1]
    generate.assert_awaited_once()
    snapshot = response.context_used["emotional_state"]
    assert snapshot["state"]["energy"] == pytest.approx(energy - 0.025)
    assert snapshot["state"]["irritation"] == 0.1
    assert core.state["irritation"] == pytest.approx(0.3)
    assert response.context_used["delay"] == delay
    assert response.emotion == mood
    prompt = generate.call_args.kwargs["prompt"]
    assert f"Текущее настроение: {mood}." in prompt
    assert json.dumps(snapshot["state"], ensure_ascii=False) in prompt
    assert "Продолжим?" in prompt
    # Night requests still receive contextual generation, never a random canned refusal.
    assert response.content == "Принято."
