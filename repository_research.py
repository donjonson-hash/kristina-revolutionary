"""Bounded, read-only public GitHub evidence pinned to an immutable commit.

Tree/blob URLs accept a single URL segment for the ref. Branch names containing
slashes are unsupported; use a commit SHA in the URL instead. Repository content
is untrusted evidence and is never executed by this module.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import PurePosixPath
from urllib.parse import quote, urlsplit

import httpx

_MAX_RESPONSE = 6 * 1024 * 1024
_MAX_FILE = 300 * 1024
_MAX_TOTAL = 800 * 1024
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_NAME = re.compile(r"[A-Za-z0-9_.-]+\Z")
_URL = re.compile(r"https://[^\s<>\"']+")
_TEXT = {'.py', '.json', '.jsonl', '.md', '.rst', '.txt', '.toml', '.yaml', '.yml',
         '.ini', '.cfg', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.go', '.rs',
         '.java', '.sh', '.sql', '.html', '.css', '.xml', '.graphql', '.gql', '.c',
         '.h', '.cpp', '.cs', '.rb', '.php', '.swift', '.kt', '.vue', '.svelte', '.sarif'}
_DEPENDENCIES = {'node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.git',
                 'dist', 'build', '.next', '.cache', 'coverage', 'site-packages'}


class ResearchReadError(ValueError):
    """Evidence could not be obtained completely within the permitted bounds."""


def _path(path: object, *, empty: bool = False) -> str:
    if not isinstance(path, str) or (not path and not empty):
        raise ResearchReadError('Invalid repository path')
    if any(ord(c) < 32 or ord(c) == 127 for c in path) or any(c in path for c in '\\%?#'):
        raise ResearchReadError('Invalid repository path')
    if path and any(p in {'', '.', '..'} for p in path.split('/')):
        raise ResearchReadError('Invalid repository path')
    return path


def _target(target: str) -> tuple[str, str | None, str, str]:
    if not isinstance(target, str) or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in target):
        raise ResearchReadError('Invalid GitHub target')
    parsed = urlsplit(target)
    if parsed.scheme != 'https' or parsed.netloc != 'github.com' or parsed.query or parsed.fragment:
        raise ResearchReadError('Only HTTPS github.com repository URLs are supported')
    if '?' in target or '#' in target:
        raise ResearchReadError('Query and fragment are unsupported')
    path = _path(parsed.path[1:].rstrip('/') if parsed.path.startswith('/') else parsed.path)
    parts = path.split('/')
    if len(parts) < 2 or not all(_NAME.fullmatch(p) and p not in {'.', '..'} for p in parts[:2]):
        raise ResearchReadError('Invalid repository name')
    repo = parts[1].removesuffix('.git')
    if not repo or repo in {'.', '..'}:
        raise ResearchReadError('Invalid repository name')
    repository = f'{parts[0]}/{repo}'
    if len(parts) == 2:
        return repository, None, 'repo', ''
    if len(parts) < 4 or parts[2] not in {'tree', 'blob'}:
        raise ResearchReadError('Expected a repository, tree, or blob URL')
    ref = parts[3]
    scope = '/'.join(parts[4:])
    if parts[2] == 'blob' and not scope:
        raise ResearchReadError('Blob target needs a file path')
    return repository, ref, parts[2], scope


def extract_research_target(text: str) -> str | None:
    """Return the first valid full target, preserving explicit ref and scope."""
    for match in _URL.finditer(text or ''):
        candidate = match.group(0).rstrip('),;!')
        try:
            _target(candidate)
        except (ValueError, TypeError):
            continue
        return candidate
    return None


def _allowed(path: str) -> bool:
    try:
        _path(path)
    except ResearchReadError:
        return False
    parts = path.lower().split('/')
    basename = parts[-1]
    if any(p in _DEPENDENCIES for p in parts):
        return False
    if any(p.startswith('.env') or p in {'secrets', '.secrets', 'credentials', '.aws', '.ssh', '.gnupg'} for p in parts):
        return False
    if any(token in basename for token in ('credential', 'secret', 'private_key', 'id_rsa', 'id_ed25519', 'service_account', 'service-account')):
        return False
    if basename in {'token.json', 'tokens.json', 'auth.json', 'kubeconfig'}:
        return False
    if basename.endswith(('.lock', '.min.js', '.map', '.pem', '.key', '.p12', '.pfx')):
        return False
    return PurePosixPath(basename).suffix in _TEXT or basename in {'dockerfile', 'makefile', '.gitignore', '.dockerignore'}


def _in_scope(path: str, kind: str, scope: str) -> bool:
    return kind == 'repo' or (kind == 'blob' and path == scope) or (
        kind == 'tree' and (not scope or path.startswith(scope + '/')))


def _snapshot(snapshot: dict) -> list[dict]:
    if not isinstance(snapshot, dict):
        raise ResearchReadError('Invalid snapshot')
    repository = snapshot.get('repository')
    if not isinstance(repository, str) or _target('https://github.com/' + repository)[0] != repository:
        raise ResearchReadError('Invalid snapshot repository')
    if not isinstance(snapshot.get('commit'), str) or not _SHA.fullmatch(snapshot['commit']):
        raise ResearchReadError('Invalid snapshot commit')
    kind = snapshot.get('scope_kind')
    scope = _path(snapshot.get('scope_path'), empty=True)
    if kind not in {'repo', 'tree', 'blob'} or (kind == 'repo' and scope) or (kind == 'blob' and not scope):
        raise ResearchReadError('Invalid snapshot scope')
    if type(snapshot.get('tree_truncated')) is not bool:
        raise ResearchReadError('Invalid snapshot truncation flag')
    files = snapshot.get('files')
    if not isinstance(files, list) or len(files) > 5000:
        raise ResearchReadError('Invalid snapshot file list')
    seen = set()
    for item in files:
        if not isinstance(item, dict):
            raise ResearchReadError('Invalid snapshot file')
        path = item.get('path')
        if not isinstance(path, str) or not _allowed(path) or not _in_scope(path, kind, scope) or path in seen:
            raise ResearchReadError('Invalid snapshot file scope')
        if not isinstance(item.get('blob_sha'), str) or not _SHA.fullmatch(item['blob_sha']):
            raise ResearchReadError('Invalid snapshot blob SHA')
        if type(item.get('size')) is not int or item['size'] < 0:
            raise ResearchReadError('Invalid snapshot file size')
        seen.add(path)
    return files


def search_paths(snapshot: dict, query: str = '', limit: int = 120) -> list[str]:
    """Rank eligible paths; this searches filenames, not unobserved contents."""
    files = _snapshot(snapshot)
    if type(limit) is not int or not 1 <= limit <= 120 or not isinstance(query, str) or len(query) > 300:
        raise ResearchReadError('Invalid path search bounds')
    terms = re.findall(r'[\w-]+', query.lower())
    def score(item: dict) -> tuple:
        path = item['path']
        lower = path.lower()
        rank = sum(20 for term in terms if term in lower)
        rank += sum(weight for term, weight in [('schema', 10), ('sarif', 10), ('validat', 8), ('test', 5), ('fixture', 3)] if term in lower)
        return -rank, path.count('/'), lower, path
    return [item['path'] for item in sorted(files, key=score)[:limit]]


class RepositoryReader:
    """GET-only reader; API redirects and private repositories are rejected."""

    def __init__(self, token: str | None = None, timeout: float = 12):
        self.token = token if token is not None else os.getenv('GITHUB_READONLY_TOKEN', '').strip()
        self.timeout = timeout

    def _client(self) -> httpx.AsyncClient:
        headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                   'User-Agent': 'kristina-repository-research/1.0'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        return httpx.AsyncClient(headers=headers, timeout=self.timeout, follow_redirects=False)

    async def _get(self, client: httpx.AsyncClient, path: str) -> dict:
        async with client.stream('GET', 'https://api.github.com' + path) as response:
            if response.status_code != 200:
                raise ResearchReadError(f'GitHub returned HTTP {response.status_code}')
            data = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=65536):
                if len(data) + len(chunk) > _MAX_RESPONSE:
                    raise ResearchReadError('GitHub response exceeds 6 MiB')
                data.extend(chunk)
        try:
            result = json.loads(data)
        except (ValueError, UnicodeError) as exc:
            raise ResearchReadError('Invalid GitHub JSON response') from exc
        if not isinstance(result, dict):
            raise ResearchReadError('Invalid GitHub response object')
        return result

    async def _public(self, client: httpx.AsyncClient, repository: str) -> dict:
        repo = await self._get(client, f'/repos/{repository}')
        if repo.get('private') is not False:
            raise ResearchReadError('Only public repositories are supported')
        return repo

    async def snapshot(self, target: str) -> dict:
        repository, ref, kind, scope = _target(target)
        async with self._client() as client:
            repo = await self._public(client, repository)
            ref = ref or repo.get('default_branch')
            if not isinstance(ref, str) or not ref or len(ref) > 255:
                raise ResearchReadError('Repository has no usable ref')
            commit = await self._get(client, f'/repos/{repository}/commits/{quote(ref, safe="")}')
            sha = commit.get('sha')
            if not isinstance(sha, str) or not _SHA.fullmatch(sha):
                raise ResearchReadError('Invalid commit SHA')
            tree = await self._get(client, f'/repos/{repository}/git/trees/{sha}?recursive=1')
        entries = tree.get('tree')
        if not isinstance(entries, list) or type(tree.get('truncated')) is not bool:
            raise ResearchReadError('Invalid GitHub tree')
        files = []
        for item in entries:
            if not isinstance(item, dict):
                raise ResearchReadError('Invalid tree entry')
            path = item.get('path')
            if item.get('type') != 'blob' or item.get('mode') not in {'100644', '100755'}:
                continue
            if not isinstance(path, str) or not _allowed(path) or not _in_scope(path, kind, scope):
                continue
            files.append({'path': path, 'blob_sha': item.get('sha'), 'size': item.get('size')})
        files.sort(key=lambda item: item['path'])
        result = {'repository': repository, 'commit': sha, 'scope_kind': kind,
                  'scope_path': scope, 'tree_truncated': tree['truncated'] or len(files) > 5000,
                  'files': files[:5000]}
        _snapshot(result)
        if kind in {'tree', 'blob'} and not files:
            raise ResearchReadError('Selected scope has no eligible text files')
        return result

    async def read_files(self, snapshot: dict, paths: list[str]) -> list[dict]:
        files = {item['path']: item for item in _snapshot(snapshot)}
        if snapshot['tree_truncated']:
            raise ResearchReadError('Cannot use a truncated repository tree as complete evidence')
        if not isinstance(paths, list) or not 1 <= len(paths) <= 4 or any(not isinstance(p, str) for p in paths) or len(set(paths)) != len(paths):
            raise ResearchReadError('Select 1 to 4 distinct files')
        if any(path not in files for path in paths):
            raise ResearchReadError('File is outside the observed snapshot scope')
        if any(files[path]['size'] > _MAX_FILE for path in paths) or sum(files[p]['size'] for p in paths) > _MAX_TOTAL:
            raise ResearchReadError('Selected files exceed evidence size bounds')
        repository = snapshot['repository']
        result = []
        total = 0
        async with self._client() as client:
            await self._public(client, repository)
            for path in paths:
                item = files[path]
                payload = await self._get(client, f'/repos/{repository}/git/blobs/{item["blob_sha"]}')
                if payload.get('encoding') != 'base64' or not isinstance(payload.get('content'), str):
                    raise ResearchReadError('Expected complete base64 blob')
                try:
                    raw = base64.b64decode(''.join(payload['content'].split()), validate=True)
                except ValueError as exc:
                    raise ResearchReadError('Invalid blob encoding') from exc
                total += len(raw)
                if len(raw) > _MAX_FILE or total > _MAX_TOTAL or len(raw) != item['size']:
                    raise ResearchReadError('Blob size does not match evidence bounds')
                actual = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
                if actual != item['blob_sha'] or payload.get('sha') != item['blob_sha'] or payload.get('size') != len(raw):
                    raise ResearchReadError('Blob integrity mismatch')
                try:
                    content = raw.decode('utf-8')
                except UnicodeDecodeError as exc:
                    raise ResearchReadError('Blob is not complete UTF-8 text') from exc
                if '\0' in content:
                    raise ResearchReadError('Binary content is unsupported')
                result.append({'path': path, 'blob_sha': actual, 'sha256': hashlib.sha256(raw).hexdigest(),
                               'content': content, 'url': f'https://github.com/{repository}/blob/{snapshot["commit"]}/{quote(path, safe="/")}'})
        return result
