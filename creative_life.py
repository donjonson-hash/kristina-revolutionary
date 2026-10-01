"""Creative life: Kristina writes a thought from her real emotional state.

Replaces the detached `autonomous_life` prototype. Differences that matter:
- the thought is generated from the shared, persistent EmotionalCore, never a copy;
- writing a thought is an emotional event (`creative_expression`) applied atomically
  through `EmotionalCore.evolve`, so creativity drops and a natural pause follows;
- the diary is SQLite and survives restarts;
- publication is a separate step: this module only produces and records thoughts.

Generation is injected as an async callable so LLM failures raise instead of
being recorded as Kristina's words (AIClient.chat returns apology strings on error).
"""

import json
import logging
import random
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Awaitable, Callable, Dict, Optional

from emotional_core import STOCKHOLM
from kristina_identity import BASE_IDENTITY, WORK_LIFE_THEMES

logger = logging.getLogger(__name__)

MIN_THOUGHT_CHARS = 80
MAX_THOUGHT_CHARS = 900
# AIClient/AIAdapter hide provider failures behind these; a diary must not keep them.
_FALLBACK_MARKERS = ("что-то с интернетом", "я тут задумалась", "мысли запутались", "мысли ускользают")


def time_of_day(now: datetime) -> str:
    hour = now.astimezone(STOCKHOLM).hour
    if 6 <= hour < 12:
        return "утро"
    if 12 <= hour < 18:
        return "день"
    if 18 <= hour < 23:
        return "вечер"
    return "ночь"


def thought_prompt(theme: str, emotional_state: Dict, now: datetime) -> str:
    state = emotional_state.get("state", {})
    return (
        f"ТЕМА СЕГОДНЯ: {theme}\n"
        f"Настроение: {emotional_state.get('mood_description', 'спокойная')}, "
        f"время: {time_of_day(now)}, энергия {state.get('energy', 0.5):.0%}, "
        f"любопытство {state.get('curiosity', 0.5):.0%}\n\n"
        "Ты ведёшь личный блог. Напиши одну запись от первого лица.\n"
        "Если тема связана с работой, пиши как travel writer: конкретное место, наблюдение, человек, дорога или деталь, "
        "но не выдумывай текущую поездку, встречу или внешний факт ради красивой записи.\n"
        "Если тема личная, не превращай её автоматически в путевой очерк.\n"
        "4-6 предложений, 300-500 символов. Живо, разговорно, с эмоциями и деталями. "
        "1-3 эмодзи, только если уместно. Без заголовка и без обращения к читателю.\n\n"
        "Запись:"
    )


def validate_thought(text) -> str:
    if not isinstance(text, str):
        raise ValueError("Thought must be text")
    cleaned = re.sub(r"\s+\n", "\n", text.strip())
    if len(cleaned) < MIN_THOUGHT_CHARS:
        raise ValueError("Thought is too short to be a diary entry")
    lowered = cleaned.lower()
    if any(marker in lowered for marker in _FALLBACK_MARKERS):
        raise ValueError("Provider fallback text is not a thought")
    return cleaned[:MAX_THOUGHT_CHARS]


class CreativeDiary:
    """Persistent record of thoughts; publication state is filled in later."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        with closing(sqlite3.connect(db_path)) as conn, conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS creative_diary (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                theme TEXT NOT NULL,
                thought TEXT NOT NULL,
                mood TEXT NOT NULL,
                state_json TEXT NOT NULL,
                published_at TEXT,
                publish_target TEXT
            )""")

    def record(self, *, created_at: datetime, theme: str, thought: str, emotional_state: Dict) -> int:
        with closing(sqlite3.connect(self.db_path, timeout=5)) as conn, conn:
            cursor = conn.execute(
                "INSERT INTO creative_diary (created_at, theme, thought, mood, state_json) VALUES (?,?,?,?,?)",
                (created_at.isoformat(), theme, thought, emotional_state.get("mood_description", ""),
                 json.dumps(emotional_state.get("state", {}), ensure_ascii=False)),
            )
            return cursor.lastrowid

    def recent(self, limit: int = 20):
        with closing(sqlite3.connect(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM creative_diary ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]

    def last_created_at(self) -> Optional[datetime]:
        with closing(sqlite3.connect(self.db_path)) as conn:
            row = conn.execute("SELECT created_at FROM creative_diary ORDER BY id DESC LIMIT 1").fetchone()
        return datetime.fromisoformat(row[0]) if row else None

    def mark_published(self, entry_id: int, *, at: datetime, target: str) -> bool:
        with closing(sqlite3.connect(self.db_path, timeout=5)) as conn, conn:
            cursor = conn.execute(
                "UPDATE creative_diary SET published_at=?, publish_target=? WHERE id=? AND published_at IS NULL",
                (at.isoformat(), target, entry_id))
            return cursor.rowcount == 1


def ai_generate(client) -> Callable[[str, str], Awaitable[str]]:
    """Adapt AIClient.chat to the (prompt, system_prompt) contract."""
    async def generate(prompt: str, system_prompt: str) -> str:
        return await client.chat(
            [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}],
            temperature=0.9, max_tokens=400,
        )
    return generate


def creative_decision(
    emotional_state: Dict,
    last_expression: Optional[datetime],
    now: datetime,
    desire_engine,
    decision_engine,
    *,
    organism_projection=None,
):
    """Decide whether Kristina writes now. Reuses the shared desire/decision layer.

    The `share` desire's distance term is fed with hours since the last diary
    entry: creative pressure builds with silence, and the entry itself lowers
    creativity, so a natural rhythm emerges without a timer.
    """
    from autonomy_decision import AutonomousDecision
    if emotional_state.get("is_night"):
        return AutonomousDecision("none", None, 0.0, "night")
    hours = (now - last_expression).total_seconds() / 3600.0 if last_expression else 24.0
    decision_context = {"hours_since_contact": hours}
    if organism_projection is not None:
        decision_context["organism_projection"] = organism_projection
    desires = desire_engine.calculate(emotional_state, decision_context)
    return decision_engine.decide({"share": desires["share"], "be_alone": desires["be_alone"]},
                                  {"last_proactive": last_expression}, now=now)


class CreativeLife:
    def __init__(self, core, diary: CreativeDiary, generate: Callable[[str, str], Awaitable[str]],
                 *, clock=None, choose_theme=None):
        self.core = core
        self.diary = diary
        self.generate = generate
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._choose_theme = choose_theme or (lambda: random.choice(WORK_LIFE_THEMES))

    async def express(self) -> Dict:
        """Write one diary entry from the live emotional state and apply its effect."""
        now = self._clock()
        emotional_state = self.core.get_emotional_state()
        theme = self._choose_theme()
        prompt = thought_prompt(theme, emotional_state, now)
        thought = validate_thought(await self.generate(prompt, BASE_IDENTITY))
        entry_id = self.diary.record(created_at=now, theme=theme, thought=thought, emotional_state=emotional_state)
        # The diary write is the source of truth; the emotional effect follows it.
        # A crash between the two leaves an entry without its effect, never a
        # phantom effect without an entry.
        after = self.core.evolve({"creative_expression": True})
        logger.info("Creative diary entry %s written (theme=%s)", entry_id, theme)
        return {"id": entry_id, "theme": theme, "thought": thought, "state": after["state"]}
