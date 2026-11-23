"""Тесты живого моста Telegram -> SynapticGraphEngine без сохранения PII (kristina-revolutionary)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from live_synaptic_bridge import pulse_live_telegram_turn


@pytest.mark.asyncio
async def test_live_telegram_turn_pulses_synapses_with_zero_pii(tmp_path: Path) -> None:
    db_path = str(tmp_path / "kristina_state.db")
    secret_msg = "Привет, Кристина! Мой телефон +46701112233, как продвигается твоя книга про дороги?"

    res = await pulse_live_telegram_turn(
        secret_msg,
        "Привет! Сегодня дописывала главу про утренний паром.",
        scope_id="default",
        db_path=db_path,
    )
    assert res is not None
    assert res["pulse_seq"] == 1
    assert len(res["packet_trace"]) >= 1

    # Убеждаемся, что приватный текст сообщения НИГДЕ не записан в SQLite
    with sqlite3.connect(db_path) as conn:
        dump = "\n".join(conn.iterdump())
        assert "+46701112233" not in dump
        assert "книга про дороги" not in dump


@pytest.mark.asyncio
async def test_live_telegram_conflict_blocks_proactive_outreach(tmp_path: Path) -> None:
    db_path = str(tmp_path / "kristina_state.db")
    res = await pulse_live_telegram_turn(
        "Всё сломалось, ужасная ошибка, не работает вообще!",
        "Сейчас спокойно разберёмся.",
        scope_id="default",
        db_path=db_path,
    )
    assert res is not None
    assert "gate_proactive_outreach" not in res["opened_motor_gates"]
