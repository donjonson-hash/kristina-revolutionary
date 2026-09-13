"""Immutable evidence, URL scope, and bounded GitHub transport checks."""
import asyncio
import base64
import hashlib
import json

import httpx
import pytest

import repository_research as research
from repository_research import RepositoryReader, ResearchReadError, extract_research_target, search_paths

COMMIT = 'a' * 40
BODY = b'{"type":"string","format":"date-time"}\n'


def blob_sha(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def entry(path='tests/schema.json', raw=BODY, mode='100644'):
    return {'path': path, 'mode': mode, 'type': 'blob', 'sha': blob_sha(raw), 'size': len(raw)}


def harness(monkeypatch, entries=None, raw=BODY, overrides=None):
    requests = []
    overrides = overrides or {}
    def handle(request):
        requests.append(request)
        path = request.url.path
        if path in overrides:
            response = overrides[path]
            return response(request) if callable(response) else httpx.Response(200, json=response)
        if path == '/repos/acme/repo':
            return httpx.Response(200, json={'private': False, 'default_branch': 'main'})
        if path.startswith('/repos/acme/repo/commits/'):
            return httpx.Response(200, json={'sha': COMMIT})
        if path == f'/repos/acme/repo/git/trees/{COMMIT}':
            return httpx.Response(200, json={'tree': entries if entries is not None else [entry()], 'truncated': False})
        if path.startswith('/repos/acme/repo/git/blobs/'):
            return httpx.Response(200, json={'sha': blob_sha(raw), 'size': len(raw), 'encoding': 'base64', 'content': base64.b64encode(raw).decode()})
        pytest.fail(f'Unexpected request: {request.url}')
    real = httpx.AsyncClient
    def factory(**kwargs):
        return real(transport=httpx.MockTransport(handle), **kwargs)
    monkeypatch.setattr(research.httpx, 'AsyncClient', factory)
    return requests


@pytest.mark.parametrize('url', [
    'https://github.com/acme/repo.git',
    'https://github.com/acme/repo/tree/main/tests/fixtures',
    f'https://github.com/acme/repo/blob/{COMMIT}/tests/schema.json',
])
def test_extract_preserves_complete_scope(url):
    assert extract_research_target('Проверь ' + url + ' пожалуйста') == url


@pytest.mark.parametrize('url', [
    'http://github.com/acme/repo', 'https://github.com.evil/acme/repo',
    'https://user@github.com/acme/repo', 'https://github.com:443/acme/repo',
    'https://github.com/acme/repo?download=1', 'https://github.com/acme/repo#x',
    'https://github.com/acme/repo/tree/main/../secret.json',
    'https://github.com/acme/repo/tree/main/%2e%2e/secret.json',
    'https://github.com/acme/repo/tree/main/tests%2fschema.json',
    'https://github.com/acme/repo/tree/main/tests\\secret.json',
    'https://github.com/acme/repo/blob/main', 'https://github.com/acme/repo/issues/3',
])
def test_extract_rejects_ambiguous_or_unsafe_targets(url):
    assert extract_research_target(url) is None


def test_pin_commit_and_blob_even_when_branch_moves(monkeypatch):
    requests = harness(monkeypatch)
    async def run():
        reader = RepositoryReader(token='test-token')
        snapshot = await reader.snapshot('https://github.com/acme/repo/tree/main/tests')
        # Subsequent reads do not resolve main again: its new head is irrelevant.
        evidence = await reader.read_files(snapshot, ['tests/schema.json'])
        assert snapshot['commit'] == COMMIT
        assert evidence == [{'path': 'tests/schema.json', 'blob_sha': blob_sha(BODY),
                             'sha256': hashlib.sha256(BODY).hexdigest(), 'content': BODY.decode(),
                             'url': f'https://github.com/acme/repo/blob/{COMMIT}/tests/schema.json'}]
    asyncio.run(run())
    paths = [r.url.path for r in requests]
    assert paths.count('/repos/acme/repo/commits/main') == 1
    assert f'/repos/acme/repo/git/trees/{COMMIT}' in paths
    assert f'/repos/acme/repo/git/blobs/{blob_sha(BODY)}' in paths
    assert all(r.url.host == 'api.github.com' and r.method == 'GET' for r in requests)
    assert all(r.headers['Authorization'] == 'Bearer test-token' for r in requests)


@pytest.mark.parametrize('scope,expected', [
    ('tree/main/tests', ['tests/schema.json']),
    ('blob/main/app/report.py', ['app/report.py']),
])
def test_explicit_scope_cannot_read_siblings(monkeypatch, scope, expected):
    harness(monkeypatch, entries=[entry(), entry('tests_other/other.json'), entry('app/report.py')])
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo/' + scope)
        assert search_paths(snapshot) == expected
        with pytest.raises(ResearchReadError, match='outside'):
            await reader.read_files(snapshot, ['tests_other/other.json'])
    asyncio.run(run())


def test_secrets_dependencies_symlinks_and_binaries_not_candidates(monkeypatch):
    excluded = ['.env', '.env.example', 'keys/private_key.json', 'config/credentials.json',
                '.aws/config.json', 'secrets/token.txt', 'node_modules/a/test.js',
                'photo.png', 'package-lock.lock']
    entries = [entry()] + [entry(p) for p in excluded] + [entry('linked.json', mode='120000')]
    entries.append({'path': 'submodule', 'type': 'commit', 'mode': '160000', 'sha': COMMIT})
    harness(monkeypatch, entries=entries)
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        assert search_paths(snapshot) == ['tests/schema.json']
        for path in excluded + ['linked.json']:
            with pytest.raises(ResearchReadError):
                await reader.read_files(snapshot, [path])
    asyncio.run(run())


@pytest.mark.parametrize('private', [True, None])
def test_private_or_unknown_visibility_rejected(monkeypatch, private):
    requests = harness(monkeypatch, overrides={'/repos/acme/repo': {'private': private, 'default_branch': 'main'}})
    with pytest.raises(ResearchReadError, match='public'):
        asyncio.run(RepositoryReader().snapshot('https://github.com/acme/repo'))
    assert len(requests) == 1


def test_redirect_is_not_followed(monkeypatch):
    requests = harness(monkeypatch, overrides={'/repos/acme/repo': lambda request: httpx.Response(302, headers={'Location': 'https://evil.example/steal'})})
    with pytest.raises(ResearchReadError, match='302'):
        asyncio.run(RepositoryReader(token='secret').snapshot('https://github.com/acme/repo'))
    assert len(requests) == 1


@pytest.mark.parametrize('raw', [b'not same body', b'\xff', b'binary\0text'])
def test_integrity_and_utf8_fail_closed(monkeypatch, raw):
    # Invalid UTF-8/NUL use matching hashes: text checks must still reject them.
    tree_raw = BODY if raw == b'not same body' else raw
    harness(monkeypatch, entries=[entry(raw=tree_raw)], raw=raw)
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        with pytest.raises(ResearchReadError):
            await reader.read_files(snapshot, ['tests/schema.json'])
    asyncio.run(run())


def test_same_size_corruption_fails_git_hash(monkeypatch):
    raw = BODY.replace(b'string', b'object')
    harness(monkeypatch, raw=raw)
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        with pytest.raises(ResearchReadError, match='integrity'):
            await reader.read_files(snapshot, ['tests/schema.json'])
    asyncio.run(run())


def test_full_schema_not_silently_truncated(monkeypatch):
    raw = json.dumps({'description': 'x' * 200000, 'type': 'string'}).encode()
    harness(monkeypatch, entries=[entry(raw=raw)], raw=raw)
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        evidence = await reader.read_files(snapshot, ['tests/schema.json'])
        assert evidence[0]['content'].encode() == raw
        assert json.loads(evidence[0]['content'])['type'] == 'string'
    asyncio.run(run())


@pytest.mark.parametrize('count,size', [(1, 300 * 1024 + 1), (3, 280 * 1024), (5, 1)])
def test_file_total_and_count_bounds_before_blob_fetch(monkeypatch, count, size):
    entries = [dict(entry(f'tests/{i}.json'), size=size) for i in range(count)]
    requests = harness(monkeypatch, entries=entries)
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        with pytest.raises(ResearchReadError):
            await reader.read_files(snapshot, [e['path'] for e in entries])
    asyncio.run(run())
    assert not any('/git/blobs/' in r.url.path for r in requests)


def test_truncated_tree_disclosed_and_not_used_for_evidence(monkeypatch):
    harness(monkeypatch, overrides={f'/repos/acme/repo/git/trees/{COMMIT}': {'tree': [entry()], 'truncated': True}})
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        assert snapshot['tree_truncated'] is True
        with pytest.raises(ResearchReadError, match='truncated'):
            await reader.read_files(snapshot, ['tests/schema.json'])
    asyncio.run(run())


def test_5000_path_cap_is_disclosed(monkeypatch):
    harness(monkeypatch, entries=[entry(f'tests/{i:05}.json') for i in range(5001)])
    snapshot = asyncio.run(RepositoryReader().snapshot('https://github.com/acme/repo'))
    assert len(snapshot['files']) == 5000 and snapshot['tree_truncated']


def test_streamed_response_cap_stops_early(monkeypatch):
    class Stream(httpx.AsyncByteStream):
        chunks = 0
        async def __aiter__(self):
            for _ in range(9):
                self.chunks += 1
                yield b' ' * (1024 * 1024)
    stream = Stream()
    harness(monkeypatch, overrides={'/repos/acme/repo': lambda request: httpx.Response(200, stream=stream)})
    with pytest.raises(ResearchReadError, match='6 MiB'):
        asyncio.run(RepositoryReader().snapshot('https://github.com/acme/repo'))
    assert stream.chunks == 7


def test_network_timeout_returns_no_partial_result(monkeypatch):
    def fail(request):
        raise httpx.ReadTimeout('timeout', request=request)
    harness(monkeypatch, overrides={f'/repos/acme/repo/git/blobs/{blob_sha(BODY)}': fail})
    async def run():
        reader = RepositoryReader()
        snapshot = await reader.snapshot('https://github.com/acme/repo')
        with pytest.raises(httpx.ReadTimeout):
            await reader.read_files(snapshot, ['tests/schema.json'])
    asyncio.run(run())


def test_path_search_is_bounded_and_relevance_ordered(monkeypatch):
    harness(monkeypatch, entries=[entry('readme.md'), entry('tests/sarif_schema.json'), entry('app/validation.py')])
    snapshot = asyncio.run(RepositoryReader().snapshot('https://github.com/acme/repo'))
    assert search_paths(snapshot, 'validation', limit=1) == ['app/validation.py']
    assert search_paths(snapshot)[0] == 'tests/sarif_schema.json'
    with pytest.raises(ResearchReadError):
        search_paths(snapshot, limit=121)
