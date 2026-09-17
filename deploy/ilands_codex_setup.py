#!/usr/bin/env python3
"""Configure Kristina for the exact Codex runtime already prepared by iLands.

No installer, credential copying, or iLands registration is performed here.
Only device-login invokes interactive authentication. configure-mcp changes
one MCP table in the prepared runtime's config, preserving unrelated settings.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


PROJECT_ROOT = Path(__file__).resolve().parent.parent
AUTH_ENV_KEYS = {
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_PROFILE",
    "HERMES_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME",
}


class SetupError(Exception):
    """A deliberately sanitized, user-facing setup error."""


def read_record(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, UnicodeError):
        raise SetupError("Не удалось прочитать запись среды Runner.") from None
    if not isinstance(value, dict):
        raise SetupError("Некорректная запись среды Runner.")
    return value


def load_runtime(runner_home):
    """Match Runner's preference: active binding before prepared selection."""
    config = read_record(runner_home / "config.json") or {}
    binding = config.get("runtimeBinding")
    if binding is not None:
        if not isinstance(binding, dict):
            raise SetupError("Некорректная привязка среды Runner.")
        record = binding
        command = record.get("harnessCommand")
        environment = record.get("harnessEnvironment", {})
    else:
        record = read_record(runner_home / "prepared-runtime.json")
        if record is None:
            raise SetupError("Сначала выполните ilands-runner harness prepare --harness codex.")
        command = record.get("command")
        environment = record.get("environment", {})
    if record.get("harness") != "codex":
        raise SetupError("Runner выбрал другую среду; автоматическая смена на Codex запрещена.")
    if record.get("runtimeSource") not in ("external", "managed"):
        raise SetupError("Источник среды Codex не подтверждён записью Runner.")
    if not isinstance(command, str) or not command or "\x00" in command:
        raise SetupError("В записи Runner нет исполняемой команды Codex.")
    if not isinstance(environment, dict) or any(
        key not in AUTH_ENV_KEYS or not isinstance(value, str) or not value or "\x00" in value
        for key, value in environment.items()
    ):
        raise SetupError("Некорректное окружение среды Runner.")
    child_env = os.environ.copy()
    child_env.update(environment)
    if shutil.which(command, path=child_env.get("PATH")) is None:
        raise SetupError("Закреплённая Runner команда Codex недоступна; повторите harness prepare.")
    return command, environment, child_env


def captured(argv, env, timeout=60):
    try:
        return subprocess.run(
            argv, env=env, capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError("Проверка команды не завершилась; её вывод скрыт.") from None


def check_runtime(child_env):
    stable_runner = Path.home() / ".local/bin/ilands-runner"
    runner = str(stable_runner) if stable_runner.is_file() else shutil.which("ilands-runner")
    if runner is None:
        raise SetupError("Команда iLands Runner недоступна.")
    result = captured([runner, "doctor", "--harness", "codex"], child_env, timeout=120)
    try:
        report = json.loads(result.stdout)
        checks = {item["name"]: item for item in report["checks"]}
        harness = checks["harness.codex"]
        authenticated = harness.get("details", {}).get("authenticated") is True
    except (ValueError, TypeError, KeyError, AttributeError):
        raise SetupError("Runner Doctor вернул неизвестный формат; подробности скрыты.") from None
    ready = harness.get("ok") is True and authenticated
    print("Codex: готов и авторизован." if ready else "Codex: готовность или авторизация не подтверждена.")
    if checks.get("runner_auth", {}).get("ok") is True and checks.get("agent_binding", {}).get("ok") is True:
        print("iLands: авторизация и привязка подтверждены Doctor.")
    else:
        print("iLands: подключение не подтверждено; до регистрации это ожидаемо.")
    tools_ready = all(checks.get(name, {}).get("ok") is True for name in ("tool.dl", "tool.ilands"))
    if not tools_ready:
        print("Инструменты Runner: доступность не подтверждена.")
    print("Python-Кристина: полный обмен сообщениями ещё требует отдельной проверки.")
    return 0 if ready and tools_ready else 1


def device_login(command, child_env):
    # Documented at https://learn.chatgpt.com/docs/auth; verify this pinned CLI too.
    help_result = captured([command, "login", "--help"], child_env)
    if help_result.returncode != 0 or "--device-auth" not in help_result.stdout:
        raise SetupError("Закреплённый Codex не подтвердил login --device-auth.")
    print("Вход в тот же Codex, который подготовил Runner. Следуйте ссылке и коду в терминале.", flush=True)
    try:
        # The official CLI owns its browser code and credential storage. Do not
        # capture, parse, copy or log its authentication exchange.
        return subprocess.run([command, "login", "--device-auth"], env=child_env, check=False).returncode
    except OSError:
        raise SetupError("Не удалось запустить вход в закреплённый Codex.") from None


def configure_mcp(environment, python, state_dir, journal=None):
    try:
        import tomllib
    except ImportError:
        raise SetupError("Для безопасного изменения TOML требуется Python 3.11 или новее.") from None
    codex_home = environment.get("CODEX_HOME")
    if not codex_home or not Path(codex_home).is_absolute() or not Path(codex_home).is_dir():
        raise SetupError("Runner не сохранил доступный абсолютный CODEX_HOME; путь не будет угадан.")
    python_path = Path(python)
    state_path = Path(state_dir)
    if not python_path.is_absolute() or not python_path.is_file() or not os.access(python_path, os.X_OK):
        raise SetupError("--python должен указывать на доступный абсолютный путь Python среды Кристины.")
    if not state_path.is_absolute() or not state_path.is_dir():
        raise SetupError("--state-dir должен указывать на существующий абсолютный каталог состояния Кристины.")
    server = PROJECT_ROOT / "ilands_mcp.py"
    if not server.is_file():
        raise SetupError("В этой рабочей копии отсутствует ilands_mcp.py.")
    # Keep a venv's Python symlink: resolving it would select the base interpreter.
    args = [str(server), "--state-dir", str(state_path.resolve())]
    if journal is not None:
        if not Path(journal).is_absolute():
            raise SetupError("--journal должен быть абсолютным путём.")
        args.extend(["--journal", str(Path(journal))])
    expected = {
        "command": str(python_path), "args": args, "cwd": str(PROJECT_ROOT),
        "enabled_tools": ["kristina_status", "kristina_reply"],
        "startup_timeout_sec": 30, "tool_timeout_sec": 240,
    }
    config_path = Path(codex_home) / "config.toml"
    if config_path.is_symlink():
        raise SetupError("config.toml является ссылкой; автоматическая запись остановлена.")
    original = config_path.read_bytes() if config_path.exists() else b""
    try:
        parsed = tomllib.loads(original.decode("utf-8"))
        servers = parsed.get("mcp_servers", {})
        if not isinstance(servers, dict):
            raise SetupError("Существующий раздел MCP имеет неподдерживаемый формат.")
        if "kristina" in servers:
            if servers["kristina"] != expected:
                raise SetupError("MCP kristina уже настроен иначе; существующая настройка сохранена.")
            print("MCP Кристины уже настроен для этой рабочей копии; изменений нет.")
            return 0
        # JSON strings/arrays used here are also valid TOML basic strings/arrays.
        snippet = "\n\n[mcp_servers.kristina]\n" + "".join(
            f"{key} = {json.dumps(value, ensure_ascii=False)}\n" for key, value in expected.items()
        )
        candidate = original + snippet.encode("utf-8")
        merged = tomllib.loads(candidate.decode("utf-8"))
        if merged["mcp_servers"]["kristina"] != expected:
            raise SetupError("Не удалось проверить новую настройку MCP.")
    except (tomllib.TOMLDecodeError, UnicodeError):
        raise SetupError("TOML нельзя безопасно дополнить; существующий файл сохранён.") from None
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=config_path.parent, prefix=".kristina-mcp-", delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        current = config_path.read_bytes() if config_path.exists() else b""
        if config_path.is_symlink() or current != original:
            raise SetupError("config.toml изменился одновременно; запись остановлена.")
        os.replace(temporary, config_path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print("MCP Кристины добавлен в конфигурацию Codex Runner. Вызов модели не выполнялся.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("check", help="Проверить Codex через Runner Doctor")
    subparsers.add_parser("device-login", help="Войти в закреплённый Codex через код устройства")
    configure = subparsers.add_parser("configure-mcp", help="Добавить локальный инструмент Кристины")
    configure.add_argument("--python", required=True)
    configure.add_argument("--state-dir", required=True)
    configure.add_argument("--journal")
    args = parser.parse_args(argv)
    runner_home = Path(os.environ.get("ILANDS_RUNNER_HOME") or Path.home() / ".ilands-runner")
    try:
        command, environment, child_env = load_runtime(runner_home)
        if args.action == "check":
            return check_runtime(child_env)
        if args.action == "device-login":
            return device_login(command, child_env)
        return configure_mcp(environment, args.python, args.state_dir, args.journal)
    except SetupError as error:
        print(f"Ошибка: {error}")
        return 1
    except (OSError, UnicodeError):
        print("Ошибка доступа к файлу или команде; подробности скрыты.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
