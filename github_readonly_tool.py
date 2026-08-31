"""Read-only GitHub repository inspection for Kristina.

This module intentionally exposes no mutation methods. It fetches repository metadata,
a recursive tree, README and a bounded set of useful text files from github.com.
"""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from typing import Iterable, Optional

import httpx


GITHUB_REPO_RE = re.compile(
    r"https?://github\.com/(?P<owner>[A-Za-z0-9_.-]+)/(?P<repo>[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?\s]|$)",
    re.IGNORECASE,
)

MAX_TREE_ENTRIES = 240
MAX_FILES = 7
MAX_FILE_CHARS = 12_000
MAX_CONTEXT_CHARS = 48_000

_PRIORITY_NAMES = (
    "README.md",
    "pyproject.toml",
    "requirements.txt",
    "package.json",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
    "main.py",
    "app.py",
    "bot.py",
    "agent_router.py",
    "router.py",
    "orchestrator.py",
    "manager.py",
    "state_machine.py",
)

_TEXT_EXTENSIONS = {
    ".py", ".md", ".toml", ".txt", ".json", ".yml", ".yaml", ".ini", ".cfg", ".sh",
}


@dataclass(frozen=True)
class GitHubRepoRef:
    owner: str
    repo: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"


@dataclass(frozen=True)
class GitHubInspection:
    repo: GitHubRepoRef
    evidence: str
    ok: bool
    error: Optional[str] = None


def extract_github_repositories(text: str) -> list[GitHubRepoRef]:
    """Extract unique github.com owner/repository references from arbitrary text."""
    refs: list[GitHubRepoRef] = []
    seen: set[str] = set()
    for match in GITHUB_REPO_RE.finditer(text or ""):
        owner = match.group("owner")
        repo = match.group("repo").removesuffix(".git")
        key = f"{owner.lower()}/{repo.lower()}"
        if key not in seen:
            seen.add(key)
            refs.append(GitHubRepoRef(owner=owner, repo=repo))
    return refs


def _headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kristina-revolutionary-readonly",
    }
    token = os.getenv("GITHUB_READ_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _is_useful_text_file(path: str, size: int) -> bool:
    if size <= 0 or size > 80_000:
        return False
    name = path.rsplit("/", 1)[-1]
    if name in _PRIORITY_NAMES:
        return True
    dot = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return dot in _TEXT_EXTENSIONS


def _rank_paths(tree: Iterable[dict]) -> list[str]:
    candidates: list[tuple[int, int, str]] = []
    priorities = {name.lower(): index for index, name in enumerate(_PRIORITY_NAMES)}
    for item in tree:
        if item.get("type") != "blob":
            continue
        path = str(item.get("path", ""))
        size = int(item.get("size") or 0)
        if not _is_useful_text_file(path, size):
            continue
        name = path.rsplit("/", 1)[-1].lower()
        priority = priorities.get(name, len(_PRIORITY_NAMES) + 10)
        depth = path.count("/")
        candidates.append((priority, depth, path))
    candidates.sort()
    return [path for _, _, path in candidates[:MAX_FILES]]


async def _get_json(client: httpx.AsyncClient, url: str) -> dict:
    response = await client.get(url)
    if response.status_code == 403 and response.headers.get("x-ratelimit-remaining") == "0":
        raise RuntimeError("GitHub API rate limit reached")
    response.raise_for_status()
    return response.json()


async def _get_file_text(client: httpx.AsyncClient, owner: str, repo: str, path: str, ref: str) -> str:
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}"
    response = await client.get(url, params={"ref": ref})
    if response.status_code == 404:
        return ""
    response.raise_for_status()
    payload = response.json()
    if payload.get("encoding") != "base64" or not payload.get("content"):
        return ""
    raw = base64.b64decode(payload["content"], validate=False)
    return raw.decode("utf-8", errors="replace")[:MAX_FILE_CHARS]


async def inspect_repository(ref: GitHubRepoRef) -> GitHubInspection:
    """Inspect a GitHub repository using GET-only API calls and return bounded evidence."""
    api = f"https://api.github.com/repos/{ref.owner}/{ref.repo}"
    try:
        async with httpx.AsyncClient(headers=_headers(), timeout=12.0, follow_redirects=True) as client:
            metadata = await _get_json(client, api)
            default_branch = str(metadata.get("default_branch") or "main")
            tree_payload = await _get_json(
                client,
                f"{api}/git/trees/{default_branch}?recursive=1",
            )
            tree = list(tree_payload.get("tree") or [])

            lines = [
                "GITHUB READ-ONLY EVIDENCE",
                f"Repository: {metadata.get('full_name', ref.full_name)}",
                f"Description: {metadata.get('description') or '(none)'}",
                f"Default branch: {default_branch}",
                f"Primary language: {metadata.get('language') or '(unknown)'}",
                f"Stars: {metadata.get('stargazers_count', 0)}; forks: {metadata.get('forks_count', 0)}",
                f"Open issues: {metadata.get('open_issues_count', 0)}",
                "",
                "Repository tree (bounded):",
            ]
            visible_paths = [str(item.get("path")) for item in tree[:MAX_TREE_ENTRIES] if item.get("path")]
            lines.extend(f"- {path}" for path in visible_paths)

            selected_paths = _rank_paths(tree)
            for path in selected_paths:
                text = await _get_file_text(client, ref.owner, ref.repo, path, default_branch)
                if not text:
                    continue
                lines.extend([
                    "",
                    f"--- FILE: {path} ---",
                    text,
                ])

            evidence = "\n".join(lines)[:MAX_CONTEXT_CHARS]
            return GitHubInspection(repo=ref, evidence=evidence, ok=True)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 404:
            error = "repository not found or not accessible"
        elif status == 401:
            error = "GitHub authentication failed"
        elif status == 403:
            error = "GitHub access denied or rate limited"
        else:
            error = f"GitHub HTTP {status}"
        return GitHubInspection(repo=ref, evidence="", ok=False, error=error)
    except (httpx.HTTPError, RuntimeError) as exc:
        return GitHubInspection(repo=ref, evidence="", ok=False, error=str(exc))


async def inspect_repositories_from_text(text: str, limit: int = 2) -> list[GitHubInspection]:
    refs = extract_github_repositories(text)[:limit]
    results: list[GitHubInspection] = []
    for ref in refs:
        results.append(await inspect_repository(ref))
    return results


def format_github_context(inspections: Iterable[GitHubInspection]) -> str:
    """Format evidence/errors for injection into Kristina's reasoning context."""
    blocks: list[str] = []
    for inspection in inspections:
        if inspection.ok:
            blocks.append(inspection.evidence)
        else:
            blocks.append(
                "GITHUB READ-ONLY TOOL ERROR\n"
                f"Repository: {inspection.repo.full_name}\n"
                f"Error: {inspection.error or 'unknown error'}\n"
                "Do not claim that you inspected repository files."
            )
    return "\n\n".join(blocks)
