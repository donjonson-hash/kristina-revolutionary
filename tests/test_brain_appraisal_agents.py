"""Brain agents share persistent emotion and keep assessment separate from speech."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from brain_unified import CortexAgent, EmotionalAgent
from cognitive_appraisal import Appraisal
from emotional_core import EmotionalCore


DAY = datetime(2026, 9, 12, 10, tzinfo=timezone.utc)


def curious_appraisal():
    return Appraisal(
        reaction="curiosity", intensity=0.5, source_quote="Хочу сменить обстановку",
        interest_action="replace", topic="Перемены",
        reflection="Хочу подумать о смене обстановки.",
    )


async def test_cortex_appraises_once_without_changing_legacy_signal_processing(monkeypatch):
    import cognitive_appraisal

    appraisal = curious_appraisal()
    assess = AsyncMock(return_value=appraisal)
    monkeypatch.setattr(cognitive_appraisal, "assess_event", assess)
    cortex = CortexAgent()
    history = [{"role": "user", "content": "Обдумываю отпуск"}]
    interest = {"topic": "Отдых"}
    result = await cortex.appraise("Хочу сменить обстановку", history, interest, now=DAY)
    assert result is appraisal
    assess.assert_awaited_once_with("Хочу сменить обстановку", history, interest, now=DAY)
    await cortex.process(None)
    assert assess.await_count == 1


def test_reaction_applies_one_message_event_to_shared_state(tmp_path):
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: DAY)
    agent = EmotionalAgent(core)
    snapshot = agent.react()
    assert snapshot["state"]["energy"] == pytest.approx(0.675)
    assert snapshot["state"]["curiosity"] == pytest.approx(0.815)
    assert snapshot["state"]["loneliness"] == pytest.approx(0.36)
    assert [e["event"] for e in snapshot["recent_experiences"]].count("user_message") == 1
    assert agent.get_status()["energy"] == snapshot["state"]["energy"]


def test_assessment_influences_emotion_and_survives_restart(tmp_path):
    path = tmp_path / "emotion.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    baseline = core.get_emotional_state()["state"]
    snapshot = EmotionalAgent(core).react(curious_appraisal(), user_message=False)
    assert snapshot["state"]["curiosity"] > baseline["curiosity"]
    assert snapshot["state"]["energy"] == baseline["energy"]
    assert all(e["event"] != "user_message" for e in snapshot["recent_experiences"])
    restarted = EmotionalAgent(EmotionalCore(path, clock=lambda: DAY))
    assert restarted.emotional_core.get_emotional_state() == snapshot
    assert restarted.get_status() == EmotionalAgent(core).get_status()


async def test_compatibility_update_requires_explicit_events(tmp_path):
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: DAY)
    agent = EmotionalAgent(core)
    before = core.get_emotional_state()
    mood = await agent.update_mood({"content": "Плохой день", "mood": "sad"})
    assert core.get_emotional_state() == before
    assert mood == before["mood_description"]
    await agent.update_mood({"negative_tone": True})
    assert core.state["irritation"] == pytest.approx(0.3)
    assert core.state["energy"] == before["state"]["energy"]


def test_status_observes_shared_snapshot_without_advancing_time(tmp_path):
    now = DAY
    core = EmotionalCore(tmp_path / "emotion.db", clock=lambda: now)
    agent = EmotionalAgent(core)
    before = core.get_emotional_state()
    now += timedelta(hours=12)
    status = agent.get_status()
    assert core.get_emotional_state() == before
    assert status["mood"] == before["mood_description"]
    assert status["energy"] == before["state"]["energy"]
    assert status["anxiety"] == before["state"]["anxiety"]


def test_emotional_agent_preserves_mood_change_notification(monkeypatch):
    import mood_engine
    events = []
    monkeypatch.setattr(mood_engine.event_bus, "publish", lambda event, data: events.append(data))
    core = EmotionalCore(clock=lambda: DAY)
    agent = EmotionalAgent(core)
    for _ in range(5):
        agent.react()
    assert len(events) == 1
    assert events[0]["old_mood"] == "любопытная"
    assert events[0]["new_mood"] == "спокойная"
    assert core.state["energy"] == pytest.approx(0.7 - 5 * 0.025)
