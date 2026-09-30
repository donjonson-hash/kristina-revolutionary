"""Deployment snapshots must include committed WAL and preserve the old schema."""

import sqlite3

import pytest

from deploy.backup_state import backup_state


def test_backup_includes_live_wal_and_configured_state_path(tmp_path, monkeypatch):
    monkeypatch.delenv("KRISTINA_STATE_DB", raising=False)
    state = tmp_path / "state with spaces.db"
    (tmp_path / ".env").write_text('KRISTINA_STATE_DB="state with spaces.db"\n')
    connections = []
    try:
        for path, value in ((tmp_path / "kristina_memory.db", "conversation"), (state, "v1")):
            conn = sqlite3.connect(path)
            connections.append(conn)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE snapshot(value TEXT)")
            conn.execute("INSERT INTO snapshot VALUES (?)", (value,))
            conn.commit()
        saved = backup_state(tmp_path)
        assert {path.name for path in saved} == {"conversation.db", "emotional_state.db", "env"}
        assert saved[0].parent.stat().st_mode & 0o777 == 0o700
        for path in saved:
            assert path.stat().st_mode & 0o777 == 0o600
        env_copy = next(path for path in saved if path.name == "env")
        assert env_copy.read_text() == 'KRISTINA_STATE_DB="state with spaces.db"\n'
        for path in saved:
            if path.name == "env":
                continue
            with sqlite3.connect(path) as conn:
                value = conn.execute("SELECT value FROM snapshot").fetchone()[0]
                assert value == ("v1" if path.name == "emotional_state.db" else "conversation")
        connections[1].execute("UPDATE snapshot SET value='v2'")
        connections[1].commit()
        with sqlite3.connect(saved[1]) as conn:
            assert conn.execute("SELECT value FROM snapshot").fetchone()[0] == "v1"
    finally:
        for conn in connections:
            conn.close()


def test_environment_path_takes_precedence_and_repeated_backups_do_not_overwrite(tmp_path, monkeypatch):
    source = tmp_path / "custom.sqlite"
    with sqlite3.connect(source) as conn:
        conn.execute("CREATE TABLE snapshot(value TEXT)")
    (tmp_path / ".env").write_text("KRISTINA_STATE_DB=not-the-active-db.sqlite\n")
    monkeypatch.setenv("KRISTINA_STATE_DB", str(source))
    first = backup_state(tmp_path)
    second = backup_state(tmp_path)
    assert len(first) == len(second) == 2
    assert first[0] != second[0]
    assert first[0].exists() and second[0].exists()


def test_configuration_is_backed_up_even_without_databases(tmp_path, monkeypatch):
    monkeypatch.delenv("KRISTINA_STATE_DB", raising=False)
    (tmp_path / ".env").write_text("KRISTINA_TELEGRAM_TOKEN=secret\nKRISTINA_CHANNEL_ID=-100123\n")
    saved = backup_state(tmp_path)
    assert [path.name for path in saved] == ["env"]
    assert saved[0].stat().st_mode & 0o777 == 0o600
    assert "KRISTINA_CHANNEL_ID=-100123" in saved[0].read_text()


def test_unreadable_database_fails_and_first_start_is_allowed(tmp_path, monkeypatch):
    monkeypatch.delenv("KRISTINA_STATE_DB", raising=False)
    assert backup_state(tmp_path) == []
    source = tmp_path / "kristina_state.db"
    source.write_text("not sqlite")
    with pytest.raises(sqlite3.DatabaseError):
        backup_state(tmp_path)
    assert source.read_text() == "not sqlite"


def test_old_snapshots_are_pruned_but_the_newest_survives(tmp_path):
    import os
    import time
    from deploy.backup_state import prune_old_backups

    root = tmp_path / "backups"
    root.mkdir()
    now = time.time()
    ages_days = {"pre-deploy-a": 45, "pre-deploy-b": 40, "pre-deploy-c": 3}
    for name, age in ages_days.items():
        path = root / name
        path.mkdir()
        (path / "env").write_text("x")
        os.utime(path, (now - age * 86400, now - age * 86400))
    (root / "unrelated").mkdir()
    os.utime(root / "unrelated", (now - 400 * 86400, now - 400 * 86400))

    removed = prune_old_backups(root, keep_days=30, now=now)
    assert {path.name for path in removed} == {"pre-deploy-a", "pre-deploy-b"}
    assert sorted(path.name for path in root.iterdir()) == ["pre-deploy-c", "unrelated"]

    # A single ancient snapshot is never removed: it may be the only copy of .env.
    lone = root / "pre-deploy-old"
    lone.mkdir()
    os.utime(lone, (now - 400 * 86400, now - 400 * 86400))
    import shutil
    shutil.rmtree(root / "pre-deploy-c")
    assert prune_old_backups(root, keep_days=30, now=now) == []
    assert lone.exists()
