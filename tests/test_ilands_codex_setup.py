"""Setup checks use only temporary records and mocked processes; no live login."""

import json
import os
import subprocess
import tomllib

import pytest

from deploy import ilands_codex_setup as setup


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    runner_home = tmp_path / "runner"
    runner_home.mkdir()
    codex_home = tmp_path / "managed-auth"
    codex_home.mkdir()
    executable = tmp_path / "pinned-codex"
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o700)
    record = {
        "schemaVersion": 1, "harness": "codex", "runtimeSource": "managed",
        "command": str(executable), "version": "0.146.0",
        "environment": {"CODEX_HOME": str(codex_home)},
        "preparedAt": "2026-09-17T00:00:00Z",
    }
    (runner_home / "prepared-runtime.json").write_text(json.dumps(record))
    monkeypatch.setenv("ILANDS_RUNNER_HOME", str(runner_home))
    return runner_home, codex_home, executable, record


def test_binding_wins_and_saved_environment_is_forwarded(prepared, monkeypatch):
    runner_home, codex_home, executable, _ = prepared
    environment = {"CODEX_HOME": str(codex_home), "XDG_DATA_HOME": "/saved/context"}
    config = {
        "runtimeBinding": {
            "schemaVersion": 2, "harness": "codex", "runtimeSource": "managed",
            "harnessCommand": str(executable), "harnessEnvironment": environment,
        },
        "auth": {"private_unrelated_field": "must-not-appear"},
    }
    (runner_home / "config.json").write_text(json.dumps(config))
    monkeypatch.setenv("CODEX_HOME", "/different/caller/context")
    command, saved, child = setup.load_runtime(runner_home)
    assert command == str(executable)
    assert saved == environment
    assert child["CODEX_HOME"] == str(codex_home)
    assert child["XDG_DATA_HOME"] == "/saved/context"
    assert os.environ["CODEX_HOME"] == "/different/caller/context"
    assert not (codex_home / "auth.json").exists()


def test_reject_other_bound_harness_without_falling_back(prepared, capsys):
    runner_home, _, _, _ = prepared
    (runner_home / "config.json").write_text(json.dumps({
        "runtimeBinding": {"harness": "hermes", "harnessCommand": "secret-command"},
    }))
    assert setup.main(["check"]) == 1
    output = capsys.readouterr().out
    assert "другую среду" in output
    assert "secret-command" not in output


def test_device_login_uses_pinned_command_and_auth_context(prepared, monkeypatch, capsys):
    _, codex_home, executable, _ = prepared
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, "Usage: login --device-auth\nSECRET", "SECRET")

    monkeypatch.setattr(setup.subprocess, "run", fake_run)
    assert setup.main(["device-login"]) == 0
    assert calls[0][0] == [str(executable), "login", "--help"]
    assert calls[0][1]["capture_output"] is True
    assert calls[1][0] == [str(executable), "login", "--device-auth"]
    assert calls[1][1]["env"]["CODEX_HOME"] == str(codex_home)
    assert "capture_output" not in calls[1][1]
    assert "SECRET" not in capsys.readouterr().out


def test_missing_device_auth_flag_never_starts_login(prepared, monkeypatch, capsys):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "login --help", "secret-detail")

    monkeypatch.setattr(setup.subprocess, "run", fake_run)
    assert setup.main(["device-login"]) == 1
    assert len(calls) == 1
    assert "secret-detail" not in capsys.readouterr().out


def test_doctor_separates_codex_ready_from_missing_ilands(prepared, monkeypatch, capsys):
    _, codex_home, _, _ = prepared
    report = {
        "ok": False,
        "checks": [
            {"name": "harness.codex", "ok": True, "details": {"authenticated": True, "token": "SECRET"}},
            {"name": "runner_auth", "ok": False, "message": "SECRET"},
            {"name": "agent_binding", "ok": False},
            {"name": "tool.dl", "ok": True},
            {"name": "tool.ilands", "ok": True},
        ],
    }
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 1, json.dumps(report), "SECRET")

    real_which = setup.shutil.which
    monkeypatch.setattr(setup.shutil, "which", lambda command, **kwargs: "/fake/runner" if command == "ilands-runner" else real_which(command, **kwargs))
    monkeypatch.setattr(setup.subprocess, "run", fake_run)
    assert setup.main(["check"]) == 0
    assert calls[0][0][1:] == ["doctor", "--harness", "codex"]
    assert calls[0][1]["env"]["CODEX_HOME"] == str(codex_home)
    output = capsys.readouterr().out
    assert "готов и авторизован" in output
    assert "до регистрации это ожидаемо" in output
    assert "SECRET" not in output


@pytest.fixture
def mcp_inputs(tmp_path, monkeypatch, prepared):
    project = tmp_path / "bridge checkout"
    project.mkdir()
    (project / "ilands_mcp.py").write_text("# test placeholder; never executed\n")
    state = tmp_path / "production-state"
    state.mkdir()
    python = project / "venv-python"
    python.symlink_to(prepared[2])
    monkeypatch.setattr(setup, "PROJECT_ROOT", project)
    return project, state, python


def test_mcp_append_preserves_settings_and_venv_symlink(prepared, mcp_inputs, monkeypatch):
    _, codex_home, _, _ = prepared
    project, state, python = mcp_inputs
    original = b'# keep comment\nmodel = "existing-model"\n[mcp_servers.other]\ncommand = "other-server"\n'
    config = codex_home / "config.toml"
    config.write_bytes(original)
    monkeypatch.setattr(setup.subprocess, "run", lambda *a, **k: pytest.fail("MCP configuration must not launch models or auth"))
    args = ["configure-mcp", "--python", str(python), "--state-dir", str(state)]
    assert setup.main(args) == 0
    updated = config.read_bytes()
    assert updated.startswith(original)
    parsed = tomllib.loads(updated.decode())
    assert parsed["model"] == "existing-model"
    assert parsed["mcp_servers"]["other"] == {"command": "other-server"}
    assert parsed["mcp_servers"]["kristina"]["command"] == str(python)
    assert parsed["mcp_servers"]["kristina"]["args"] == [str(project / "ilands_mcp.py"), "--state-dir", str(state)]
    assert parsed["mcp_servers"]["kristina"]["tool_timeout_sec"] == 240
    assert config.stat().st_mode & 0o777 == 0o600
    assert setup.main(args) == 0
    assert config.read_bytes() == updated


@pytest.mark.parametrize("original", [
    b'[mcp_servers.kristina]\ncommand = "keep-me"\n',
    b'mcp_servers = { other = { command = "keep-me" } }\n',
    b'not valid TOML [SECRET',
])
def test_conflicting_or_unmergeable_config_never_changes(prepared, mcp_inputs, original, capsys):
    _, codex_home, _, _ = prepared
    _, state, python = mcp_inputs
    config = codex_home / "config.toml"
    config.write_bytes(original)
    assert setup.main(["configure-mcp", "--python", str(python), "--state-dir", str(state)]) == 1
    assert config.read_bytes() == original
    assert "SECRET" not in capsys.readouterr().out


def test_no_guessing_auth_home_or_accepting_home_override(prepared, mcp_inputs, monkeypatch, capsys):
    runner_home, codex_home, _, record = prepared
    _, state, python = mcp_inputs
    record["environment"] = {}
    (runner_home / "prepared-runtime.json").write_text(json.dumps(record))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    assert setup.main(["configure-mcp", "--python", str(python), "--state-dir", str(state)]) == 1
    assert not (codex_home / "config.toml").exists()
    record["environment"] = {"HOME": "/must-not-use"}
    (runner_home / "prepared-runtime.json").write_text(json.dumps(record))
    assert setup.main(["check"]) == 1
    assert "/must-not-use" not in capsys.readouterr().out


def test_invalid_doctor_output_is_not_printed(prepared, monkeypatch, capsys):
    real_which = setup.shutil.which
    monkeypatch.setattr(setup.shutil, "which", lambda command, **kwargs: "/fake/runner" if command == "ilands-runner" else real_which(command, **kwargs))
    monkeypatch.setattr(setup.subprocess, "run", lambda argv, **kwargs: subprocess.CompletedProcess(argv, 1, "SECRET", "SECRET"))
    assert setup.main(["check"]) == 1
    assert "SECRET" not in capsys.readouterr().out
