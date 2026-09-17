#!/usr/bin/env python3
"""Read-only host inventory for iLands Runner; never installs or authenticates."""

import json
import os
from pathlib import Path
import platform
import shutil
import subprocess


def probe(argv):
    """Bound every subprocess; keep failure details and host paths out of output."""
    try:
        result = subprocess.run(
            argv, capture_output=True, text=True, timeout=8, check=False,
        )
        return result.returncode == 0, result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False, ""


def inventory():
    system = platform.system()
    architecture = platform.machine()
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(architecture)
    glibc_ok, libc = probe(["getconf", "GNU_LIBC_VERSION"]) if system == "Linux" else (False, "")
    try:
        libc_name, libc_version = libc.split()
        glibc_ok = glibc_ok and libc_name == "glibc" and tuple(
            int(part) for part in libc_version.split(".")[:2]
        ) >= (2, 28)
    except (ValueError, TypeError):
        glibc_ok = False
    systemd_ok, _ = probe([
        "systemctl", "--user", "list-units", "--no-pager", "--no-legend",
    ]) if system == "Linux" else (False, "")
    linger_ok, linger = probe([
        "loginctl", "show-user", str(os.getuid()), "--property=Linger", "--value",
    ]) if system == "Linux" else (False, "")
    runtimes = {
        harness: shutil.which(command) is not None
        for harness, command in (
            ("codex", "codex"), ("claude-code", "claude"),
            ("openclaw", "openclaw"), ("hermes", "hermes"), ("pi", "pi"),
        )
    }
    try:
        memory_mib = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") // (1024 * 1024)
    except (AttributeError, OSError, ValueError):
        memory_mib = None
    host_supported = system == "Linux" and arch is not None and glibc_ok and systemd_ok
    blockers = []
    if system != "Linux" or arch is None:
        blockers.append("This server preflight covers Linux x64/arm64 only; consult the live guide.")
    if system == "Linux" and not glibc_ok:
        blockers.append("glibc 2.28+ was not confirmed.")
    if system == "Linux" and not systemd_ok:
        blockers.append("Active systemd user manager was not confirmed for the current login.")
    if not any(runtimes.values()):
        blockers.append("No supported runtime executable was found on PATH; select and prepare one explicitly.")
    return {
        "read_only": True,
        "reference_runner_version": "0.1.27",
        "live_guide": "https://ilands.ai/agent.md",
        "os": system,
        "architecture": architecture,
        "platform_key": f"linux-{arch}" if system == "Linux" and arch else None,
        "glibc": libc if glibc_ok else None,
        "systemd_user_active": systemd_ok,
        "linger_enabled": linger == "yes" if linger_ok else None,
        "running_as_root": os.getuid() == 0 if hasattr(os, "getuid") else None,
        "memory_mib": memory_mib,
        "runtime_executables_found": runtimes,
        "runner_executable_found": shutil.which("ilands-runner") is not None
            or (Path.home() / ".local/bin/ilands-runner").is_file(),
        "linux_host_prerequisites_confirmed": host_supported,
        "runtime_version_and_authentication": "not_checked; use the selected Runner Doctor",
        "python_brain_connected": False,
        "ilands_identity_created": False,
        "blockers": blockers,
    }


if __name__ == "__main__":
    print(json.dumps(inventory(), ensure_ascii=False, indent=2))
