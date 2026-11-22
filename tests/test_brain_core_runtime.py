from datetime import datetime, timezone
from types import MappingProxyType

from autonomy_decision import OrganismProjection
from brain_core_runtime import (
    evaluate_v4_proactive_decision,
    load_proactive_history,
    run_sqlite_nonblocking,
    save_proactive_delivery,
)
from persistent_memory import PersistentMemory


async def test_proactive_history_persists_across_restart(tmp_path):
    db_file = tmp_path / "mem.db"
    mem1 = PersistentMemory(str(db_file))
    t0 = datetime(2026, 11, 22, 10, 0, tzinfo=timezone.utc)

    await run_sqlite_nonblocking(
        lambda: save_proactive_delivery(mem1, 123456, t0, ["Привет, как твой релиз?", "Смотрела новый маршрут"])
    )

    mem2 = PersistentMemory(str(db_file))
    restored = load_proactive_history(mem2)
    assert 123456 in restored
    assert restored[123456]["last_proactive"] == t0
    assert list(restored[123456]["recent"]) == ["Привет, как твой релиз?", "Смотрела новый маршрут"]


def test_v4_physics_blocks_proactive_when_conflict_modes_elevated():
    angry_projection = OrganismProjection(
        amplitudes=MappingProxyType({"social_overload": 0.45, "withdrawal_147": 0.50, "crisis_957": 0.35}),
        deviations=MappingProxyType({"social_overload": 0.30, "withdrawal_147": 0.30, "crisis_957": 0.27}),
        dominant=("withdrawal_147", "social_overload", "crisis_957"),
        shifted=("social_overload", "withdrawal_147", "crisis_957"),
        max_abs_deviation=0.30,
    )
    emotional_state = {
        "state": {
            "energy": 0.75,
            "happiness": 0.65,
            "curiosity": 0.80,
            "anxiety": 0.20,
            "loneliness": 0.75,
            "creativity": 0.70,
            "irritation": 0.15,
        },
        "is_night": False,
    }
    dec = evaluate_v4_proactive_decision(
        emotional_state,
        angry_projection,
        {"hours_since_contact": 12.0, "last_proactive": None},
        threshold=0.55,
        now=datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc),
    )
    assert dec.action == "none"
    assert dec.reason == "wants_space"
