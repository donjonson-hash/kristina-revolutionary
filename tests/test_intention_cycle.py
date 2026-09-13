"""Exercise restart, source cancellation and cross-database delivery boundaries."""

import asyncio
import json
import sqlite3
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from cognitive_appraisal import Appraisal
from emotional_core import EmotionalCore
from intention_cycle import IntentionStore, IntentionWorker, PLANNING_INTERVAL, REFLECTION_PAUSE
from persistent_memory import PersistentMemory

DAY = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
SOURCE = 'Давай проверим валидацию дат.'
INTEREST = Appraisal('curiosity', .5, 'валидацию дат', 'replace',
                    'Календарная валидация', 'Хочу проверить границы формата даты.')
PLAN = {'kind': 'calendar_validation', 'hypothesis': 'format_implies_calendar_validity',
        'rationale': 'Проверить, хватает ли формата.',
        'cases': [{'value': '2024-02-30', 'expected_valid': False}]}


def seed(memory, session='own'):
    memory.save_exchange(session, SOURCE, 'Есть идея проверки.', appraisal=INTEREST)


async def test_availability_explains_actual_pause_and_shared_budget_without_other_data(cycle):
    from intention_cycle import research_status
    c = cycle
    before = c.store.availability('own', DAY)
    assert before['status'] == 'not_scheduled' and before['blockers'] == []
    await c.worker.tick()
    own = c.store.availability('own', DAY)
    assert own['status'] == 'planned' and own['blockers'] == ['reflection_pause']
    other = c.store.availability('other', DAY)
    assert set(other['blockers']) == {'no_saved_interest', 'worker_busy', 'planning_cooldown'}
    assert other['next_planning_at'] == (DAY + PLANNING_INTERVAL).isoformat()
    report = research_status(None, other, {'is_night': True, 'state': {'energy': .2, 'curiosity': .3}})
    assert 'шесть часов' in report and 'Ночью' in report and 'энергии' in report
    assert SOURCE not in report and PLAN['rationale'] not in report
    c.planner.assert_awaited_once()  # reporting never schedules another job


@pytest.mark.parametrize('status', ['completed', 'failed', 'declined', 'cancelled'])
def test_terminal_research_status_does_not_promise_another_step(status):
    from intention_cycle import availability_text
    text = availability_text({'status': status, 'blockers': [], 'next_planning_at': None})
    assert 'Ожидается следующий шаг' not in text


@pytest.fixture
def cycle(persistent_memory, tmp_path):
    from types import SimpleNamespace
    clock = SimpleNamespace(now=DAY)
    core = EmotionalCore(tmp_path / 'state.db', clock=lambda: clock.now)
    planner = AsyncMock(return_value=PLAN)
    locks = defaultdict(asyncio.Lock)
    worker = IntentionWorker(persistent_memory, core, lambda session: locks[session],
                             planner=planner, clock=lambda: clock.now)
    seed(persistent_memory)
    return SimpleNamespace(memory=persistent_memory, core=core, planner=planner, worker=worker,
                           store=worker.store, clock=clock, locks=locks)


async def test_plan_pause_restart_real_result_and_one_emotional_effect(cycle):
    c = cycle
    await c.worker.tick()
    planned = c.store.get_current('own')
    assert planned['status'] == 'planned' and planned['result'] is None
    assert c.store.pending_emotion() is None
    c.clock.now += REFLECTION_PAUSE - timedelta(seconds=1)
    await c.worker.tick()
    assert c.store.get_current('own')['status'] == 'planned'
    c.memory.close()
    reopened = PersistentMemory(c.memory.db_path)
    try:
        fresh = IntentionWorker(reopened, c.core, lambda s: c.locks[s],
                                planner=c.planner, clock=lambda: c.clock.now)
        c.clock.now += timedelta(seconds=1)
        await fresh.tick()
        result = fresh.store.get_current('own')
        assert result['status'] == 'completed'
        assert result['result']['outcome'] == 'counterexample_found'
        assert result['result']['cases'][0]['format_valid'] is True
        assert result['result']['cases'][0]['calendar_valid'] is False
        assert result['emotion_applied'] == 1
        state = c.core.get_emotional_state()
        await fresh.tick()
        assert c.core.get_emotional_state() == state
        assert not c.core.recent_experiences  # work is not a user message
        c.planner.assert_awaited_once()
    finally:
        reopened.close()


@pytest.mark.parametrize('outcome', [None, ValueError('invalid model JSON')])
async def test_skip_or_failure_is_terminal_for_revision_and_spends_durable_budget(cycle, outcome):
    c = cycle
    if isinstance(outcome, Exception):
        c.planner.side_effect = outcome
    else:
        c.planner.return_value = outcome
    await c.worker.tick()
    row = c.store.get_current('own')
    assert row['status'] == ('failed' if outcome else 'declined')
    assert row['result'] is None
    seed(c.memory, 'another')
    c.clock.now += timedelta(hours=5)
    await c.worker.tick()
    c.planner.assert_awaited_once()
    c.clock.now += timedelta(hours=1)
    await c.worker.tick()
    assert c.planner.await_count == 2
    assert c.store.get_current('another')['status'] == row['status']


@pytest.mark.parametrize('change', ['clear', 'replace', 'close'])
async def test_source_change_while_planner_awaits_cannot_resurrect_intention(cycle, change):
    c = cycle
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed(*args, **kwargs):
        entered.set()
        await release.wait()
        return PLAN

    c.worker.planner = delayed
    task = asyncio.create_task(c.worker.tick())
    await entered.wait()
    # Must be obtainable while the model runs, as in the Telegram /clear handler.
    async with asyncio.timeout(1):
        async with c.locks['own']:
            if change == 'clear':
                c.memory.clear_user('own')
            elif change == 'replace':
                seed(c.memory)
            else:
                closed = Appraisal('neutral', 0, 'закроем тему', 'clear', '', '')
                c.memory.save_exchange('own', 'закроем тему', 'Хорошо.', appraisal=closed)
    release.set()
    await task
    assert c.store.get_current('own') is None
    assert c.store.pending_emotion() is None
    rows = c.memory._get_connection().execute('SELECT status FROM agent_intentions').fetchall()
    assert [r[0] for r in rows] == ([] if change == 'clear' else ['cancelled'])


async def test_clear_deletes_completed_result_and_pending_emotion_but_preserves_budget(cycle):
    c = cycle
    await c.worker.tick()
    row = c.store.get_current('own')
    c.clock.now += REFLECTION_PAUSE
    c.store.complete(row['id'], c.clock.now)
    assert c.store.pending_emotion()
    c.memory.clear_user('own')
    seed(c.memory, 'another')
    await c.worker.tick()
    assert c.store.pending_emotion() is None
    assert c.store.get_current('another') is None
    c.planner.assert_awaited_once()
    with sqlite3.connect(c.core.db_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM experiment_effects').fetchone()[0] == 0


async def test_crash_after_emotion_commit_before_ack_is_recovered_once(cycle, monkeypatch):
    c = cycle
    await c.worker.tick()
    c.clock.now += REFLECTION_PAUSE
    row = c.store.get_current('own')
    c.store.complete(row['id'], c.clock.now)
    original = c.store.acknowledge_emotion
    monkeypatch.setattr(c.store, 'acknowledge_emotion', lambda _: (_ for _ in ()).throw(RuntimeError('crash')))
    with pytest.raises(RuntimeError):
        await c.worker.deliver_emotion()
    state = c.core.get_emotional_state()
    assert c.store.pending_emotion()
    fresh_core = EmotionalCore(c.core.db_path, clock=lambda: c.clock.now)
    c.worker.core = fresh_core
    monkeypatch.setattr(c.store, 'acknowledge_emotion', original)
    await c.worker.deliver_emotion()
    assert fresh_core.get_emotional_state() == state
    assert c.store.pending_emotion() is None
    with sqlite3.connect(c.core.db_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM experiment_effects').fetchone()[0] == 1


async def test_clear_while_emotion_delivery_waits_for_session_lock(cycle):
    c = cycle
    await c.worker.tick()
    c.clock.now += REFLECTION_PAUSE
    c.store.complete(c.store.get_current('own')['id'], c.clock.now)
    async with c.locks['own']:
        task = asyncio.create_task(c.worker.deliver_emotion())
        await asyncio.sleep(0)
        c.memory.clear_user('own')
    await task
    with sqlite3.connect(c.core.db_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM experiment_effects').fetchone()[0] == 0


def test_interrupted_planning_is_not_retried_after_restart(cycle):
    c = cycle
    claim = c.store.claim(DAY)
    c.memory.close()
    fresh = PersistentMemory(c.memory.db_path)
    try:
        store = IntentionStore(fresh)
        store.maintain(DAY + timedelta(minutes=3))
        assert store.get_current('own')['status'] == 'failed'
        assert store.claim(DAY + PLANNING_INTERVAL) is None
        assert not store.finish_plan(claim['id'], PLAN, DAY + timedelta(minutes=3))
    finally:
        fresh.close()


def test_competing_connections_claim_only_one_intention(cycle):
    c = cycle
    seed(c.memory, 'another')

    def claim():
        memory = PersistentMemory(c.memory.db_path)
        try:
            return IntentionStore(memory).claim(DAY)
        finally:
            memory.close()

    with ThreadPoolExecutor(max_workers=3) as pool:
        claims = list(pool.map(lambda _: claim(), range(3)))
    assert sum(claim is not None for claim in claims) == 1


async def test_transaction_failure_never_publishes_a_result(cycle):
    c = cycle
    await c.worker.tick()
    c.clock.now += REFLECTION_PAUSE
    row = c.store.get_current('own')
    conn = c.memory._get_connection()
    conn.execute("""CREATE TRIGGER reject_completion BEFORE UPDATE ON agent_intentions
        WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'disk failure'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        c.store.complete(row['id'], c.clock.now)
    assert c.store.get_current('own')['result'] is None
    assert c.store.pending_emotion() is None
    conn.execute('DROP TRIGGER reject_completion')
    assert c.store.complete(row['id'], c.clock.now)
    assert not c.store.complete(row['id'], c.clock.now)


async def test_invalid_persisted_plan_fails_without_emotion(cycle):
    c = cycle
    await c.worker.tick()
    conn = c.memory._get_connection()
    with conn:
        conn.execute('UPDATE agent_intentions SET plan=?', (json.dumps({'code': 'raise SystemExit'}),))
    c.clock.now += REFLECTION_PAUSE
    await c.worker.tick()
    row = c.store.get_current('own')
    assert row['status'] == 'failed' and row['result'] is None
    assert c.store.pending_emotion() is None


@pytest.mark.parametrize('state', [{'is_night': True}, {'energy': .2}, {'curiosity': .3}])
async def test_rest_or_low_interest_defers_work_without_spending_budget(cycle, monkeypatch, state):
    c = cycle
    snapshot = c.core.get_emotional_state()
    snapshot['is_night'] = state.get('is_night', False)
    snapshot['state'].update({k: v for k, v in state.items() if k != 'is_night'})
    monkeypatch.setattr(c.core, 'evolve', lambda: snapshot)
    await c.worker.tick()
    c.planner.assert_not_awaited()
    assert c.store.get_current('own') is None
    assert c.memory._get_connection().execute('SELECT * FROM agent_work_budget').fetchone() is None


async def test_result_is_scoped_to_source_conversation_and_revision(cycle):
    c = cycle
    await c.worker.tick()
    c.clock.now += REFLECTION_PAUSE
    await c.worker.tick()
    assert c.store.get_current('own')['result']
    assert c.store.get_current('another') is None
    seed(c.memory)
    assert c.store.get_current('own') is None
