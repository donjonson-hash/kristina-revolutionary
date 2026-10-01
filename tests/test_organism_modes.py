"""Persistence and isolation checks for Kristina's first slow organism layer."""

import math
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from emotional_core import EmotionalCore
from organism_modes import DEFAULT_MODE_DEFINITIONS, MODE_NAMES, OrganismModes


START = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def test_default_field_contains_exactly_twelve_canonical_modes(tmp_path):
    modes = OrganismModes(str(tmp_path / "state.db"), clock=lambda: START)
    snapshot = modes.snapshot()

    assert tuple(snapshot) == MODE_NAMES
    assert len(snapshot) == 12
    assert snapshot["core_741"].amplitude == pytest.approx(0.60)
    assert snapshot["aesthetic_drive"].amplitude == pytest.approx(0.25)
    assert snapshot["crisis_957"].amplitude == pytest.approx(0.08)

    for name, state in snapshot.items():
        definition = DEFAULT_MODE_DEFINITIONS[name]
        assert state.baseline == pytest.approx(definition.baseline)
        assert state.amplitude == pytest.approx(definition.baseline)
        assert state.phase == 0.0
        assert state.half_life_hours == pytest.approx(definition.half_life_hours)
        assert state.updated_at == START


def test_mode_state_survives_restart_without_reseeding(tmp_path):
    path = str(tmp_path / "state.db")
    modes = OrganismModes(path, clock=lambda: START)
    changed = modes.set_amplitude(
        "aesthetic_drive",
        0.47,
        phase=7.0,
        at=START + timedelta(hours=3),
    )

    restarted = OrganismModes(path, clock=lambda: START + timedelta(days=2))
    restored = restarted.get("aesthetic_drive")

    assert restored.amplitude == pytest.approx(0.47)
    assert restored.phase == pytest.approx(7.0 % math.tau)
    assert restored.updated_at == changed.updated_at
    assert restarted.ensure_defaults() == 0


def test_additive_initialization_restores_missing_mode_but_preserves_existing_evolution(tmp_path):
    path = str(tmp_path / "state.db")
    modes = OrganismModes(path, clock=lambda: START)
    modes.set_amplitude("agency_exec", 0.73, at=START + timedelta(hours=1))

    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM kristina_modes WHERE name='social_overload'")

    restarted = OrganismModes(path, clock=lambda: START + timedelta(hours=5))
    snapshot = restarted.snapshot()

    assert snapshot["agency_exec"].amplitude == pytest.approx(0.73)
    assert snapshot["social_overload"].amplitude == pytest.approx(
        DEFAULT_MODE_DEFINITIONS["social_overload"].baseline
    )
    assert snapshot["social_overload"].updated_at == START + timedelta(hours=5)


def test_relaxation_uses_elapsed_hours_not_tick_count():
    once = OrganismModes(clock=lambda: START)
    many = OrganismModes(clock=lambda: START)

    once.set_amplitude("creativity_357", 0.82, at=START)
    many.set_amplitude("creativity_357", 0.82, at=START)

    once.relax_to_baseline(START + timedelta(hours=48))
    many.relax_to_baseline(START + timedelta(hours=24))
    many.relax_to_baseline(START + timedelta(hours=48))

    expected = once.get("creativity_357")
    actual = many.get("creativity_357")

    assert actual.amplitude == pytest.approx(expected.amplitude, abs=1e-12)
    assert expected.amplitude == pytest.approx((0.82 + 0.22) / 2.0)


def test_backwards_time_never_rewinds_a_mode():
    modes = OrganismModes(clock=lambda: START)
    changed = modes.set_amplitude(
        "withdrawal_147",
        0.61,
        at=START + timedelta(hours=2),
    )

    modes.relax_to_baseline(START + timedelta(hours=1))
    after = modes.get("withdrawal_147")

    assert after == changed


def test_unknown_future_rows_do_not_break_current_snapshot(tmp_path):
    path = str(tmp_path / "state.db")
    modes = OrganismModes(path, clock=lambda: START)

    with sqlite3.connect(path) as conn:
        conn.execute(
            """INSERT INTO kristina_modes
               (name, baseline, amplitude, phase, half_life_hours, updated_at, version)
               VALUES ('future_mode_001', 0.2, 0.3, 0.0, 100.0, ?, 1)""",
            (START.isoformat(),),
        )

    assert tuple(modes.snapshot()) == MODE_NAMES


def test_corrupt_known_mode_fails_closed_instead_of_resetting(tmp_path):
    path = str(tmp_path / "state.db")
    modes = OrganismModes(path, clock=lambda: START)
    modes.set_amplitude("self_critique", 0.71, at=START)

    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE kristina_modes SET phase='not-a-number' WHERE name='self_critique'"
        )

    with pytest.raises(ValueError, match="Invalid mode phase"):
        modes.snapshot()

    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT amplitude, phase FROM kristina_modes WHERE name='self_critique'"
        ).fetchone()
    assert row[0] == pytest.approx(0.71)
    assert row[1] == "not-a-number"


def test_modes_are_attached_to_emotional_core_but_do_not_change_emotional_output(tmp_path):
    path = str(tmp_path / "state.db")
    core = EmotionalCore(path, clock=lambda: START)
    before = core.get_emotional_state()

    core.organism_modes.set_amplitude("crisis_957", 1.0, at=START)
    after = core.get_emotional_state()

    assert after == before
    assert core.organism_modes.get("crisis_957").amplitude == pytest.approx(1.0)


def test_emotional_heartbeat_does_not_advance_modes_yet(tmp_path):
    path = str(tmp_path / "state.db")
    now = [START]
    core = EmotionalCore(path, clock=lambda: now[0])
    before = core.organism_modes.snapshot()

    now[0] = START + timedelta(hours=12)
    core.evolve()
    after = core.organism_modes.snapshot()

    assert after == before
