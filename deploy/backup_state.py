"""Take consistent SQLite snapshots before a deployment can migrate live state."""

import os
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

from dotenv import dotenv_values


def backup_state(app_dir: Path):
    config = dotenv_values(app_dir / ".env")
    state_path = Path(os.environ.get("KRISTINA_STATE_DB", config.get("KRISTINA_STATE_DB") or "kristina_state.db"))
    if not state_path.is_absolute():
        state_path = app_dir / state_path
    sources = {
        "conversation.db": app_dir / "kristina_memory.db",
        "emotional_state.db": state_path,
    }
    existing = {name: path for name, path in sources.items() if path.exists()}
    if not existing:
        print("No existing state databases to back up (first deployment).")
        return []
    root = app_dir / "backups"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="pre-deploy-", dir=root))
    saved = []
    for name, source in existing.items():
        target = directory / name
        # Keep personal data private even with a permissive process umask.
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        deadline = time.monotonic() + 30

        def progress(status, remaining, total):
            if time.monotonic() > deadline:
                raise TimeoutError("Database backup exceeded 30 seconds")

        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as src:
            with closing(sqlite3.connect(target)) as dest:
                src.backup(dest, pages=128, progress=progress)
                if dest.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise RuntimeError("Database backup failed integrity check")
        saved.append(target)
        print(f"Database backup: {target}")
    return saved


if __name__ == "__main__":
    backup_state(Path(__file__).resolve().parents[1])
