from datetime import datetime, timedelta

from autonomy_decision import DecisionEngine, DesireEngine


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
