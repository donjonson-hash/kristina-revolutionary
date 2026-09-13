"""Regression: a conversational agreement must produce evidence before the reply."""

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import repository_dialogue as dialogue
from repository_evidence import source_excerpt

COMMIT = 'a' * 40
TARGET = f'https://github.com/example/project/blob/{COMMIT}/tests/schema.json'


def source(path, content):
    payload = content.encode()
    return {'path': path, 'content': content, 'sha256': hashlib.sha256(payload).hexdigest(),
            'blob_sha': hashlib.sha1(f'blob {len(payload)}\0'.encode() + payload).hexdigest(),
            'url': f'https://github.com/example/project/blob/{COMMIT}/{path}'}


@pytest.fixture
def inspection(monkeypatch):
    schema = {'$schema': 'http://json-schema.org/draft-07/schema#',
              'description': 'x' * 6000, 'definitions': {'invocation': {
                  'type': 'object', 'required': ['executionSuccessful'], 'properties': {
                      'startTimeUtc': {'type': 'string', 'format': 'date-time'},
                      'endTimeUtc': {'type': 'string', 'format': 'date-time'},
                      'executionSuccessful': {'type': 'boolean'}}}}}
    file = source('tests/schema.json', json.dumps(schema))
    snapshot = {'repository': 'example/project', 'commit': COMMIT, 'scope_kind': 'blob',
                'scope_path': file['path'], 'tree_truncated': False,
                'files': [{'path': file['path'], 'blob_sha': file['blob_sha'], 'size': len(file['content'].encode())}]}
    reader = SimpleNamespace(snapshot=AsyncMock(return_value=snapshot),
                             read_files=AsyncMock(return_value=[file]))
    client = SimpleNamespace(chat=AsyncMock(return_value=json.dumps({
        'decision': 'inspect', 'scope': 'target', 'query': 'invocation endTimeUtc startTimeUtc'})), close=AsyncMock())
    monkeypatch.setattr(dialogue, 'get_ai_client', lambda: client)
    return SimpleNamespace(reader=reader, client=client, file=file, snapshot=snapshot)


async def test_agreement_reads_schema_and_exposes_facts_beyond_excerpt(inspection):
    t = inspection
    evidence = await dialogue.inspect_followup(TARGET, 'Да, прочитай.', [
        {'role': 'assistant', 'content': 'Хочешь, прочитаю invocation?'}], reader=t.reader)
    t.reader.snapshot.assert_awaited_once_with(TARGET)
    t.reader.read_files.assert_awaited_once_with(t.snapshot, ['tests/schema.json'])
    data = json.loads(evidence.split('\n', 1)[1])
    fields = data['sources'][0]['schema_facts']['date_fields']
    assert {f['pointer'] for f in fields} == {
        '/definitions/invocation/properties/startTimeUtc', '/definitions/invocation/properties/endTimeUtc'}
    assert all(f['listed_in_parent_required'] is False for f in fields)
    assert all(f['type'] == 'string' and f['format'] == 'date-time' for f in fields)
    assert data['sources'][0]['excerpt_start'] > 5000
    t.client.close.assert_awaited_once()


async def test_repository_search_reads_selected_code_at_same_commit(inspection):
    t = inspection
    code = source('tests/test_sarif.py', '# unrelated code\n' * 1000 + '\ndef check(x):\n    jsonschema.validate(x, schema)\n')
    wide = {**t.snapshot, 'scope_kind': 'tree', 'scope_path': '',
            'files': t.snapshot['files'] + [{'path': code['path'], 'blob_sha': code['blob_sha'], 'size': len(code['content'])}]}
    t.reader.snapshot.side_effect = [t.snapshot, wide]
    t.reader.read_files.return_value = [code]
    t.client.chat.side_effect = [json.dumps({'decision': 'inspect', 'scope': 'repository', 'query': 'jsonschema validate'}),
                                 json.dumps({'paths': [code['path']]})]
    evidence = await dialogue.inspect_followup(TARGET, 'Поищи, как валидируется SARIF.', [], reader=t.reader)
    assert t.reader.snapshot.call_args_list[1].args == (f'https://github.com/example/project/tree/{COMMIT}',)
    t.reader.read_files.assert_awaited_once_with(wide, [code['path']])
    data = json.loads(evidence.split('\n', 1)[1])
    assert 'jsonschema.validate(x, schema)' in data['sources'][0]['excerpt']
    assert data['sources'][0]['excerpt_start'] > 5000
    assert data['commit'] == COMMIT


async def test_small_talk_does_not_read_or_schedule_work(inspection):
    t = inspection
    t.client.chat.return_value = '{"decision":"skip"}'
    assert await dialogue.inspect_followup(TARGET, 'Как настроение?', [], reader=t.reader) is None
    t.reader.snapshot.assert_not_awaited()
    t.reader.read_files.assert_not_awaited()
    t.client.close.assert_awaited_once()


@pytest.mark.parametrize('selection', [
    {'decision': 'inspect', 'scope': 'target', 'query': 'a', 'target': 'https://github.com/attacker/repo'},
    {'decision': 'execute', 'scope': 'target', 'query': 'python'},
    {'decision': 'inspect', 'scope': 'repository', 'query': 'a' * 301},
])
async def test_invalid_action_cannot_change_target_or_execute(inspection, selection):
    t = inspection
    t.client.chat.return_value = json.dumps(selection)
    with pytest.raises(ValueError):
        await dialogue.inspect_followup(TARGET, 'Продолжим', [], reader=t.reader)
    t.reader.snapshot.assert_not_awaited()
    t.client.close.assert_awaited_once()


@pytest.mark.parametrize('paths', [['.env'], ['../private.py'], ['tests/schema.json'] * 5, [42]])
async def test_only_paths_from_actual_tree_can_be_read(inspection, paths):
    t = inspection
    t.reader.snapshot.return_value = {**t.snapshot, 'scope_kind': 'tree', 'scope_path': ''}
    t.client.chat.side_effect = [json.dumps({'decision': 'inspect', 'scope': 'target', 'query': 'schema'}),
                                 json.dumps({'paths': paths})]
    with pytest.raises(ValueError):
        await dialogue.inspect_followup(TARGET, 'Прочитай', [], reader=t.reader)
    t.reader.read_files.assert_not_awaited()
    t.client.close.assert_awaited_once()


def test_schema_facts_do_not_invent_required_or_scan_example_data():
    file = source('schema.json', json.dumps({'type': 'object', 'required': ['date'],
        'properties': {'date': {'type': 'string', 'format': 'date'}},
        'examples': [{'properties': {'fake': {'format': 'date'}}}]}))
    fields = source_excerpt(file)['schema_facts']['date_fields']
    assert len(fields) == 1
    assert fields[0]['pointer'] == '/properties/date'
    assert fields[0]['listed_in_parent_required'] is True


def test_large_schema_fact_list_remains_bounded_and_reports_truncation():
    properties = {'date' + str(i) + 'x' * 500: {'type': 'string', 'format': 'date', 'description': 'd' * 300}
                  for i in range(100)}
    file = source('schema.json', json.dumps({'properties': properties}))
    facts = source_excerpt(file)['schema_facts']
    assert facts['fields_truncated'] is True
    assert len(json.dumps(facts, ensure_ascii=False)) < 13000
