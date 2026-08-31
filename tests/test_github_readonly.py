from github_readonly import GitHubReadOnlyTool, extract_github_repo_url, select_candidate_files


def test_extract_plain_repo_url():
    ref = extract_github_repo_url("посмотри https://github.com/donjonson-hash/kristina_agent_center")
    assert ref is not None
    assert ref.full_name == "donjonson-hash/kristina_agent_center"


def test_extract_dot_git_url():
    ref = extract_github_repo_url("https://github.com/donjonson-hash/Palantir_office_programmers.git")
    assert ref is not None
    assert ref.repo == "Palantir_office_programmers"


def test_non_github_url_is_ignored():
    assert extract_github_repo_url("https://example.com/a/b") is None


def test_candidate_selection_prefers_architecture_and_router_files():
    paths = [
        "assets/logo.png",
        "src/random.py",
        "tests/test_router.py",
        "agent_router.py",
        "README.md",
        "pyproject.toml",
        "src/service.py",
        "package-lock.json",
    ]
    selected = select_candidate_files(paths, limit=4)
    assert selected[:3] == ["README.md", "pyproject.toml", "agent_router.py"]
    assert "package-lock.json" not in selected


def test_runtime_tool_exposes_no_write_operations():
    tool = GitHubReadOnlyTool(token="test")
    for name in ("create", "update", "delete", "push", "merge", "commit", "dispatch"):
        assert not hasattr(tool, name)
