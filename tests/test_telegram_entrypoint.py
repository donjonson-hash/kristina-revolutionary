"""Retiring HTTP clients must not break the actual Telegram application."""

import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("path", [
    "mobile_api.py",
    "web_server.py",
    "mobile_app",
    "mini_app",
    "deploy/kristina-web.service",
    "install-service.sh",
    "server-setup.sh",
    "kristina-manager.sh",
])
def test_retired_entrypoints_and_installers_are_absent(path):
    assert not (ROOT / path).exists()


def test_telegram_registers_agents_without_legacy_auth_or_network(tmp_path):
    """Use a fresh interpreter so another test cannot supply cached imports."""
    env = {
        **os.environ,
        "PYTHONPATH": str(ROOT),
        "DEEPSEEK_API_KEY": "test-key-not-real",
        "KRISTINA_TELEGRAM_TOKEN": "123456:telegram-test-placeholder",
        "KRISTINA_STATE_DB": str(tmp_path / "emotional_state.db"),
        "PYTHON_DOTENV_DISABLED": "1",
    }
    env.pop("JWT_SECRET_KEY", None)
    code = textwrap.dedent("""
        import importlib.abc
        import os
        import socket
        import sys

        class NoLegacyImports(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                assert fullname.split(".")[0] not in {
                    "mobile_api", "web_server", "jose", "passlib", "slowapi"
                }, f"Legacy dependency: {fullname}"
                return None

        def no_network(*args, **kwargs):
            raise AssertionError("Telegram startup smoke must not access the network")

        sys.meta_path.insert(0, NoLegacyImports())
        socket.socket.connect = no_network
        socket.socket.connect_ex = no_network
        socket.create_connection = no_network
        assert "JWT_SECRET_KEY" not in os.environ

        import bot
        bot.init_agents()
        assert {"Kristina", "Kristina-Advisor", "Kristina-Creative", "TrendScout"} <= set(bot.router.agents)
        assert bot.router.default_agent.name == "Kristina"
        assert callable(bot.main)
        assert callable(bot.handle_message)
        assert callable(bot.setup_proactive_messaging)
        assert callable(bot.setup_weekly_trends)
        assert callable(bot.shadow_command)
        print("TELEGRAM_ENTRYPOINT_OK")
    """)
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "TELEGRAM_ENTRYPOINT_OK" in result.stdout
