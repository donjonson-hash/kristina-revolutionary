"""Completed experiments affect emotions once, including after crash replay."""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from uuid import uuid4

import pytest

from emotional_core import EmotionalCore


DAY = datetime(2026, 9, 12, 10, tzinfo=timezone.utc)


@pytest.mark.parametrize("outcome, changes", [
    ("supported_on_cases", {"happiness": 0.03}),
    ("counterexample_found", {"curiosity": 0.04, "irritation": 0.01}),
])
def test_result_survives_restart_and_replay_without_message_event(tmp_path, outcome, changes):
    path = tmp_path / "state.db"
    core = EmotionalCore(path, clock=lambda: DAY)
    core.evolve({"user_message": True})
    before = core.get_emotional_state()
    experiment_id = uuid4().hex
    assert core.record_experiment(experiment_id, outcome) is True
    expected = before["state"].copy()
    for emotion, change in changes.items():
        expected[emotion] += change
    assert core.state == pytest.approx(expected)
    assert core.recent_experiences == before["recent_experiences"]

    restarted = EmotionalCore(path, clock=lambda: DAY)
    assert restarted.state == pytest.approx(expected)
    assert restarted.record_experiment(experiment_id, outcome) is False
    assert restarted.state == pytest.approx(expected)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT experiment_id, outcome FROM experiment_effects").fetchall() == [
            (experiment_id, outcome)
        ]
        payload = json.loads(conn.execute("SELECT payload FROM emotional_state").fetchone()[0])
    assert payload["version"] == 2
    assert payload["recent_experiences"] == before["recent_experiences"]


@pytest.mark.parametrize("rejected_table", ["emotional_state", "experiment_effects"])
def test_failed_transaction_rolls_back_receipt_and_live_state_then_can_retry(tmp_path, rejected_table):
    path = tmp_path / "state.db"
    now = DAY
    core = EmotionalCore(path, clock=lambda: now)
    before = core.get_emotional_state()
    experiment_id = uuid4().hex
    with sqlite3.connect(path) as conn:
        saved = conn.execute("SELECT payload FROM emotional_state").fetchone()[0]
        conn.execute(f"""CREATE TRIGGER reject_write BEFORE INSERT ON {rejected_table}
            BEGIN SELECT RAISE(ABORT, 'write rejected'); END""")
    now += timedelta(hours=1)
    with pytest.raises(sqlite3.IntegrityError, match="write rejected"):
        core.record_experiment(experiment_id, "counterexample_found")
    assert core.get_emotional_state() == before
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT payload FROM emotional_state").fetchone()[0] == saved
        assert conn.execute("SELECT COUNT(*) FROM experiment_effects").fetchone()[0] == 0
        conn.execute("DROP TRIGGER reject_write")
    assert core.record_experiment(experiment_id, "counterexample_found") is True
    assert core.last_update == now
    assert core.record_experiment(experiment_id, "counterexample_found") is False


def test_concurrent_process_instances_apply_same_experiment_once(tmp_path):
    path = tmp_path / "state.db"
    writers = [EmotionalCore(path, clock=lambda: DAY) for _ in range(4)]
    ready = Barrier(len(writers))
    experiment_id = uuid4().hex

    def record(core):
        ready.wait(timeout=5)
        return core.record_experiment(experiment_id, "counterexample_found")

    with ThreadPoolExecutor(max_workers=len(writers)) as pool:
        results = list(pool.map(record, writers))
    assert results.count(True) == 1
    assert results.count(False) == 3
    reopened = EmotionalCore(path, clock=lambda: DAY)
    assert reopened.state["curiosity"] == pytest.approx(0.84)
    assert reopened.state["irritation"] == pytest.approx(0.11)
    assert reopened.state["energy"] == pytest.approx(0.7)
    assert reopened.recent_experiences == []


@pytest.mark.parametrize("experiment_id", [
    None, 123, [], "", "a" * 31, "a" * 33, "g" * 32,
    "a" * 10000, "A" * 32, "a" * 32 + "\n", "user_123",
])
def test_invalid_identifier_has_no_effect(tmp_path, experiment_id):
    core = EmotionalCore(tmp_path / "state.db", clock=lambda: DAY)
    before = core.get_emotional_state()
    with pytest.raises(ValueError, match="experiment_id"):
        core.record_experiment(experiment_id, "supported_on_cases")
    assert core.get_emotional_state() == before
    with sqlite3.connect(core.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM experiment_effects").fetchone()[0] == 0


@pytest.mark.parametrize("outcome", [None, [], {}, 1, "", "success", "user_message"])
def test_invalid_outcome_does_not_consume_identifier(outcome):
    core = EmotionalCore(clock=lambda: DAY)
    before = core.get_emotional_state()
    experiment_id = uuid4().hex
    with pytest.raises(ValueError, match="outcome"):
        core.record_experiment(experiment_id, outcome)
    assert core.get_emotional_state() == before
    assert core.record_experiment(experiment_id, "supported_on_cases") is True


def test_in_memory_replay_does_not_advance_time_or_apply_conflicting_result():
    now = DAY
    core = EmotionalCore(clock=lambda: now)
    experiment_id = uuid4().hex
    assert core.record_experiment(experiment_id, "supported_on_cases") is True
    before = core.get_emotional_state()
    now += timedelta(hours=2)
    assert core.record_experiment(experiment_id, "counterexample_found") is False
    assert core.get_emotional_state() == before


def test_experiment_advances_time_and_clamps_state():
    now = DAY
    core = EmotionalCore(clock=lambda: now)
    control = EmotionalCore(clock=lambda: now)
    now += timedelta(hours=2)
    control.evolve()
    core.record_experiment(uuid4().hex, "supported_on_cases")
    expected = control.state.copy()
    expected["happiness"] += 0.03
    assert core.state == pytest.approx(expected)
    core.state["curiosity"] = 0.99
    core.record_experiment(uuid4().hex, "counterexample_found")
    assert core.state["curiosity"] == 1.0
