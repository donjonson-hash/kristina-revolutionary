"""
Мост реального времени Telegram -> SynapticGraphEngine (kristina-revolutionary).
При каждом ответе Кристины в Telegram:
1) Синхронизирует только числовые оси быстрых эмоций из emotional_state(id=1) в brain_fast_state(scope_id='default').
2) Генерирует обезличенные сенсорные токи (без сохранения текста сообщений, имён или chat_id).
3) Прогоняет импульс через SynapticGraphEngine в kristina_state.db (SQLite WAL), мгновенно оживляя онлайн-обсерваторию.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kristina_brain import AsyncSQLiteStateStore, BrainEngine

logger = logging.getLogger(__name__)

_LAST_TURN_TS: float | None = None

_WARM_CUES: tuple[str, ...] = (
    "спасибо",
    "благодар",
    "класс",
    "супер",
    "тепл",
    "рад",
    "любл",
    "добр",
    "привет",
    "обним",
    "уют",
    "красиво",
    "интересн",
    "❤️",
    "😊",
    "🔥",
)

_CONFLICT_CUES: tuple[str, ...] = (
    "плохо",
    "ошибк",
    "бесит",
    "злюсь",
    "сломал",
    "не работает",
    "жалоб",
    "отстан",
    "глуп",
    "ужас",
    "туп",
)


def resolve_state_db_path() -> str:
    explicit = os.environ.get("BRAIN_CORE_DB") or os.environ.get("KRISTINA_STATE_DB")
    if explicit:
        return str(explicit)
    return str(Path(__file__).resolve().parent / "kristina_state.db")


def _sync_legacy_numeric_emotions(db_path: str, scope_id: str = "default") -> dict[str, float]:
    """Копирует исключительно числовые оси из legacy emotional_state(id=1) в brain_fast_state без текста."""
    axes: dict[str, float] = {
        "happiness": 0.55,
        "energy": 0.65,
        "curiosity": 0.60,
        "anxiety": 0.15,
        "irritation": 0.08,
        "fatigue": 0.18,
        "trust": 0.58,
    }
    if db_path == ":memory:" or not Path(db_path).exists():
        return axes

    try:
        with sqlite3.connect(db_path, timeout=3.0) as conn:
            conn.row_factory = sqlite3.Row
            tables = {
                str(r[0])
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            if "emotional_state" in tables:
                row = conn.execute("SELECT * FROM emotional_state WHERE id = 1").fetchone()
                if row is not None:
                    keys = set(row.keys())
                    for k in list(axes.keys()):
                        if k in keys and isinstance(row[k], (int, float)):
                            axes[k] = max(0.0, min(1.0, round(float(row[k]), 4)))
    except Exception as exc:
        logger.debug("Legacy emotion read skipped: %s", exc)
    return axes


def compute_zero_pii_stimuli(
    message_text: str,
    axes: dict[str, float],
    *,
    silence_seconds: float = 0.0,
) -> dict[str, float]:
    """Переводит структуру реплики в чистые токи сенсорных нейронов [0.0..1.0] (текст не сохраняется)."""
    low = (message_text or "").lower()
    char_len = len(low.strip())

    q_boost = 0.26 if "?" in low else 0.0
    len_boost = min(0.32, char_len / 220.0)
    warm_hits = sum(1 for w in _WARM_CUES if w in low)
    conflict_hits = sum(1 for c in _CONFLICT_CUES if c in low)

    curiosity_i = min(0.96, round(0.32 + 0.28 * axes.get("curiosity", 0.55) + q_boost + len_boost, 4))
    warmth_i = min(
        0.95,
        round(
            0.28
            + 0.25 * axes.get("happiness", 0.5)
            + 0.18 * axes.get("trust", 0.5)
            + min(0.32, warm_hits * 0.16),
            4,
        ),
    )
    conflict_i = (
        min(0.95, round(0.42 + min(0.48, conflict_hits * 0.24) + 0.25 * axes.get("irritation", 0.1), 4))
        if conflict_hits > 0 or axes.get("irritation", 0.0) >= 0.55
        else round(0.12 * axes.get("irritation", 0.08), 4)
    )
    silence_i = (
        min(0.88, round(0.45 + min(0.40, silence_seconds / 7200.0), 4))
        if silence_seconds >= 900.0
        else 0.10
    )

    return {
        "sensor_curiosity": curiosity_i,
        "sensor_warmth": warmth_i,
        "sensor_conflict": conflict_i,
        "sensor_silence_window": silence_i,
    }


async def pulse_live_telegram_turn(
    message_text: str,
    response_text: str = "",
    *,
    scope_id: str = "default",
    db_path: str | None = None,
) -> dict[str, Any] | None:
    """Безопасно отправляет живой синаптический импульс в kristina_state.db после ответа бота."""
    global _LAST_TURN_TS
    now_ts = time.monotonic()
    gap_s = (now_ts - _LAST_TURN_TS) if _LAST_TURN_TS is not None else 1200.0
    _LAST_TURN_TS = now_ts

    target_db = db_path or resolve_state_db_path()
    try:
        axes = _sync_legacy_numeric_emotions(target_db, scope_id=scope_id)
        stimuli = compute_zero_pii_stimuli(message_text, axes, silence_seconds=gap_s)

        store = AsyncSQLiteStateStore(target_db)
        engine = BrainEngine(store)
        await engine.start()
        try:
            # Обновляем быстрое состояние только числовой реакцией без сохранения текста или цитат
            reaction = "conflict" if stimuli["sensor_conflict"] >= 0.45 else (
                "warmth" if stimuli["sensor_warmth"] >= 0.55 else "curiosity"
            )
            await engine.emotions.evolve(
                scope_id,
                context={"hours_since_contact": round(gap_s / 3600.0, 4)},
                reaction=reaction,
                intensity=max(stimuli["sensor_curiosity"], stimuli["sensor_warmth"], stimuli["sensor_conflict"]),
                reflection=None,
            )
            _ = len(response_text)
            _ = datetime.now(UTC)
            return await engine.pulse_synapses(scope_id, stimuli)
        finally:
            await engine.shutdown()
    except Exception as exc:
        logger.warning("Live synaptic pulse skipped cleanly: %s", exc)
        return None
