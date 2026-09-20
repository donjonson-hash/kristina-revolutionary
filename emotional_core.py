#!/usr/bin/env python3
"""
Emotional Evolution v2.0 — Kristina меняется как живой человек
"""

import json
import math
import os
import re
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Dict
import logging

logger = logging.getLogger(__name__)
STOCKHOLM = ZoneInfo("Europe/Stockholm")

class EmotionalCore:
    """Эмоциональное ядро Кристины — эволюционирует со временем"""
    
    def __init__(self, db_path=None, clock=None, *, appraisal_observer=None):
        self.traits = {
            "extraversion": 0.7,
            "neuroticism": 0.4,
            "openness": 0.8,
            "agreeableness": 0.6,
            "conscientiousness": 0.5
        }
        
        self.state = {
            "energy": 0.7,
            "happiness": 0.6,
            "curiosity": 0.8,
            "anxiety": 0.3,
            "loneliness": 0.4,
            "creativity": 0.6,
            "irritation": 0.1
        }
        
        self.recent_experiences = []
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.last_update = self._now()
        self.db_path = db_path
        self._lock = threading.RLock()
        self._experiment_ids = set()
        self.appraisal_observer = appraisal_observer
        if db_path is not None:
            with closing(sqlite3.connect(db_path)) as conn, conn:
                conn.execute("""CREATE TABLE IF NOT EXISTS emotional_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
                )""")
                conn.execute("""CREATE TABLE IF NOT EXISTS experiment_effects (
                    experiment_id TEXT PRIMARY KEY, outcome TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                )""")
            self.evolve()
        
    def _now(self):
        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("EmotionalCore clock must return an aware datetime")
        return now.astimezone(timezone.utc)

    def evolve(self, context: Dict = None, *, observation=None) -> Dict:
        """Advance by elapsed time, then apply one observed event; persist atomically."""
        with self._lock:
            previous = self._payload()
            try:
                if self.db_path is None:
                    before = self._advance(self._now(), context)
                else:
                    # Reload under a write lock so bot/web processes cannot overwrite
                    # each other's events with an old in-memory snapshot.
                    with closing(sqlite3.connect(self.db_path, timeout=5)) as conn, conn:
                        conn.execute("BEGIN IMMEDIATE")
                        row = conn.execute("SELECT payload FROM emotional_state WHERE id = 1").fetchone()
                        if row:
                            self._restore(json.loads(row[0]))
                        before = self._advance(self._now(), context)
                        conn.execute(
                            "INSERT OR REPLACE INTO emotional_state (id, payload) VALUES (1, ?)",
                            (json.dumps(self._payload()),),
                        )
            except Exception:
                self._restore(previous)
                raise
            snapshot = self.get_emotional_state()
            # Both snapshots are from this one event under the core lock and,
            # when persistent, after reload under BEGIN IMMEDIATE. Notify only
            # AFTER commit; a rejected database write must leave no shadow trace.
            if self.appraisal_observer is not None and observation is not None:
                try:
                    from experiments.appraisal_observer import AppraisalSource
                    if (not isinstance(observation, AppraisalSource)
                            or not context or not observation.matches(context.get("appraisal"))):
                        raise ValueError("observation does not match applied appraisal")
                    self.appraisal_observer.observe(
                        observation, at=self.last_update,
                        before=before.copy(), after=self.state.copy(),
                    )
                except Exception as exc:
                    # Shadow failure cannot change the successful ordinary event.
                    # Never log message text, model output, or source identifiers.
                    logger.warning("Appraisal shadow observation unavailable: %s", type(exc).__name__)
            return snapshot

    def record_experiment(self, experiment_id: str, outcome: str) -> bool:
        """Apply a completed experiment once, atomically with its durable receipt."""
        if not isinstance(experiment_id, str) or re.fullmatch(r"[0-9a-f]{32}", experiment_id) is None:
            raise ValueError("experiment_id must be a UUID hex string")
        if not isinstance(outcome, str) or outcome not in ("supported_on_cases", "counterexample_found"):
            raise ValueError("Invalid experiment outcome")
        with self._lock:
            previous = self._payload()
            try:
                if self.db_path is None:
                    if experiment_id in self._experiment_ids:
                        return False
                    self._apply_experiment_effects(outcome)
                    self._experiment_ids.add(experiment_id)
                else:
                    with closing(sqlite3.connect(self.db_path, timeout=5)) as conn, conn:
                        conn.execute("BEGIN IMMEDIATE")
                        row = conn.execute("SELECT payload FROM emotional_state WHERE id = 1").fetchone()
                        if row:
                            self._restore(json.loads(row[0]))
                        if conn.execute(
                            "SELECT 1 FROM experiment_effects WHERE experiment_id = ?", (experiment_id,)
                        ).fetchone():
                            return False
                        self._apply_experiment_effects(outcome)
                        conn.execute(
                            "INSERT INTO experiment_effects (experiment_id, outcome, applied_at) VALUES (?, ?, ?)",
                            (experiment_id, outcome, self.last_update.isoformat()),
                        )
                        conn.execute(
                            "INSERT OR REPLACE INTO emotional_state (id, payload) VALUES (1, ?)",
                            (json.dumps(self._payload()),),
                        )
            except Exception:
                self._restore(previous)
                raise
            return True

    def _apply_experiment_effects(self, outcome):
        self._advance(self._now(), None)
        if outcome == "supported_on_cases":
            self.state["happiness"] += 0.03
        else:
            self.state["curiosity"] += 0.04
            self.state["irritation"] += 0.01
        self._normalize_state()

    def _payload(self):
        return {"version": 2, "state": self.state.copy(),
                "last_update": self.last_update.isoformat(),
                "recent_experiences": [event.copy() for event in self.recent_experiences]}

    def _restore(self, payload):
        state = payload["state"]
        updated = datetime.fromisoformat(payload["last_update"])
        experiences = payload["recent_experiences"]
        if (payload.get("version") not in (1, 2) or set(state) != set(self.state)
                or any(type(v) not in (int, float) or not math.isfinite(v)
                       or not 0.1 <= v <= 1.0 for v in state.values())
                or updated.tzinfo is None or updated.utcoffset() is None
                or not isinstance(experiences, list)
                or any(not isinstance(event, dict)
                       or set(event) != {"event", "at"}
                       or event["event"] not in ("user_message", "negative_tone", "appraisal_curiosity",
                                              "appraisal_warmth", "appraisal_concern", "appraisal_frustration")
                       or not isinstance(event["at"], str) for event in experiences)):
            raise ValueError("Invalid persisted emotional state; refusing to reset it")
        self.state = state
        self.last_update = updated.astimezone(timezone.utc)
        self.recent_experiences = experiences[-20:]

    def _advance(self, now, context):
        # A backwards wall-clock adjustment must not make us evolve twice later.
        now = max(now, self.last_update)
        cursor = self.last_update
        while cursor < now:
            boundary = cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            end = min(now, boundary)
            self._apply_circadian_rhythm(
                cursor.astimezone(STOCKHOLM).hour,
                (end - cursor).total_seconds() / 3600,
            )
            cursor = end
        self.last_update = now
        # Circadian change precedes this snapshot; only this event's ordinary
        # message + appraisal effects become the observer's direct impulse.
        before = self.state.copy()
        if context:
            self._apply_context_effects(context)
        self._normalize_state()
        return before

    def _apply_circadian_rhythm(self, hour: int, elapsed_hours: float):
        """Relax toward hourly targets; the result does not depend on tick frequency."""
        targets = {"energy": 0.75, "happiness": 0.6, "curiosity": 0.8,
                   "anxiety": 0.3, "loneliness": 0.4, "creativity": 0.6,
                   "irritation": 0.1}
        if hour >= 23 or hour < 8:
            targets.update(energy=0.25, curiosity=0.35)
        elif hour < 11:
            targets["energy"] = 0.85
        elif 14 <= hour < 17:
            targets["energy"] = 0.6
        elif 17 <= hour < 23:
            targets.update(energy=0.55, curiosity=0.65, loneliness=0.5)
        decay = math.exp(-elapsed_hours / 4.0)
        for emotion, target in targets.items():
            self.state[emotion] = target + (self.state[emotion] - target) * decay

    def _apply_context_effects(self, context: Dict):
        """Only explicit events affect state; no guessing sentiment from keywords."""
        from cognitive_appraisal import Appraisal
        appraisal = context.get("appraisal")
        effects = appraisal.effects() if isinstance(appraisal, Appraisal) else {}
        events = []
        if context.get("user_message"):
            self.state["energy"] -= 0.025
            self.state["curiosity"] += 0.015
            self.state["loneliness"] -= 0.04
            events.append("user_message")
        if context.get("negative_tone", False):
            self.state["irritation"] += 0.2
            events.append("negative_tone")
        for emotion, change in effects.items():
            self.state[emotion] += change
        if effects:
            events.append("appraisal_" + appraisal.reaction)
        for event in events:
            self.recent_experiences.append({"event": event, "at": self.last_update.isoformat()})
        self.recent_experiences = self.recent_experiences[-20:]

    def _normalize_state(self):
        """Нормализация"""
        for emotion in self.state:
            self.state[emotion] = max(0.1, min(1.0, self.state[emotion]))
    
    def _is_night(self):
        hour = self.last_update.astimezone(STOCKHOLM).hour
        return hour >= 23 or hour < 8

    def get_emotional_state(self) -> Dict:
        """Получить состояние"""
        dominant = max(self.state, key=self.state.get)
        
        return {
            "state": self.state.copy(),
            "traits": self.traits.copy(),
            "dominant_emotion": dominant,
            "dominant_value": self.state[dominant],
            "mood_description": self._describe_mood(),
            "for_llm": self._craft_emotional_prompt(),
            "updated_at": self.last_update.isoformat(),
            "is_night": self._is_night(),
            "recent_experiences": [event.copy() for event in self.recent_experiences]
        }
    
    def _describe_mood(self) -> str:
        """Текстовое описание настроения"""
        energy = self.state["energy"]
        happiness = self.state["happiness"]
        
        if self._is_night():
            return "Сонная, нуждается в отдыхе"
        if energy > 0.7 and happiness > 0.6:
            return "Энергичная и позитивная"
        elif energy < 0.4:
            return "Уставшая, нуждается в отдыхе"
        elif self.state["curiosity"] > 0.7:
            return "Любопытная, вовлечённая"
        else:
            return "Спокойная, сбалансированная"
    
    def _craft_emotional_prompt(self) -> str:
        """Промпт для LLM"""
        energy = self.state["energy"]
        happiness = self.state["happiness"]
        
        modifiers = []
        if self._is_night():
            modifiers.append("сонная, короткие ответы")
        elif energy > 0.8:
            modifiers.append("энергичная, много эмодзи")
        elif energy < 0.4:
            modifiers.append("уставшая, короткие ответы")
            
        mod_text = ", ".join(modifiers) if modifiers else "естественный тон"
        return f"Стиль: {mod_text}."

# Глобальный экземпляр
_emotional_core = None

def get_emotional_core():
    global _emotional_core
    if _emotional_core is None:
        observer = None
        if os.getenv("KRISTINA_EMOTIONAL_LINKS_OBSERVER") == "1":
            from experiments.appraisal_observer import AppraisalLinkObserver
            observer = AppraisalLinkObserver()
        _emotional_core = EmotionalCore(db_path=os.getenv("KRISTINA_STATE_DB", "kristina_state.db"),
                                        appraisal_observer=observer)
    return _emotional_core
