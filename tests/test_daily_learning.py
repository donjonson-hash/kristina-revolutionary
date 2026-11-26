"""The writer's web-learning routine runs at most once per UTC day, and the
proactive gates hold initiative for one day of silence -- not forever.

Measured in production (2026-11-26): the agent sent one proactive in 30 days
because awaiting_user_turn/awaiting_answer blocked every decision window after
it, and 0.59-score impulses died under the old 0.62 threshold. These tests pin
the repaired pacing.
"""
import sqlite3
from datetime import datetime, timedelta, timezone

from autonomy_decision import DecisionEngine
from dialogue_state import (
    PROACTIVE_SILENCE_LIMIT,
    empty_state,
    proactive_block_reason,
)
from self_learning import SelfLearningAgent

DAY = datetime(2026, 11, 24, 9, 0, tzinfo=timezone.utc)


async def test_daily_learning_runs_once_per_utc_day(tmp_path, monkeypatch):
    agent = SelfLearningAgent(db_path=str(tmp_path / "knowledge.db"),
                              brain_db_path=str(tmp_path / "state.db"))
    monkeypatch.setattr(agent.perplexity, "api_key", "test-key")
    calls = []

    async def fake_learn(topic, custom_query=None):
        calls.append(topic)
        return {"content": "fact"}

    monkeypatch.setattr(agent, "learn_topic", fake_learn)
    assert await agent.maybe_run_daily_learning(now=DAY) is True
    assert calls == ["stockholm_events", "literary_nonfiction", "sweden_culture"]
    # The claim makes the same day idempotent: no second web round.
    assert await agent.maybe_run_daily_learning(now=DAY + timedelta(hours=6)) is False
    assert len(calls) == 3
    assert await agent.maybe_run_daily_learning(now=DAY + timedelta(days=1)) is True
    assert len(calls) == 6


async def test_daily_learning_without_the_web_key_does_not_spend_the_day(
        tmp_path, monkeypatch):
    agent = SelfLearningAgent(db_path=str(tmp_path / "knowledge.db"),
                              brain_db_path=str(tmp_path / "state.db"))
    monkeypatch.setattr(agent.perplexity, "api_key", None)
    assert await agent.maybe_run_daily_learning(now=DAY) is False
    with sqlite3.connect(agent.db_path) as conn:
        rows = conn.execute("SELECT COUNT(*) FROM knowledge").fetchone()[0]
    assert rows == 0  # the day is NOT claimed: enabling the key starts today
    calls = []

    async def fake_learn(topic, custom_query=None):
        calls.append(topic)
        return {"content": "fact"}

    monkeypatch.setattr(agent, "learn_topic", fake_learn)
    monkeypatch.setattr(agent.perplexity, "api_key", "test-key")
    assert await agent.maybe_run_daily_learning(now=DAY) is True
    assert len(calls) == 3


def test_an_ignored_question_holds_initiative_for_a_day_not_forever():
    state = empty_state()
    state.update(
        pending_question={"id": "q:2", "text": "Давай завтра?",
                          "source_message_id": 2, "status": "open",
                          "asked_at": DAY.isoformat()},
        last_user_id=1,
    )
    assert proactive_block_reason(state, DAY + timedelta(hours=23)) == "awaiting_answer"
    assert proactive_block_reason(state, DAY + PROACTIVE_SILENCE_LIMIT) is None


def test_a_silent_user_gets_one_proactive_per_day_not_absolute_silence():
    state = empty_state()
    state.update(
        proactive_since_user=1,
        last_user_at=(DAY - timedelta(hours=30)).isoformat(),
        last_proactive_at=(DAY - timedelta(hours=30)).isoformat(),
    )
    # Both events are older than the silence limit: one more proactive is due.
    assert proactive_block_reason(state, DAY) is None
    # A recent proactive paces the next one to a silence limit.
    state["last_proactive_at"] = DAY.isoformat()
    assert proactive_block_reason(state, DAY + timedelta(hours=23)) == "awaiting_user_turn"
    # A recent user turn keeps the one-proactive-per-turn rule.
    state.update(last_user_at=DAY.isoformat(),
                 last_proactive_at=(DAY - timedelta(hours=30)).isoformat())
    assert proactive_block_reason(state, DAY) == "awaiting_user_turn"


def test_the_threshold_allows_the_measured_near_miss_impulses():
    # Production windows at 0.59 died as impulse_too_weak under 0.62.
    from autonomy_decision import PROACTIVE_THRESHOLD

    assert PROACTIVE_THRESHOLD == 0.57
    # The creative diary keeps its own calibration; only the proactive gate
    # is lowered (bot.py builds proactive_decision_engine from the constant).
    assert DecisionEngine().threshold == 0.62
