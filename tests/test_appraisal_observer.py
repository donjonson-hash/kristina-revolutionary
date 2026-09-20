"""Observe the real validated appraisal path without changing ordinary behavior."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agents.router import AgentRouter
from brain_integration import BrainBridge
from cognitive_appraisal import Appraisal
from conversation_context import conversation_session_id
from emotional_core import EmotionalCore
from experiments import emotional_links
from experiments.appraisal_observer import AppraisalLinkObserver, AppraisalSource
from experiments.emotional_links import AXES, MAX_EVENTS, digest
from mood_engine import MoodEngine
from persistent_memory import PersistentMemory


DAY = datetime(2026, 9, 12, 10, tzinfo=timezone.utc)
TEXT = "Хочу сменить обстановку."
APPRAISAL = Appraisal("curiosity", 0.5, "сменить обстановку", "keep", "", "")
SESSION = '["telegram","1","1"]'


def source(event_id="turn-1", session=SESSION):
    return AppraisalSource.from_validated(
        APPRAISAL, user_input=TEXT, session_id=session, event_id=event_id,
    )


@pytest.fixture
def pipeline_factory(tmp_path, monkeypatch):
    import agents.kristina_persona as persona
    import cognitive_appraisal

    memories = []

    def make(name, *, observer=None, raw=None):
        now = [DAY]
        memory = PersistentMemory(str(tmp_path / f"{name}-memory.db"))
        memories.append(memory)
        core = EmotionalCore(tmp_path / f"{name}-emotion.db", clock=lambda: now[0],
                             appraisal_observer=observer)
        bridge = BrainBridge(emotional=core, memory=memory)
        client = SimpleNamespace(
            chat=AsyncMock(return_value=raw if raw is not None else json.dumps(asdict(APPRAISAL))),
            close=AsyncMock(),
        )
        monkeypatch.setattr(cognitive_appraisal, "get_ai_client", lambda: client)
        monkeypatch.setattr(persona, "get_brain_bridge", lambda: bridge)
        monkeypatch.setattr(persona, "mood_engine", MoodEngine(core))
        monkeypatch.setattr(MoodEngine, "get_delay", lambda *a, **k: 30)
        reply = AsyncMock(return_value="Можем подумать об этом.")
        monkeypatch.setattr(persona, "ai", SimpleNamespace(generate=reply))
        monkeypatch.setattr(persona, "asyncio", SimpleNamespace(sleep=AsyncMock()))
        router = AgentRouter(memory=memory)
        agent = persona.KristinaPersonaAgent()
        agent.use_brain_integration = True
        router.register_agent(agent, is_default=True)
        return SimpleNamespace(core=core, bridge=bridge, router=router,
                               client=client, reply=reply, now=now)

    yield make
    for memory in memories:
        memory.close()


def conversation(event_id="telegram:1"):
    return {"channel": "telegram", "user_id": 1, "chat_id": 1,
            "agent_id": "kristina", "event_id": event_id}


async def test_real_pipeline_uses_one_appraisal_and_preserves_baseline(pipeline_factory, monkeypatch):
    baseline = pipeline_factory("baseline")
    baseline.now[0] += timedelta(hours=3)
    reply = await baseline.router.process(TEXT, conversation())
    expected = baseline.core.get_emotional_state()
    baseline.client.chat.assert_awaited_once()
    baseline.reply.assert_awaited_once()

    observer = AppraisalLinkObserver()
    observed = pipeline_factory("observed", observer=observer)
    observed.now[0] += timedelta(hours=3)
    applied = []
    original = observed.core._apply_context_effects

    def capture(context):
        applied.append(context["appraisal"])
        return original(context)

    monkeypatch.setattr(observed.core, "_apply_context_effects", capture)
    assert (await observed.router.process(TEXT, conversation())).content == reply.content
    observed.client.chat.assert_awaited_once()
    observed.client.close.assert_awaited_once()
    observed.reply.assert_awaited_once()
    assert observed.core.get_emotional_state() == expected
    assert EmotionalCore(observed.core.db_path, clock=lambda: observed.now[0]).get_emotional_state() == expected
    [receipt] = observer.receipts
    assert len(applied) == 1
    assert receipt["event"]["provenance"]["appraisal_sha256"] == digest(asdict(applied[0]))
    assert receipt["event"]["provenance"]["session_sha256"] == digest(conversation_session_id(conversation()))
    assert receipt["event"]["source_kind"] == "validated_appraisal"
    assert receipt["event"]["source_ref"] == digest(TEXT)
    assert receipt["event"]["after"] == expected["state"]
    assert receipt["event"]["at"] == expected["updated_at"]
    circadian_only = EmotionalCore(clock=lambda: DAY)
    circadian_only._advance(observed.now[0], None)
    assert receipt["event"]["before"] == circadian_only.state
    assert receipt["direct_delta"]["curiosity"] == pytest.approx(0.015 + 0.04)
    assert receipt["direct_delta"]["energy"] == pytest.approx(-0.025)
    assert receipt["offset"]["creativity"] == pytest.approx(0.0275)
    assert expected["state"]["creativity"] == 0.6
    assert TEXT not in json.dumps(receipt, ensure_ascii=False)
    assert APPRAISAL.source_quote not in json.dumps(receipt, ensure_ascii=False)
    # Router's existing durable duplicate handling also bypasses appraisal/observation.
    assert (await observed.router.process(TEXT, conversation())).content == reply.content
    observed.client.chat.assert_awaited_once()
    assert observed.core.get_emotional_state() == expected
    assert observer.receipts == [receipt]


@pytest.mark.parametrize("raw", ["not JSON", json.dumps({**asdict(APPRAISAL), "source_quote": "invented"})])
async def test_invalid_model_output_has_no_observation(pipeline_factory, raw):
    observer = AppraisalLinkObserver()
    pipeline = pipeline_factory("invalid", observer=observer, raw=raw)
    await pipeline.router.process(TEXT, conversation())
    pipeline.client.chat.assert_awaited_once()
    assert observer.receipts == []
    assert pipeline.core.state["curiosity"] == pytest.approx(0.815)
    assert [e["event"] for e in pipeline.core.recent_experiences] == ["user_message"]


@pytest.mark.parametrize("session,event_id", [(None, "ok"), (SESSION, []), ("x" * 4097, "ok")])
async def test_missing_or_invalid_identity_does_not_change_ordinary_event(pipeline_factory, session, event_id):
    observer = AppraisalLinkObserver()
    pipeline = pipeline_factory("identity", observer=observer)
    result = await pipeline.bridge.process_signal(SimpleNamespace(content=TEXT), {
        "appraise_event": True, "session_id": session, "event_id": event_id,
    })
    assert observer.receipts == []
    assert result["emotion"]["state"]["curiosity"] == pytest.approx(0.855)
    pipeline.client.chat.assert_awaited_once()


async def test_sqlite_rollback_has_no_trace_then_retry_observes_committed_state(pipeline_factory, monkeypatch):
    observer = AppraisalLinkObserver()
    pipeline = pipeline_factory("rollback", observer=observer)
    before = pipeline.core.get_emotional_state()
    with sqlite3.connect(pipeline.core.db_path) as conn:
        conn.execute("""CREATE TRIGGER reject_write BEFORE INSERT ON emotional_state
                        BEGIN SELECT RAISE(ABORT, 'write rejected'); END""")
    pipeline.now[0] += timedelta(hours=2)
    context = {"appraise_event": True, "session_id": SESSION, "event_id": "turn-1"}
    with pytest.raises(sqlite3.IntegrityError):
        await pipeline.bridge.process_signal(SimpleNamespace(content=TEXT), context)
    assert observer.receipts == []
    assert pipeline.core.get_emotional_state() == before
    with sqlite3.connect(pipeline.core.db_path) as conn:
        conn.execute("DROP TRIGGER reject_write")
    observe = observer.observe

    def after_commit(source, **snapshot):
        # A separate SQLite reader must already see exactly this committed event.
        with sqlite3.connect(pipeline.core.db_path) as conn:
            saved = json.loads(conn.execute("SELECT payload FROM emotional_state").fetchone()[0])
        assert saved["state"] == snapshot["after"]
        assert saved["last_update"] == snapshot["at"].isoformat()
        return observe(source, **snapshot)

    monkeypatch.setattr(observer, "observe", after_commit)
    result = await pipeline.bridge.process_signal(SimpleNamespace(content=TEXT), context)
    assert len(observer.receipts) == 1
    assert observer.receipts[0]["event"]["after"] == result["emotion"]["state"]


@pytest.mark.parametrize("failure", ["worker", "verifier", "budget", "metadata"])
async def test_observer_failure_isolated_from_successful_pipeline(pipeline_factory, monkeypatch, failure):
    baseline = pipeline_factory("baseline")
    await baseline.router.process(TEXT, conversation())
    expected = baseline.core.get_emotional_state()
    observer = AppraisalLinkObserver(max_actions=0 if failure == "budget" else 16)
    pipeline = pipeline_factory("failed", observer=observer)
    if failure in {"worker", "verifier"}:
        def fail(*args):
            raise RuntimeError("failed observer computation")
        monkeypatch.setattr(emotional_links, "_transmit" if failure == "worker" else "_verify", fail)
    elif failure == "metadata":
        monkeypatch.setattr(AppraisalSource, "matches", lambda *args: False)
    assert (await pipeline.router.process(TEXT, conversation())).content
    assert pipeline.core.get_emotional_state() == expected
    assert observer.receipts == []
    assert observer._count == 0
    assert observer._streams == {}
    pipeline.client.chat.assert_awaited_once()
    pipeline.reply.assert_awaited_once()


def test_capture_reloads_persisted_state_and_serializes_threaded_events(tmp_path):
    observer = AppraisalLinkObserver()
    path = tmp_path / "state.db"
    core = EmotionalCore(path, clock=lambda: DAY, appraisal_observer=observer)
    other = EmotionalCore(path, clock=lambda: DAY)
    persisted = other.evolve({"negative_tone": True})
    context = {"appraisal": APPRAISAL, "user_message": True}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda i: core.evolve(context, observation=source(str(i))), range(8)))
    rows = observer.receipts
    assert len(rows) == len(results) == 8
    assert rows[0]["event"]["before"] == persisted["state"]
    for previous, current in zip(rows, rows[1:]):
        assert current["event"]["before"] == previous["event"]["after"]
        assert current["previous_receipt_sha256"] == previous["receipt_sha256"]
    assert rows[-1]["event"]["after"] == core.state


def test_exact_replay_conflicts_and_session_source_isolation():
    observer = AppraisalLinkObserver()
    before = dict.fromkeys(AXES, 0.5)
    after = {**before, "curiosity": 0.55}
    snapshot = dict(at=DAY, before=before, after=after)
    first = observer.observe(source(), **snapshot)
    original = deepcopy(first)
    first["event"]["after"]["curiosity"] = 1
    assert observer.observe(source(), **snapshot) == original
    for changed in (replace(source(), source_sha256="a" * 64),
                    replace(source(), appraisal_sha256="a" * 64)):
        with pytest.raises(ValueError, match="reused"):
            observer.observe(changed, **snapshot)
    with pytest.raises(ValueError, match="reused"):
        observer.observe(source(), at=DAY, before=before, after=before)
    for independent in (source(session="different-session"), replace(source(), source_id="different-source")):
        receipt = observer.observe(independent, **snapshot)
        assert receipt["offset"] == original["offset"]
        assert receipt["previous_receipt_sha256"] is None
    saved = observer.receipts
    observer.receipts[0]["offset"]["creativity"] = 999
    assert observer.receipts == saved


def test_conflicting_observation_never_deduplicates_ordinary_emotion():
    observer = AppraisalLinkObserver()
    core = EmotionalCore(clock=lambda: DAY, appraisal_observer=observer)
    baseline = EmotionalCore(clock=lambda: DAY)
    context = {"appraisal": APPRAISAL, "user_message": True}
    for _ in range(2):
        baseline.evolve(context)
        core.evolve(context, observation=source())
    assert core.get_emotional_state() == baseline.get_emotional_state()
    assert len(observer.receipts) == 1


def test_bounds_reject_without_eviction_and_allow_existing_retries():
    observer = AppraisalLinkObserver()
    state = dict.fromkeys(AXES, 0.5)
    snapshot = dict(at=DAY, before=state, after=state)
    original = observer.observe(source("0"), **snapshot)
    for i in range(1, MAX_EVENTS):
        observer.observe(source(str(i)), **snapshot)
    with pytest.raises(ValueError, match="event budget"):
        observer.observe(source("overflow"), **snapshot)
    assert len(observer.receipts) == MAX_EVENTS
    assert observer.observe(source("0"), **snapshot) == original
    streams = AppraisalLinkObserver()
    for i in range(16):
        streams.observe(source(session=str(i)), **snapshot)
    with pytest.raises(ValueError, match="stream budget"):
        streams.observe(source(session="overflow"), **snapshot)
    assert len(streams.receipts) == 16


@pytest.mark.parametrize("bad", [float("nan"), True, 1.1])
def test_malformed_snapshot_is_rejected_without_receipt(bad):
    observer = AppraisalLinkObserver()
    state = dict.fromkeys(AXES, 0.5)
    with pytest.raises(ValueError):
        observer.observe(source(), at=DAY, before=state, after={**state, "energy": bad})
    assert observer.receipts == []


def test_failed_in_memory_appraisal_rolls_back_time_state_and_trace():
    now = [DAY]
    observer = AppraisalLinkObserver()
    core = EmotionalCore(clock=lambda: now[0], appraisal_observer=observer)
    before = core.get_emotional_state()
    now[0] += timedelta(hours=2)
    with pytest.raises(ValueError):
        core.evolve({"appraisal": replace(APPRAISAL, intensity=float("nan")), "user_message": True},
                    observation=source())
    assert core.get_emotional_state() == before
    assert observer.receipts == []


def test_singleton_observer_requires_explicit_enable(monkeypatch):
    import emotional_core
    monkeypatch.delenv("KRISTINA_EMOTIONAL_LINKS_OBSERVER", raising=False)
    assert emotional_core.get_emotional_core().appraisal_observer is None
    monkeypatch.setattr(emotional_core, "_emotional_core", None)
    monkeypatch.setenv("KRISTINA_EMOTIONAL_LINKS_OBSERVER", "1")
    assert isinstance(emotional_core.get_emotional_core().appraisal_observer, AppraisalLinkObserver)
