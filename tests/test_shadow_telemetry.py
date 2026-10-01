"""Durable, privacy-preserving evidence for organism shadow decisions."""

import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from autonomy_decision import (
    DecisionEngine,
    compare_shadow_decision,
    project_organism_modes,
)
from organism_modes import OrganismModes
from shadow_telemetry import ShadowTelemetryStore, shadow_time_bucket


START = datetime(2026, 10, 1, 12, 7, tzinfo=timezone.utc)


def make_observation(*, share=0.60, aesthetic=0.70, creativity=0.62):
    modes = OrganismModes(clock=lambda: START)
    modes.set_amplitude("aesthetic_drive", aesthetic, at=START)
    modes.set_amplitude("creativity_357", creativity, at=START)
    projection = project_organism_modes(modes)
    desires = {"talk": 0.40, "share": share, "ask": 0.45, "be_alone": 0.20}
    engine = DecisionEngine(threshold=0.62)
    baseline = engine.decide(desires, {}, now=START)
    report = compare_shadow_decision(
        baseline_desires=desires,
        baseline_decision=baseline,
        projection=projection,
        decision_engine=engine,
        context={},
        now=START,
    )
    return projection, report


def test_record_survives_restart_and_never_stores_raw_scope(tmp_path):
    path = str(tmp_path / "state.db")
    store = ShadowTelemetryStore(path)
    projection, report = make_observation()
    raw_scope = "telegram:private:42"

    assert store.record_once(
        kind="proactive",
        scope=raw_scope,
        opportunity_at=START - timedelta(minutes=1),
        observed_at=START,
        projection=projection,
        report=report,
    ) is True

    restarted = ShadowTelemetryStore(path)
    rows = restarted.recent()
    assert len(rows) == 1
    row = rows[0]

    assert row["scope_sha256"] == hashlib.sha256(raw_scope.encode("utf8")).hexdigest()
    assert row["kind"] == "proactive"
    assert row["baseline_action"] == report.baseline.action
    assert row["shadow_action"] == report.shadow.action
    assert row["decision_changed"] == report.decision_changed
    assert row["mode_deviations"]["aesthetic_drive"] == pytest.approx(
        projection.deviations["aesthetic_drive"]
    )
    assert row["score_deltas"]["share"] == pytest.approx(report.score_deltas["share"])

    with open(path, "rb") as database:
        assert raw_scope.encode("utf8") not in database.read()


def test_same_opportunity_is_first_write_wins_even_if_recomputed(tmp_path):
    path = str(tmp_path / "state.db")
    store = ShadowTelemetryStore(path)
    projection, first_report = make_observation(share=0.60)
    opportunity = START - timedelta(minutes=2)

    assert store.record_once(
        kind="proactive",
        scope="session-a",
        opportunity_at=opportunity,
        observed_at=START,
        projection=projection,
        report=first_report,
    )

    changed_projection, changed_report = make_observation(
        share=0.80,
        aesthetic=1.0,
        creativity=1.0,
    )
    assert store.record_once(
        kind="proactive",
        scope="session-a",
        opportunity_at=opportunity,
        observed_at=START + timedelta(seconds=10),
        projection=changed_projection,
        report=changed_report,
    ) is False

    rows = store.recent()
    assert len(rows) == 1
    assert rows[0]["baseline_score"] == pytest.approx(first_report.baseline.score)
    assert rows[0]["shadow_score"] == pytest.approx(first_report.shadow.score)


def test_same_time_for_different_scopes_does_not_collide(tmp_path):
    store = ShadowTelemetryStore(str(tmp_path / "state.db"))
    projection, report = make_observation()

    for scope in ("session-a", "session-b"):
        assert store.record_once(
            kind="proactive",
            scope=scope,
            opportunity_at=START,
            observed_at=START,
            projection=projection,
            report=report,
        )

    assert len(store.recent()) == 2


def test_creative_time_bucket_bounds_write_volume():
    a = shadow_time_bucket(START, minutes=30)
    b = shadow_time_bucket(START + timedelta(minutes=20), minutes=30)
    c = shadow_time_bucket(START + timedelta(minutes=23), minutes=30)

    assert a == b
    assert c == a + timedelta(minutes=30)
    assert a.minute in (0, 30)
    assert a.second == 0 and a.microsecond == 0


def test_summary_exposes_calibration_counts_without_content(tmp_path):
    store = ShadowTelemetryStore(str(tmp_path / "state.db"))

    neutral_projection, neutral_report = make_observation(
        share=0.40,
        aesthetic=0.25,
        creativity=0.22,
    )
    changed_projection, changed_report = make_observation(
        share=0.60,
        aesthetic=1.0,
        creativity=1.0,
    )

    assert store.record_once(
        kind="creative",
        scope="creative-global",
        opportunity_at=START,
        observed_at=START,
        projection=neutral_projection,
        report=neutral_report,
    )
    assert store.record_once(
        kind="proactive",
        scope="session-a",
        opportunity_at=START + timedelta(minutes=1),
        observed_at=START + timedelta(minutes=1),
        projection=changed_projection,
        report=changed_report,
    )

    summary = store.summary()
    assert summary["total"] == 2
    assert summary["decision_changed"] == int(neutral_report.decision_changed) + int(
        changed_report.decision_changed
    )
    assert summary["by_kind"]["creative"]["total"] == 1
    assert summary["by_kind"]["proactive"]["total"] == 1
    assert 0.0 <= summary["decision_changed_rate"] <= 1.0
    assert summary["max_abs_score_delta"] >= summary["avg_max_abs_score_delta"]


def test_summary_since_filters_old_observations(tmp_path):
    store = ShadowTelemetryStore(str(tmp_path / "state.db"))
    projection, report = make_observation()

    for index, at in enumerate((START, START + timedelta(hours=2))):
        assert store.record_once(
            kind="proactive",
            scope=f"session-{index}",
            opportunity_at=at,
            observed_at=at,
            projection=projection,
            report=report,
        )

    summary = store.summary(since=START + timedelta(hours=1))
    assert summary["total"] == 1


def test_invalid_timestamps_or_kind_do_not_write(tmp_path):
    store = ShadowTelemetryStore(str(tmp_path / "state.db"))
    projection, report = make_observation()

    with pytest.raises(ValueError):
        store.record_once(
            kind="unknown",
            scope="session",
            opportunity_at=START,
            observed_at=START,
            projection=projection,
            report=report,
        )

    with pytest.raises(ValueError):
        store.record_once(
            kind="proactive",
            scope="session",
            opportunity_at=START.replace(tzinfo=None),
            observed_at=START,
            projection=projection,
            report=report,
        )

    with pytest.raises(ValueError, match="predates"):
        store.record_once(
            kind="proactive",
            scope="session",
            opportunity_at=START,
            observed_at=START - timedelta(seconds=1),
            projection=projection,
            report=report,
        )

    with sqlite3.connect(store.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM shadow_decision_telemetry").fetchone()[0] == 0
