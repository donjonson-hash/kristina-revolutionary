"""Read-only GitHub repository inspection for Kristina.

The runtime intentionally exposes only GET requests. It can inspect repository
metadata, a recursive tree and a bounded set of text/code files, then return
plain evidence for the persona layer to reason over.
"""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from typing import Iterable, Optional
from urllib.parse import quote, urlparse

import httpx


_GITHUB_REPO_RE = re.compile(
    r"https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#\s]|$)",
    re.IGNORECASE,
)

_TEXT_EXTENSIONS = {
    ".py", ".md", ".toml", ".yaml", ".yml", ".json", ".txt", ".ini",
    ".cfg", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".sh",
}

_PRIORITY_NAMES = {
    "readme.md": 100,
    "pyproject.toml": 95,
    "requirements.txt": 92,
    "main.py": 90,
    "app.py": 89,
    "bot.py": 88,
    "agent_router.py": 87,
    "router.py": 86,
    "orchestrator.py": 85,
    "architecture.md": 84,
    "dockerfile": 80,
    "docker-compose.yml": 79,
}


@dataclass(frozen=True)
class GitHubRepoRef:
    owner: str
    repo: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"


def extract_github_repo_url(text: str) -> Optional[GitHubRepoRef]:
    """Extract the first github.com owner/repository reference from text."""
    match = _GITHUB_REPO_RE.search(text or "")
    if not match:
        return None
    owner, repo = match.group(1), match.group(2)
    return GitHubRepoRef(owner=owner, repo=repo)


def _candidate_score(path: str) -> int:
    lower = path.lower()
    basename = lower.rsplit("/", 1)[-1]
    if any(part in lower for part in ("node_modules/", "vendor/", ".venv/", "dist/", "build/")):
        return -1
    if basename.endswith((".lock", ".min.js", ".map")):
        return -1
    if basename in _PRIORITY_NAMES:
        return _PRIORITY_NAMES[basename]
    if "test" in basename and basename.endswith(".py"):
        return 68
    if any(token in basename for token in ("agent", "router", "orchestr", "workflow", "service", "model")):
        return 65
    dot = basename.rfind(".")
    suffix = basename[dot:] if dot >= 0 else ""
    return 40 if suffix in _TEXT_EXTENSIONS else -1


def select_candidate_files(paths: Iterable[str], limit: int = 7) -> list[str]:
    """Choose a small representative set of source/config/docs files."""
    scored = [(_candidate_score(path), path) for path in paths]
    scored = [(score, path) for score, path in scored if score >= 0]
    scored.sort(key=lambda item: (-item[0], item[1].count("/"), item[1].lower()))
    return [path for _, path in scored[:limit]]


class GitHubReadOnlyTool:
    """Bounded GitHub API reader. There are deliberately no write methods."""

    api_base = "https://api.github.com"

    def __init__(self, token: Optional[str] = None, timeout: float = 12.0):
        self.token = token or os.getenv("GITHUB_READONLY_TOKEN", "").strip() or None
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "kristina-readonly-tool/1.0",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def inspect(self, ref: GitHubRepoRef) -> str:
        """Return evidence text from real GitHub responses, bounded for LLM context."""
        async with httpx.AsyncClient(headers=self._headers(), timeout=self.timeout, follow_redirects=True) as client:
            repo_response = await client.get(f"{self.api_base}/repos/{ref.owner}/{ref.repo}")
            repo_response.raise_for_status()
            repo = repo_response.json()

            default_branch = repo.get("default_branch") or "main"
            tree_response = await client.get(
                f"{self.api_base}/repos/{ref.owner}/{ref.repo}/git/trees/{quote(default_branch, safe='')}",
                params={"recursive": "1"},
            )
            tree_response.raise_for_status()
            tree_json = tree_response.json()
            tree_items = tree_json.get("tree", [])
            paths = [item.get("path", "") for item in tree_items if item.get("type") == "blob" and item.get("path")]

            selected = select_candidate_files(paths)
            file_blocks: list[str] = []
            total_file_chars = 0
            for path in selected:
                if total_file_chars >= 26000:
                    break
                encoded_path = quote(path, safe="/")
                response = await client.get(
                    f"{self.api_base}/repos/{ref.owner}/{ref.repo}/contents/{encoded_path}",
                    params={"ref": default_branch},
                )
                if response.status_code != 200:
                    continue
                payload = response.json()
                if payload.get("encoding") != "base64" or not payload.get("content"):
                    continue
                try:
                    raw = base64.b64decode(payload["content"], validate=False)
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    continue
                text = text[:5000]
                total_file_chars += len(text)
                file_blocks.append(f"\n--- FILE: {path} ---\n{text}")

            tree_preview = "\n".join(paths[:180])
            if len(paths) > 180:
                tree_preview += f"\n... and {len(paths) - 180} more files"

            description = repo.get("description") or "(no description)"
            language = repo.get("language") or "unknown"
            evidence = (
                "GITHUB READ-ONLY EVIDENCE (fetched from GitHub API)\n"
                f"Repository: {repo.get('full_name', ref.full_name)}\n"
                f"Default branch: {default_branch}\n"
                f"Description: {description}\n"
                f"Primary language: {language}\n"
                f"Stars: {repo.get('stargazers_count', 0)}; forks: {repo.get('forks_count', 0)}\n"
                f"Tree truncated by API: {bool(tree_json.get('truncated'))}\n\n"
                "REPOSITORY TREE (preview):\n"
                f"{tree_preview or '(empty tree)'}\n"
                + "".join(file_blocks)
            )
            return evidence[:34000]
