"""
Неблокирующий мост интеграции kristina-brain-core v0.4.0 в Telegram-рантайм (P1: AUD-01 + AUD-05).
- Исключает блокировку asyncio event loop синхронными транзакциями sqlite3 (Single-Worker WAL Executor).
- Сохраняет и восстанавливает буфер антиповтора recent_proactive и last_proactive между рестартами процесса.
- Подключает откалиброванную физику v0.4.0 (conflict_brake + rapport_gate) из пакета brain_core.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, Optional, TypeVar

from autonomy_decision import AutonomousDecision, OrganismProjection
from kristina_brain.autonomy import DecisionEngine as CoreV4DecisionEngine
from kristina_brain.autonomy import DesireEngine as CoreV4DesireEngine
from kristina_brain.modes import OrganismProjection as CoreV4Projection
from kristina_brain.world import is_hour_in_window, resolve_iana_timezone

T = TypeVar("T")

_SQLITE_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kristina-sqlite-async")
_core_v4_desire = CoreV4DesireEngine()
logger = logging.getLogger(__name__)


async def run_sqlite_nonblocking(fn: Callable[[], T]) -> T:
    """Выполняет синхронную операцию SQLite в выделенном потоке, не замораживая asyncio loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_SQLITE_EXECUTOR, fn)


def enable_wal_on_path(db_path: Optional[str]) -> None:
    """Включает WAL и busy_timeout=5000 на файле БД состояния (безопасно для in-memory и None)."""
    if not db_path or str(db_path) == ":memory:":
        return
    with sqlite3.connect(str(db_path), timeout=5.0) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=5000;")


def ensure_proactive_history_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_proactive_history (
            chat_id INTEGER PRIMARY KEY CHECK (chat_id > 0),
            last_proactive_at TEXT,
            recent_messages_json TEXT NOT NULL DEFAULT '[]'
        )
        """
    )


def save_proactive_delivery(
    memory: Any,
    chat_id: int,
    sent_at: datetime,
    recent_messages: Iterable[str],
) -> None:
    """Атомарно фиксирует время и последние 6 текстов проактивных сообщений чата (AUD-05 fix)."""
    if not hasattr(memory, "_get_connection"):
        return
    conn = memory._get_connection()
    stamp = sent_at.astimezone(timezone.utc).isoformat()
    payload = json.dumps(list(recent_messages)[-6:], ensure_ascii=False)
    with conn:
        ensure_proactive_history_table(conn)
        conn.execute(
            """
            INSERT INTO telegram_proactive_history(chat_id, last_proactive_at, recent_messages_json)
            VALUES (?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
                last_proactive_at = excluded.last_proactive_at,
                recent_messages_json = excluded.recent_messages_json
            """,
            (int(chat_id), stamp, payload),
        )


def load_proactive_history(memory: Any) -> Dict[int, Dict[str, Any]]:
    """Восстанавливает last_proactive и recent_proactive после рестарта systemd."""
    if not hasattr(memory, "_get_connection"):
        return {}
    conn = memory._get_connection()
    with conn:
        ensure_proactive_history_table(conn)
        rows = conn.execute(
            "SELECT chat_id, last_proactive_at, recent_messages_json FROM telegram_proactive_history"
        ).fetchall()

    restored: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        cid = int(row["chat_id"])
        raw_ts = row["last_proactive_at"]
        dt = datetime.fromisoformat(raw_ts).astimezone(timezone.utc) if raw_ts else None
        msgs = deque(json.loads(row["recent_messages_json"] or "[]")[-6:], maxlen=6)
        restored[cid] = {"last_proactive": dt, "recent": msgs}
    return restored


def to_v4_projection(legacy_proj: OrganismProjection) -> CoreV4Projection:
    """Конвертирует снимок 12 мод в откалиброванную физику v0.4.0 (conflict_brake + rapport_boost)."""
    devs = dict(legacy_proj.deviations)

    def d(key: str) -> float:
        return float(devs.get(key, 0.0))

    conflict_brake = (
        1.15 * max(0.0, d("social_overload"))
        + 1.35 * max(0.0, d("withdrawal_147"))
        + 1.40 * max(0.0, d("crisis_957"))
        + 1.60 * max(0.0, d("abandonment_wound"))
    )
    rapport_boost = 0.85 * max(0.0, d("empathy_963")) + 0.55 * max(0.0, d("agency_exec"))

    talk_bias = round(rapport_boost + 0.25 * d("validation_need") - conflict_brake, 4)
    share_bias = round(
        0.65 * d("creativity_357")
        + 0.45 * d("aesthetic_drive")
        + 0.45 * d("agency_exec")
        - 0.45 * d("self_critique")
        - 0.85 * conflict_brake,
        4,
    )
    ask_bias = round(
        0.60 * d("agency_exec")
        + 0.50 * d("empathy_963")
        - 0.55 * d("invisibility_wound")
        - 0.90 * conflict_brake,
        4,
    )
    be_alone_bias = round(conflict_brake + 0.35 * max(0.0, d("invisibility_wound")), 4)

    return CoreV4Projection(
        talk_bias=talk_bias,
        share_bias=share_bias,
        ask_bias=ask_bias,
        be_alone_bias=be_alone_bias,
        mode_deviations=devs,
        shifted_modes=tuple(legacy_proj.shifted),
    )


def evaluate_v4_proactive_decision(
    emotional_state: Dict[str, Any],
    legacy_proj: OrganismProjection,
    decision_context: Dict[str, Any],
    *,
    threshold: float = 0.62,
    cooldown_seconds: float = 7200.0,
    now: Optional[datetime] = None,
) -> AutonomousDecision:
    """Вычисляет решение по откалиброванной физике kristina-brain-core v0.4.0."""
    from datetime import timedelta

    v4_proj = to_v4_projection(legacy_proj)
    cp_tz = resolve_iana_timezone(
        decision_context.get("counterparty_timezone"),
        decision_context.get("counterparty_location"),
    )
    cp_night = False
    if cp_tz and now is not None:
        from zoneinfo import ZoneInfo
        cp_local = now.astimezone(ZoneInfo(cp_tz))
        cp_night = is_hour_in_window(cp_local.hour, (23, 8))
    ctx = {
        "hours_since_contact": decision_context.get("hours_since_contact", 0.0),
        "last_proactive": decision_context.get("last_proactive"),
        "is_night": bool(emotional_state.get("is_night", False)),
        "counterparty_is_night": cp_night,
        "organism_projection": v4_proj,
    }
    desires = _core_v4_desire.calculate(emotional_state, ctx)
    v4_dec = CoreV4DecisionEngine(
        threshold=threshold,
        cooldown=timedelta(seconds=cooldown_seconds),
    ).decide(desires, ctx, now=now)
    return AutonomousDecision(
        action=v4_dec.action,
        intention=v4_dec.intention,
        score=v4_dec.score,
        reason=v4_dec.reason,
    )


def is_v4_physics_enabled() -> bool:
    """Включено по умолчанию (прод). Отключить: KRISTINA_BRAIN_CORE_V4=0 для pure legacy."""
    raw = os.getenv("KRISTINA_BRAIN_CORE_V4", "1").strip().lower()
    return raw in ("1", "true", "yes", "on")


_COMPLETED_REM_NIGHTS: set[tuple[str, str]] = set()


def ensure_nightly_rem_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS nightly_rem_runs (
            scope_id TEXT NOT NULL,
            local_date TEXT NOT NULL,
            consolidated_at TEXT NOT NULL,
            dream_entry_id INTEGER,
            report_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (scope_id, local_date)
        )
        """
    )


async def maybe_run_nightly_rem_consolidation(
    memory: Any,
    emotional_core_obj: Any,
    *,
    scope_id: str = "default",
    now: Optional[datetime] = None,
    force: bool = False,
    generate_fn: Optional[Callable[[str, str], Any]] = None,
    overwrite: bool = False,
) -> Optional[Dict[str, Any]]:
    """Запускает ночное синаптическое самообучение и запись сна (03:00-04:59 Europe/Stockholm, 1 раз за ночь).

    Семантика (вариант 1):
      - force=True обходит ТОЛЬКО ночное окно 03:00-04:59; DB-claim уважается всегда.
      - Строго один сон на (scope_id, local_date): захват через INSERT OR IGNORE.
      - overwrite=True = явный пересчёт: перезаписывает claim и запускается заново.
    """
    from zoneinfo import ZoneInfo
    from ai_client import get_ai_client
    from creative_life import CreativeDiary, CreativeLife, ai_generate
    from self_learning import SelfLearningAgent

    ts = now or datetime.now(timezone.utc)
    st_now = ts.astimezone(ZoneInfo("Europe/Stockholm"))
    local_date = st_now.strftime("%Y-%m-%d")
    ts_utc_iso = ts.astimezone(timezone.utc).isoformat()

    # force=True обходит ТОЛЬКО ночное окно; DB-claim уважается всегда (кроме overwrite).
    if not force and st_now.hour not in (3, 4):
        return None

    # Быстрый путь in-memory: повтор той же ночи в рамках процесса (кроме overwrite).
    if not overwrite and (scope_id, local_date) in _COMPLETED_REM_NIGHTS:
        return None

    brain_db = getattr(emotional_core_obj, "db_path", None) or os.getenv("KRISTINA_STATE_DB", "kristina_state.db")
    if not brain_db or str(brain_db) == ":memory:":
        return None
    diary_db = getattr(memory, "db_path", None) or str(brain_db)
    if str(diary_db) == ":memory:":
        diary_db = str(brain_db)

    def _claim() -> bool:
        # INSERT OR IGNORE = атомарный захват ночи: ровно один победитель на
        # (scope_id, local_date). У проигравшего rowcount == 0 -> он выходит с None.
        # overwrite=True = явный пересчёт: INSERT OR REPLACE перезаписывает claim.
        op = "REPLACE" if overwrite else "IGNORE"
        with sqlite3.connect(str(brain_db), timeout=5.0) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
            ensure_nightly_rem_table(conn)
            cur = conn.execute(
                f"INSERT OR {op} INTO nightly_rem_runs(scope_id, local_date, consolidated_at, dream_entry_id, report_json) VALUES (?, ?, ?, NULL, ?)",
                (scope_id, local_date, ts_utc_iso, "{}"),
            )
            conn.commit()
            return bool(overwrite) or cur.rowcount == 1

    if not await run_sqlite_nonblocking(_claim):
        # Ночь уже захвачена другим прогоном/процессом — строго один сон на ночь.
        _COMPLETED_REM_NIGHTS.add((scope_id, local_date))
        return None

    knowledge_db = os.path.join(os.path.dirname(os.path.abspath(str(brain_db))), "kristina_knowledge.db")
    try:
        learner = SelfLearningAgent(db_path=knowledge_db, brain_db_path=str(brain_db))
        report = await learner.consolidate_sleep(scope_id=scope_id)
        seed = report.get("dream_seed") or {}

        dream_result: Optional[Dict[str, Any]] = None
        has_dream_material = bool(
            float(seed.get("vividness", 0.0)) >= 0.08
            or seed.get("sensory_fragments")
            or seed.get("creative_draft_bridge")
        )
        if has_dream_material:
            gen = generate_fn or ai_generate(get_ai_client())
            diary = CreativeDiary(str(diary_db))
            life = CreativeLife(emotional_core_obj, diary, gen, clock=lambda: ts)
            dream_result = await life.record_rem_dream(seed)
    except BaseException:
        # Откатываем незавершённый claim (dream_entry_id IS NULL), чтобы не блокировать
        # повторную попытку за эту ночь.
        def _rollback() -> None:
            with sqlite3.connect(str(brain_db), timeout=5.0) as conn:
                conn.execute("PRAGMA busy_timeout = 5000")
                ensure_nightly_rem_table(conn)
                conn.execute(
                    "DELETE FROM nightly_rem_runs WHERE scope_id = ? AND local_date = ? AND dream_entry_id IS NULL",
                    (scope_id, local_date),
                )
                conn.commit()

        try:
            await run_sqlite_nonblocking(_rollback)
        except Exception:
            logger.exception("nightly REM claim rollback failed")
        finally:
            _COMPLETED_REM_NIGHTS.discard((scope_id, local_date))
        raise

    def _finalize() -> None:
        with sqlite3.connect(str(brain_db), timeout=5.0) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
            ensure_nightly_rem_table(conn)
            conn.execute(
                """
                UPDATE nightly_rem_runs
                SET consolidated_at = ?, dream_entry_id = ?, report_json = ?
                WHERE scope_id = ? AND local_date = ?
                """,
                (
                    ts_utc_iso,
                    dream_result["id"] if dream_result else None,
                    json.dumps(report, ensure_ascii=False),
                    scope_id,
                    local_date,
                ),
            )
            conn.commit()

    await run_sqlite_nonblocking(_finalize)
    _COMPLETED_REM_NIGHTS.add((scope_id, local_date))
    return {"consolidation": report, "dream": dream_result, "local_date": local_date}

