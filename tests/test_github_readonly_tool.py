from github_readonly_tool import (
    GitHubInspection,
    GitHubRepoRef,
    _rank_paths,
    extract_github_repositories,
    format_github_context,
)


def test_extracts_repository_from_git_url():
    refs = extract_github_repositories(
        "глянь https://github.com/donjonson-hash/kristina_agent_center.git пожалуйста"
    )
    assert refs == [GitHubRepoRef("donjonson-hash", "kristina_agent_center")]


def test_deduplicates_same_repository():
    refs = extract_github_repositories(
        "https://github.com/Owner/Repo и https://github.com/owner/repo.git"
    )
    assert len(refs) == 1
    assert refs[0].full_name == "Owner/Repo"


def test_ignores_non_github_hosts():
    assert extract_github_repositories("https://example.com/owner/repo") == []
    assert extract_github_repositories("https://github.example.com/owner/repo") == []


def test_ranking_prefers_architecture_entry_points():
    tree = [
        {"type": "blob", "path": "src/zzz.py", "size": 1000},
        {"type": "blob", "path": "agent_router.py", "size": 1000},
        {"type": "blob", "path": "README.md", "size": 1000},
        {"type": "blob", "path": "tests/test_router.py", "size": 1000},
    ]
    ranked = _rank_paths(tree)
    assert ranked[0] == "README.md"
    assert "agent_router.py" in ranked[:3]


def test_binary_or_large_files_are_not_ranked():
    tree = [
        {"type": "blob", "path": "photo.png", "size": 1000},
        {"type": "blob", "path": "huge.py", "size": 100_000},
        {"type": "blob", "path": "main.py", "size": 2000},
    ]
    assert _rank_paths(tree) == ["main.py"]


def test_failed_inspection_explicitly_forbids_claiming_review():
    inspection = GitHubInspection(
        repo=GitHubRepoRef("owner", "repo"),
        evidence="",
        ok=False,
        error="rate limited",
    )
    context = format_github_context([inspection])
    assert "TOOL ERROR" in context
    assert "Do not claim that you inspected repository files" in context


def test_success_context_contains_real_evidence_only():
    inspection = GitHubInspection(
        repo=GitHubRepoRef("owner", "repo"),
        evidence="GITHUB READ-ONLY EVIDENCE\nRepository: owner/repo\n--- FILE: main.py ---\nprint('ok')",
        ok=True,
    )
    context = format_github_context([inspection])
    assert "Repository: owner/repo" in context
    assert "print('ok')" in context
