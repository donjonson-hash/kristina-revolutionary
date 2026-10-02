"""Build the static website and both offline extensions from tracked CTT source."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src"
OUTPUT = ROOT / "dist"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    # OUTPUT is a fixed, generated directory; never write into the source tree.
    if OUTPUT.is_symlink():
        raise RuntimeError("Refusing to replace a symlink at ctt/dist")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    shutil.copytree(SOURCE, OUTPUT)
    (OUTPUT / "downloads").mkdir()
    subprocess.run([sys.executable, str(ROOT / "scripts/package_extension.py")], check=True)
    release = json.loads((ROOT / "release.json").read_text())
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--", "."], cwd=ROOT, text=True).strip())
    record = {
        "product": "Compare These Texts",
        "version": release["version"],
        "source_commit": revision,
        "source_dirty": dirty,
        "build_command": "cd ctt && npm ci --ignore-scripts && npm run build",
        "source_files_sha256": {str(p.relative_to(SOURCE)): sha256(p) for p in sorted(SOURCE.rglob("*")) if p.is_file()},
        "archives_sha256": {p.name: sha256(p) for p in sorted((OUTPUT / "downloads").glob("*.zip"))},
    }
    (OUTPUT / "release").mkdir()
    (OUTPUT / "release/provenance.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"Built CTT {release['version']}; source_commit={revision}; source_dirty={dirty}")


if __name__ == "__main__":
    build()
