from datetime import datetime, timedelta, timezone

from autonomy_decision import (
    DecisionEngine,
    DesireEngine,
    format_organism_projection,
    project_organism_modes,
)
from organism_modes import OrganismModes


def test_desire_engine_prefers_sharing_when_creative_and_curious():
    engine = DesireEngine()
    desires = engine.calculate(
        {
            "state": {
                "energy": 0.8,
                "curiosity": 0.9,
                "loneliness": 0.4,
                "creativity": 0.95,
                "irritation": 0.05,
                "anxiety": 0.1,
            }
        },
        {"hours_since_contact": 8},
    )

    assert desires["share"] > desires["talk"]
    assert desires["share"] > desires["be_alone"]


def test_decision_engine_can_choose_silence():
    engine = DecisionEngine(threshold=0.62)
    decision = engine.decide(
        {"talk": 0.31, "share": 0.44, "ask": 0.28, "be_alone": 0.35}
    )

    assert decision.action == "none"
    assert decision.reason == "impulse_too_weak"


def test_decision_engine_respects_need_for_space():
    engine = DecisionEngine(threshold=0.62)
    decision = engine.decide(
        {"talk": 0.72, "share": 0.68, "ask": 0.55, "be_alone": 0.81}
    )

    assert decision.action == "none"
    assert decision.reason == "wants_space"


def test_decision_engine_sends_on_strong_internal_impulse():
    engine = DecisionEngine(threshold=0.62)
    decision = engine.decide(
        {"talk": 0.48, "share": 0.84, "ask": 0.51, "be_alone": 0.12}
    )

    assert decision.action == "message"
    assert decision.intention == "share"
    assert decision.score == 0.84


def test_decision_engine_applies_cooldown():
    now = datetime(2026, 8, 21, 12, 0, 0)
    engine = DecisionEngine(threshold=0.62, cooldown=timedelta(hours=2))
    decision = engine.decide(
        {"talk": 0.85, "share": 0.82, "ask": 0.7, "be_alone": 0.1},
        {"last_proactive": now - timedelta(minutes=45)},
        now=now,
    )

    assert decision.action == "none"
    assert decision.reason == "cooldown"


def _emotional_fixture():
    return {
        "state": {
            "energy": 0.8,
            "curiosity": 0.9,
            "loneliness": 0.4,
            "creativity": 0.95,
            "irritation": 0.05,
            "anxiety": 0.1,
        }
    }


def test_projection_is_read_only_and_does_not_advance_modes():
    start = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    modes = OrganismModes(clock=lambda: start)
    modes.set_amplitude("aesthetic_drive", 0.44, at=start)
    before = modes.snapshot()

    projection = project_organism_modes(modes)
    after = modes.snapshot()

    assert after == before
    assert projection.amplitudes["aesthetic_drive"] == 0.44
    assert projection.deviations["aesthetic_drive"] == 0.44 - before["aesthetic_drive"].baseline
    assert "aesthetic_drive" in projection.dominant
    assert "top=" in format_organism_projection(projection)
    assert "max_dev=" in format_organism_projection(projection)


def test_desire_scores_are_identical_with_or_without_organism_projection():
    start = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    modes = OrganismModes(clock=lambda: start)
    modes.set_amplitude("crisis_957", 1.0, at=start)
    modes.set_amplitude("withdrawal_147", 0.95, at=start)
    projection = project_organism_modes(modes)

    engine = DesireEngine()
    base_context = {"hours_since_contact": 8}
    observed_context = {
        "hours_since_contact": 8,
        "organism_projection": projection,
    }

    assert engine.calculate(_emotional_fixture(), base_context) == engine.calculate(
        _emotional_fixture(), observed_context
    )


def test_decision_is_identical_when_projection_is_present():
    start = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    modes = OrganismModes(clock=lambda: start)
    modes.set_amplitude("social_overload", 1.0, at=start)
    projection = project_organism_modes(modes)

    desires = DesireEngine().calculate(
        _emotional_fixture(),
        {"hours_since_contact": 8, "organism_projection": projection},
    )
    engine = DecisionEngine(threshold=0.62)
    with_projection = engine.decide(
        desires,
        {"organism_projection": projection},
        now=datetime(2026, 10, 1, 12),
    )
    without_projection = engine.decide(
        DesireEngine().calculate(_emotional_fixture(), {"hours_since_contact": 8}),
        {},
        now=datetime(2026, 10, 1, 12),
    )

    assert with_projection == without_projection


def test_invalid_projection_fails_closed_in_desire_engine():
    try:
        DesireEngine().calculate(
            _emotional_fixture(),
            {"organism_projection": {"aesthetic_drive": 1.0}},
        )
    except ValueError as exc:
        assert "OrganismProjection" in str(exc)
    else:
        raise AssertionError("invalid projection must be rejected")


def test_projection_mappings_are_immutable():
    start = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    projection = project_organism_modes(OrganismModes(clock=lambda: start))

    try:
        projection.amplitudes["core_741"] = 0.0
    except TypeError:
        pass
    else:
        raise AssertionError("organism projection must be immutable")
