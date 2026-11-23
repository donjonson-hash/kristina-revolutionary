from datetime import datetime, timezone
from types import SimpleNamespace
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
import pytest

import brain_llm_integration
import brain_core_runtime as bcr
from brain_core_runtime import maybe_run_nightly_rem_consolidation
from creative_life import CreativeDiary
from kristina_brain import AsyncSQLiteStateStore, BrainEngine
from kristina_identity import BASE_IDENTITY
from self_learning import SelfLearningAgent


def test_canonical_writer_identity_across_all_modules():
    llm = brain_llm_integration.LLMNeuroInterface.__new__(brain_llm_integration.LLMNeuroInterface)
    llm._get_emotional_prompt = lambda *a, **k: ""
    prompt = llm._craft_neuro_prompt("calm", 0.4, 0.5, 0.3, [])
    assert "тревел-писательница" in prompt
    assert "UX-дизайнер" not in prompt
    assert "Senior Software Engineer" not in prompt
    assert "ux_trends" not in SelfLearningAgent.WRITER_TOPICS
    assert "literary_nonfiction" in SelfLearningAgent.WRITER_TOPICS


@pytest.mark.asyncio
async def test_synaptic_self_learning_and_rem_dream_notebook(tmp_path):
    brain_db = str(tmp_path / "state.db")
    know_db = str(tmp_path / "knowledge.db")
    diary_db = str(tmp_path / "diary.db")

    store = AsyncSQLiteStateStore(brain_db)
    engine = BrainEngine(store)
    await engine.start()
    try:
        await engine.save_artifact(
            scope_id="default",
            artifact_id="draft-sveavagen",
            title="Город без достопримечательностей",
            excerpt="Автобус на Свеавеген не идёт, скамейка мокрая, стакан из-под кофе остыл.",
        )
    finally:
        await engine.shutdown()

    learner = SelfLearningAgent(db_path=know_db, brain_db_path=brain_db)
    pulse = await learner.record_dialogue_feedback(
        "default",
        reaction="curiosity",
        intensity=0.85,
        reward=0.8,
        user_excerpt="У нас на Шри-Ланке шум прибоя прямо под окном.",
        location="Унаватуна, Шри-Ланка",
        sensory_cue="шум тёплого прибоя под окном",
    )
    assert "DA" in pulse["neurotransmitters"]

    class DummyCore:
        db_path = brain_db

        def get_emotional_state(self):
            return {"dominant_emotion": "curiosity", "energy": 0.65}

        def evolve(self, event):
            return {"state": {"dominant_emotion": "calm", "creative": bool(event.get("creative_expression"))}}

    captured_prompts = []

    async def fake_generate(prompt: str, sys_prompt: str) -> str:
        captured_prompts.append((prompt, sys_prompt))
        return "Мне снилось, что автобус на Свеавеген остановился прямо у тёплого прибоя в Унаватуне, а в мокром блокноте осталась одна честная строчка."

    night_ts = datetime(2026, 11, 23, 2, 30, tzinfo=timezone.utc)  # 03:30 Europe/Stockholm
    dummy_mem = SimpleNamespace(db_path=diary_db)
    dummy_core = DummyCore()

    res1 = await maybe_run_nightly_rem_consolidation(
        dummy_mem,
        dummy_core,
        scope_id="default",
        now=night_ts,
        generate_fn=fake_generate,
    )
    assert res1 is not None
    assert res1["consolidation"]["synapses_adjusted"]
    assert res1["dream"] is not None
    assert "Мне снилось" in res1["dream"]["thought"]
    assert captured_prompts and BASE_IDENTITY in captured_prompts[0][1]

    diary_entries = CreativeDiary(diary_db).recent(limit=5)
    assert len(diary_entries) == 1
    assert diary_entries[0]["theme"] == "сон и утренняя заметка"

    res2 = await maybe_run_nightly_rem_consolidation(
        dummy_mem,
        dummy_core,
        scope_id="default",
        now=night_ts,
        generate_fn=fake_generate,
    )
    assert res2 is None


def test_reward_ledger_atomic_claim_gives_exactly_one_winner(tmp_path):
    """Регрессия гонки _pop_daily_reward_sync: из 5 конкурентных pop ровно один получает награду."""
    learner = SelfLearningAgent(db_path=str(tmp_path / "knowledge.db"), brain_db_path=str(tmp_path / "state.db"))
    for _ in range(4):
        learner._accumulate_reward_sync("u:r", 0.5)  # средняя награда дня = 0.5

    barrier = threading.Barrier(5)

    def pop():
        barrier.wait()
        return learner._pop_daily_reward_sync("u:r")

    with ThreadPoolExecutor(max_workers=5) as ex:
        outs = list(ex.map(lambda _: pop(), range(5)))

    nonnull = [o for o in outs if o is not None]
    assert len(nonnull) == 1, f"атомарный claim сломан: {outs}"
    assert abs(nonnull[0] - 0.5) < 1e-6
    # Леджер вычищен: повторный pop уже пуст.
    assert learner._pop_daily_reward_sync("u:r") is None


@pytest.mark.asyncio
async def test_rem_one_dream_per_night_force_respects_claim_and_overwrite_recomputes(tmp_path):
    """Регрессия гонки REM: строго один сон на ночь; force уважает DB-claim; overwrite пересчитывает."""
    brain_db = str(tmp_path / "state.db")
    know_db = str(tmp_path / "knowledge.db")
    diary_db = str(tmp_path / "diary.db")
    scope = "u:remreg"
    bcr._COMPLETED_REM_NIGHTS.clear()

    learner = SelfLearningAgent(db_path=know_db, brain_db_path=brain_db)
    await learner.record_dialogue_feedback(
        scope,
        reaction="curiosity",
        intensity=0.9,
        reward=0.7,
        user_excerpt="яркая сцена у воды",
        location="Унаватуна, Шри-Ланка",
        sensory_cue="шум прибоя",
        event_id="remreg-1",
    )

    class _Core:
        db_path = brain_db

        def get_emotional_state(self):
            return {"dominant_emotion": "curiosity", "energy": 0.65}

        def evolve(self, event):
            return {"state": {"dominant_emotion": "calm"}}

    async def _gen(prompt: str, sys_prompt: str) -> str:
        await asyncio.sleep(0)
        return "Мне снилось, что автобус на Свеавеген остановился прямо у тёплого прибоя в Унаватуне, а в мокром блокноте осталась одна честная строчка про дом, воду и свет."

    night_ts = datetime(2026, 11, 23, 2, 30, tzinfo=timezone.utc)  # 03:30 Europe/Stockholm
    mem = SimpleNamespace(db_path=diary_db)
    core = _Core()

    # 1) Два КОНКУРЕНТНЫХ non-force запуска -> ровно один сон (INSERT OR IGNORE claim).
    r = await asyncio.gather(
        maybe_run_nightly_rem_consolidation(mem, core, scope_id=scope, now=night_ts, generate_fn=_gen),
        maybe_run_nightly_rem_consolidation(mem, core, scope_id=scope, now=night_ts, generate_fn=_gen),
    )
    assert len([x for x in r if x]) == 1, f"гонка REM: {r}"
    assert len(CreativeDiary(diary_db).recent(limit=10)) == 1

    # 2) force=True уважает DB-claim: чистим in-memory (симуляция свежего процесса) -> всё равно no-op.
    bcr._COMPLETED_REM_NIGHTS.clear()
    rf = await maybe_run_nightly_rem_consolidation(mem, core, scope_id=scope, now=night_ts, force=True, generate_fn=_gen)
    assert rf is None
    assert len(CreativeDiary(diary_db).recent(limit=10)) == 1

    # 3) overwrite=True -> явный пересчёт: второй сон дописывается.
    ro = await maybe_run_nightly_rem_consolidation(mem, core, scope_id=scope, now=night_ts, overwrite=True, generate_fn=_gen)
    assert ro is not None
    assert len(CreativeDiary(diary_db).recent(limit=10)) == 2
