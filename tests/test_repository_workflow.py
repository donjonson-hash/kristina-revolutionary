"""Full repository selection -> durable plan -> real subprocess -> scoped report."""

import asyncio
import json
import sqlite3
from collections import defaultdict
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import research_planner
from emotional_core import EmotionalCore
from intention_cycle import (IntentionStore, IntentionWorker, REFLECTION_PAUSE, PLANNING_INTERVAL,
                             init_tables, intention_context, research_status, research_target)
from research_planner import ResearchProposal, choose_repository_experiment
from tests.test_intention_cycle import DAY, seed, PLAN
from tests.test_schema_experiment import plan_for

TARGET = 'https://github.com/example/project'


@pytest.fixture
def repository_memory(persistent_memory):
    persistent_memory.save_exchange('own', TARGET, 'Вижу репозиторий.')
    seed(persistent_memory)
    return persistent_memory


@pytest.fixture
def selected_sources(monkeypatch):
    plan = plan_for()
    source = plan['schema']
    snapshot = {'repository': source['repository'], 'commit': source['commit'],
                'scope_kind': 'repo', 'scope_path': '', 'tree_truncated': False,
                'files': [{'path': source['path'], 'blob_sha': source['blob_sha'],
                           'size': len(source['content'].encode())}]}
    file = {k:v for k,v in source.items() if k not in ('repository', 'commit')}
    reader = SimpleNamespace(snapshot=AsyncMock(return_value=snapshot), read_files=AsyncMock(return_value=[file]))
    answers = [json.dumps({'decision': 'read', 'paths': [source['path']]}),
               json.dumps({'decision': 'experiment', 'schema_path': source['path'],
                           'pointer': plan['pointer'], 'rationale': plan['rationale'], 'cases': plan['cases']})]
    client = SimpleNamespace(chat=AsyncMock(side_effect=answers), close=AsyncMock())
    monkeypatch.setattr(research_planner, 'get_ai_client', lambda: client)
    return reader, client, plan


async def test_model_selects_real_file_and_field_without_supplied_source_bytes(selected_sources):
    reader, client, plan = selected_sources
    proposal = await choose_repository_experiment({'topic': 'JSON Schema dates'}, TARGET, now=DAY, reader=reader)
    assert proposal.plan == plan
    assert proposal.evidence['commit'] == plan['schema']['commit']
    assert proposal.evidence['sources'][0]['sha256'] == plan['schema']['sha256']
    assert client.chat.await_count == 2
    client.close.assert_awaited_once()
    reader.read_files.assert_awaited_once()


@pytest.mark.parametrize('response', [
    {'decision': 'read', 'paths': ['../../.env']},
    {'decision': 'read', 'paths': ['unseen.json']},
    {'decision': 'read', 'paths': []},
])
async def test_model_cannot_choose_unobserved_file(selected_sources, response):
    reader, client, _ = selected_sources
    client.chat.side_effect = [json.dumps(response)]
    with pytest.raises(ValueError):
        await choose_repository_experiment({}, TARGET, reader=reader)
    reader.read_files.assert_not_awaited()
    client.close.assert_awaited_once()


async def test_skip_does_not_download_files_or_call_model_again(selected_sources):
    reader, client, _ = selected_sources
    client.chat.side_effect = ['{"decision":"skip"}']
    assert await choose_repository_experiment({}, TARGET, reader=reader) is None
    reader.read_files.assert_not_awaited()
    client.chat.assert_awaited_once()


async def test_repository_cycle_survives_restart_and_returns_real_observations(repository_memory, selected_sources, tmp_path):
    memory = repository_memory
    reader, client, plan = selected_sources
    time = SimpleNamespace(now=DAY)
    core = EmotionalCore(tmp_path / 'emotion.db', clock=lambda: time.now)
    locks = defaultdict(asyncio.Lock)
    async def planner(interest, target, now):
        return await choose_repository_experiment(interest, target, now, reader=reader)
    worker = IntentionWorker(memory, core, lambda s: locks[s], clock=lambda: time.now, repository_planner=planner)
    await worker.tick()
    row = worker.store.get_current('own')
    assert row['status'] == 'planned' and row['plan'] == plan
    memory.close()
    from persistent_memory import PersistentMemory
    reopened = PersistentMemory(memory.db_path)
    try:
        worker = IntentionWorker(reopened, core, lambda s: locks[s], clock=lambda: time.now,
                                 repository_planner=AsyncMock(side_effect=AssertionError('must not replan')))
        time.now += REFLECTION_PAUSE
        await worker.tick()
        row = worker.store.get_current('own')
        assert row['status'] == 'completed' and row['emotion_applied'] == 1
        assert row['result']['counterexamples'] == 1
        report = research_status(row)
        assert '2023-02-29' in report and 'FormatChecker=False' in report
        assert plan['schema']['url'] in report
        prompt = intention_context(row)
        assert 'counterexample_found' in prompt and 'excerpt_truncated' in prompt
        assert '"content":' not in prompt  # full schema stays in storage, not every reply
        assert worker.store.get_current('another') is None
    finally:
        reopened.close()


@pytest.mark.parametrize('change', ['clear', 'new_url'])
async def test_source_change_during_subprocess_cannot_publish_stale_result(repository_memory, tmp_path, change):
    from schema_experiment import run_schema_experiment
    memory = repository_memory
    plan = plan_for()
    core = EmotionalCore(tmp_path / 'emotion.db', clock=lambda: DAY)
    locks = defaultdict(asyncio.Lock)
    entered, release = asyncio.Event(), asyncio.Event()
    store = IntentionStore(memory)
    claim = store.claim(DAY)
    store.finish_plan(claim['id'], plan, DAY)
    actual = await run_schema_experiment(plan)
    async def delayed(plan):
        entered.set()
        await release.wait()
        return actual
    worker = IntentionWorker(memory, core, lambda s: locks[s],
                             clock=lambda: DAY + REFLECTION_PAUSE, schema_runner=delayed)
    task = asyncio.create_task(worker.tick())
    await entered.wait()
    async with asyncio.timeout(1):
        async with locks['own']:
            if change == 'clear':
                memory.clear_user('own')
            else:
                memory.save_exchange('own', 'https://github.com/example/new', 'Новый источник.')
    release.set()
    await task
    assert store.get_current('own') is None
    assert store.pending_emotion() is None
    with sqlite3.connect(core.db_path) as conn:
        assert conn.execute('SELECT count(*) FROM experiment_effects').fetchone()[0] == 0


def test_new_repository_with_same_interest_gets_a_new_budgeted_attempt(repository_memory):
    m = repository_memory
    store = IntentionStore(m)
    first = store.claim(DAY)
    store.finish_plan(first['id'], None, DAY)
    m.save_exchange('own', 'https://github.com/example/new', 'Да.')
    assert store.claim(DAY + timedelta(minutes=1)) is None
    second = store.claim(DAY + PLANNING_INTERVAL)
    assert second['id'] != first['id'] and second['research_target'].endswith('/new')


def test_only_user_source_in_own_session_selects_repository(repository_memory):
    m = repository_memory
    m.save_message('own', 'assistant', 'https://github.com/example/forged')
    m.save_exchange('other', 'https://github.com/example/other', 'Да.')
    assert research_target(m, 'own')['url'] == TARGET
    assert research_target(m, 'anonymous') is None
    m.clear_user('own')
    assert research_target(m, 'own') is None


@pytest.mark.parametrize('corrupt', ['[1]', 'null', '{broken'])
async def test_corrupt_plan_becomes_terminal_and_frees_global_slot(repository_memory, tmp_path, corrupt):
    m = repository_memory
    store = IntentionStore(m)
    claim = store.claim(DAY)
    store.finish_plan(claim['id'], plan_for(), DAY)
    with m._get_connection() as conn:
        conn.execute('UPDATE agent_intentions SET plan=?', (corrupt,))
    worker = IntentionWorker(m, EmotionalCore(clock=lambda: DAY), lambda s: asyncio.Lock(),
                             clock=lambda: DAY + REFLECTION_PAUSE)
    await worker.tick()
    row = m._get_connection().execute('SELECT status,reason FROM agent_intentions').fetchone()
    assert tuple(row) == ('failed', 'invalid_plan')


@pytest.mark.parametrize('status', ['planned', 'completed'])
def test_pr21_migration_preserves_existing_experiment_in_a_repo_conversation(repository_memory, status):
    m = repository_memory
    source_id = m.get_interest('own')['source_message_id']
    conn = m._get_connection()
    with conn:
        conn.execute('DROP TABLE agent_intentions')
        conn.execute('''CREATE TABLE agent_intentions (
            id TEXT PRIMARY KEY, session_id TEXT, source_message_id INTEGER, status TEXT,
            created_at TEXT, due_at TEXT, updated_at TEXT,plan TEXT,result TEXT,reason TEXT,
            emotion_applied INTEGER DEFAULT 0, UNIQUE(session_id,source_message_id))''')
        conn.execute('''INSERT INTO agent_intentions VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
                     ('a'*32,'own',source_id,status,DAY.isoformat(),(DAY+REFLECTION_PAUSE).isoformat(),
                      DAY.isoformat(),json.dumps(PLAN),None,None,1 if status == 'completed' else 0))
    init_tables(conn)
    row = IntentionStore(m).get_current('own')
    assert row['status'] == status and row['plan'] == PLAN
    assert row['research_target'] == TARGET
    assert row['emotion_applied'] == (1 if status == 'completed' else 0)
    init_tables(conn)
    assert IntentionStore(m).get_current('own') == row


def test_repeating_same_link_preserves_work(repository_memory):
    m = repository_memory
    store = IntentionStore(m)
    before = research_target(m, 'own')
    claim = store.claim(DAY)
    store.finish_plan(claim['id'], plan_for(), DAY)
    m.save_exchange('own', 'Как проверка ' + TARGET, 'Продолжаю.')
    assert research_target(m, 'own') == before
    store.maintain(DAY + timedelta(minutes=1))
    assert store.get_current('own')['status'] == 'planned'


async def test_research_command_reads_own_saved_report_without_spending(repository_memory, monkeypatch):
    monkeypatch.setenv('KRISTINA_TELEGRAM_TOKEN', '12345:test-not-a-real-token')
    import bot
    from agents.router import AgentRouter
    from conversation_context import conversation_session_id
    from schema_experiment import run_schema_experiment
    m = repository_memory
    own = conversation_session_id({'channel':'telegram', 'chat_id':1, 'user_id':1})
    m.clear_user('own')
    m.save_exchange(own, TARGET, 'Да.')
    seed(m, own)
    store = IntentionStore(m)
    claim = store.claim(DAY)
    plan = plan_for()
    store.finish_plan(claim['id'], plan, DAY)
    store.start_run(claim['id'], DAY + REFLECTION_PAUSE)
    store.finish_run(claim['id'], await run_schema_experiment(plan), DAY + REFLECTION_PAUSE)
    monkeypatch.setattr(bot, 'router', AgentRouter(memory=m))
    send = AsyncMock()
    update = SimpleNamespace(effective_user=SimpleNamespace(id=1),
                             effective_chat=SimpleNamespace(id=1),
                             message=SimpleNamespace(reply_text=send))
    before = m.get_stats()['total_messages']
    await bot.research_command(update, None)
    assert '2023-02-29' in send.call_args.args[0]
    assert m.get_stats()['total_messages'] == before
    update.effective_user.id = update.effective_chat.id = 2
    await bot.research_command(update, None)
    assert '2023-02-29' not in send.call_args.args[0]
