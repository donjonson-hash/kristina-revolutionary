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


def test_selected_file_url_survives_extraction():
    target = 'https://github.com/example/project/blob/main/tests/schema.json'
    assert extract_github_repo_url(target).target == target


async def test_dialogue_inspection_preserves_scope_commit_and_excerpt_limits(monkeypatch):
    import github_readonly
    import json
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    target = 'https://github.com/example/project/blob/main/tests/schema.json'
    snapshot = {'repository':'example/project', 'commit':'a'*40, 'scope_kind':'blob',
                'scope_path':'tests/schema.json', 'tree_truncated':False,
                'files':[{'path':'tests/schema.json'}]}
    source = {'path':'tests/schema.json', 'blob_sha':'b'*40, 'sha256':'c'*64,
              'url':'https://github.com/example/project/blob/'+'a'*40+'/tests/schema.json',
              'content':'x'*6000}
    reader = SimpleNamespace(snapshot=AsyncMock(return_value=snapshot), read_files=AsyncMock(return_value=[source]))
    monkeypatch.setattr(github_readonly, 'RepositoryReader', lambda **kwargs: reader)
    evidence = await GitHubReadOnlyTool(token='').inspect(extract_github_repo_url(target))
    reader.snapshot.assert_awaited_once_with(target)
    reader.read_files.assert_awaited_once_with(snapshot, ['tests/schema.json'])
    data = json.loads(evidence.split('\n',1)[1])
    assert data['commit'] == 'a'*40
    assert data['sources'][0]['excerpt_truncated'] is True
    assert len(data['sources'][0]['excerpt']) == 5000
