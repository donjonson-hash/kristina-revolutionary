"""Admin-only Telegram access to read-only shadow telemetry reports."""

import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

from emotional_core import EmotionalCore


def _update(user_id):
    return SimpleNamespace(
        effective_user=SimpleNamespace(id=user_id),
        message=SimpleNamespace(reply_text=AsyncMock()),
    )


def _context(*args):
    return SimpleNamespace(args=list(args))


async def test_shadow_command_denies_non_admin_without_touching_store(tmp_path, monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    monkeypatch.setenv("KRISTINA_ADMIN_IDS", "42")
    bot = importlib.import_module("bot")

    def must_not_open():
        raise AssertionError("non-admin must not read shadow telemetry")

    monkeypatch.setattr(bot, "get_shadow_telemetry_store", must_not_open)
    update = _update(99)

    await bot.shadow_command(update, _context("24h"))

    update.message.reply_text.assert_awaited_once_with(
        "⛔ Команда доступна только администратору."
    )


async def test_shadow_command_defaults_to_24h_for_admin(tmp_path, monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    monkeypatch.setenv("KRISTINA_ADMIN_IDS", "42")
    bot = importlib.import_module("bot")

    core = EmotionalCore(str(tmp_path / "state.db"))
    monkeypatch.setattr(bot, "emotional_core", core)
    monkeypatch.setattr(bot, "_shadow_telemetry_store", None)
    monkeypatch.setattr(bot, "_shadow_telemetry_path", None)

    update = _update(42)
    await bot.shadow_command(update, _context())

    text = update.message.reply_text.await_args.args[0]
    assert "Shadow telemetry — последние 24 часа" in text
    assert "Наблюдений: 0" in text
    assert "Baseline" in text


async def test_shadow_command_accepts_7d_and_rejects_unknown_window(tmp_path, monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    monkeypatch.setenv("KRISTINA_ADMIN_IDS", "42")
    bot = importlib.import_module("bot")

    core = EmotionalCore(str(tmp_path / "state.db"))
    monkeypatch.setattr(bot, "emotional_core", core)
    monkeypatch.setattr(bot, "_shadow_telemetry_store", None)
    monkeypatch.setattr(bot, "_shadow_telemetry_path", None)

    update = _update(42)
    await bot.shadow_command(update, _context("7d"))
    assert "последние 7 дней" in update.message.reply_text.await_args.args[0]

    invalid = _update(42)
    await bot.shadow_command(invalid, _context("30d"))
    invalid.message.reply_text.assert_awaited_once_with(
        "Используй: /shadow 24h, /shadow 7d или /shadow all"
    )


async def test_shadow_command_requires_explicit_admin_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    monkeypatch.delenv("KRISTINA_ADMIN_IDS", raising=False)
    bot = importlib.import_module("bot")
    update = _update(42)

    await bot.shadow_command(update, _context("24h"))

    update.message.reply_text.assert_awaited_once_with(
        "⛔ Команда доступна только администратору."
    )
