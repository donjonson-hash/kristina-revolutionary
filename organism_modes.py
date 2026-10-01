"""Persistent slow organism modes for Kristina.

This module is intentionally passive in its first production stage. It owns a
slow state field in the same SQLite database as EmotionalCore, but it does not
change emotions, prompts, desires, decisions or publishing behaviour yet.

The next stages may feed validated events into this field. Keeping persistence
and time semantics separate first makes that later coupling observable and
reversible.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Dict, Optional


@dataclass(frozen=True)
class ModeDefinition:
    baseline: float
    half_life_hours: float


@dataclass(frozen=True)
class ModeState:
    name: str
    baseline: float
    amplitude: float
    phase: float
    half_life_hours: float
    updated_at: datetime


# Provisional engineering calibration, not a psychological or scientific claim.
# Baselines are the initial resting activations. Half-lives are expressed in
# hours so future decay is independent of heartbeat frequency.
DEFAULT_MODE_DEFINITIONS: Dict[str, ModeDefinition] = {
    "core_741": ModeDefinition(0.60, 168.0),
    "aesthetic_drive": ModeDefinition(0.25, 336.0),
    "empathy_963": ModeDefinition(0.35, 96.0),
    "validation_need": ModeDefinition(0.30, 72.0),
    "social_overload": ModeDefinition(0.15, 18.0),
    "withdrawal_147": ModeDefinition(0.20, 36.0),
    "creativity_357": ModeDefinition(0.22, 48.0),
    "agency_exec": ModeDefinition(0.30, 96.0),
    "invisibility_wound": ModeDefinition(0.18, 240.0),
    "abandonment_wound": ModeDefinition(0.12, 336.0),
    "self_critique": ModeDefinition(0.20, 72.0),
    "crisis_957": ModeDefinition(0.08, 24.0),
}

MODE_NAMES = tuple(DEFAULT_MODE_DEFINITIONS)

# Small deterministic deltas for validated, transport-stamped user events.
# These are engineering coefficients, not psychological measurements.
MODE_EVENT_DELTAS = {
    "user_message": {
        "empathy_963": 0.003,
        "withdrawal_147": -0.003,
        "abandonment_wound": -0.002,
    },
    "appraisal_curiosity": {
        "creativity_357": 0.008,
        "aesthetic_drive": 0.004,
        "agency_exec": 0.002,
    },
    "appraisal_warmth": {
        "empathy_963": 0.008,
        "validation_need": -0.004,
        "abandonment_wound": -0.004,
    },
    "appraisal_concern": {
        "empathy_963": 0.006,
        "social_overload": 0.002,
        "self_critique": 0.001,
    },
    "appraisal_frustration": {
        "social_overload": 0.010,
        "withdrawal_147": 0.006,
        "self_critique": 0.004,
    },
}


class OrganismModes:
    """Durable 12-mode slow state.

    Reads never change state. relax_to_baseline and set_amplitude are explicit
    mutations; the live runtime does not call either one in this rollout.
    That is deliberate: this PR establishes persistence without changing
    Kristina's behaviour.
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        clock: Optional[Callable[[], datetime]] = None,
    ):
        self.db_path = db_path
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._memory: Dict[str, ModeState] = {}
        self._memory_events = {}

        now = self._now()
        if self.db_path is None:
            self._memory = {
                name: ModeState(
                    name=name,
                    baseline=definition.baseline,
                    amplitude=definition.baseline,
                    phase=0.0,
                    half_life_hours=definition.half_life_hours,
                    updated_at=now,
                )
                for name, definition in DEFAULT_MODE_DEFINITIONS.items()
            }
        else:
            self._init_db(now)

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("OrganismModes clock must return an aware datetime")
        return value.astimezone(timezone.utc)

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def _init_db(self, now: datetime) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS kristina_modes (
                    name TEXT PRIMARY KEY,
                    baseline REAL NOT NULL CHECK (baseline >= 0.0 AND baseline <= 1.0),
                    amplitude REAL NOT NULL CHECK (amplitude >= 0.0 AND amplitude <= 1.0),
                    phase REAL NOT NULL,
                    half_life_hours REAL NOT NULL CHECK (half_life_hours > 0.0),
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                )"""
            )
            conn.execute(
                """CREATE TABLE IF NOT EXISTS organism_mode_events (
                    session_sha256 TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    payload_sha256 TEXT NOT NULL,
                    deltas_json TEXT NOT NULL,
                    applied_at TEXT NOT NULL,
                    PRIMARY KEY (session_sha256, event_id)
                )"""
            )
            self._insert_missing_defaults(conn, now)
        self.snapshot()

    @staticmethod
    def _insert_missing_defaults(conn, now: datetime) -> int:
        inserted = 0
        for name, definition in DEFAULT_MODE_DEFINITIONS.items():
            cursor = conn.execute(
                """INSERT OR IGNORE INTO kristina_modes
                   (name, baseline, amplitude, phase, half_life_hours, updated_at, version)
                   VALUES (?, ?, ?, 0.0, ?, ?, 1)""",
                (
                    name,
                    definition.baseline,
                    definition.baseline,
                    definition.half_life_hours,
                    now.isoformat(),
                ),
            )
            inserted += max(0, cursor.rowcount)
        return inserted

    def ensure_defaults(self, at: Optional[datetime] = None) -> int:
        """Add missing canonical modes without overwriting existing evolution."""
        now = self._aware(at) if at is not None else self._now()
        if self.db_path is None:
            inserted = 0
            for name, definition in DEFAULT_MODE_DEFINITIONS.items():
                if name not in self._memory:
                    self._memory[name] = ModeState(
                        name,
                        definition.baseline,
                        definition.baseline,
                        0.0,
                        definition.half_life_hours,
                        now,
                    )
                    inserted += 1
            return inserted

        with closing(self._connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            return self._insert_missing_defaults(conn, now)

    @staticmethod
    def _aware(value: datetime) -> datetime:
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Mode timestamps must be timezone-aware")
        return value.astimezone(timezone.utc)

    @staticmethod
    def _validate_number(value, *, minimum=None, maximum=None, label="value") -> float:
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError(f"Invalid mode {label}")
        result = float(value)
        if minimum is not None and result < minimum:
            raise ValueError(f"Invalid mode {label}")
        if maximum is not None and result > maximum:
            raise ValueError(f"Invalid mode {label}")
        return result

    @classmethod
    def _validate_state(cls, state: ModeState) -> ModeState:
        if state.name not in DEFAULT_MODE_DEFINITIONS:
            raise ValueError("Unknown canonical mode")
        baseline = cls._validate_number(state.baseline, minimum=0.0, maximum=1.0, label="baseline")
        amplitude = cls._validate_number(state.amplitude, minimum=0.0, maximum=1.0, label="amplitude")
        phase = cls._validate_number(state.phase, label="phase") % math.tau
        half_life = cls._validate_number(state.half_life_hours, minimum=1e-9, label="half-life")
        updated = cls._aware(state.updated_at)
        return ModeState(state.name, baseline, amplitude, phase, half_life, updated)

    @classmethod
    def _from_row(cls, row) -> ModeState:
        if row["version"] != 1:
            raise ValueError("Unsupported organism mode version")
        try:
            updated = datetime.fromisoformat(row["updated_at"])
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid organism mode timestamp") from exc
        return cls._validate_state(
            ModeState(
                name=row["name"],
                baseline=row["baseline"],
                amplitude=row["amplitude"],
                phase=row["phase"],
                half_life_hours=row["half_life_hours"],
                updated_at=updated,
            )
        )

    def get(self, name: str) -> ModeState:
        if name not in DEFAULT_MODE_DEFINITIONS:
            raise KeyError(name)
        if self.db_path is None:
            return self._validate_state(self._memory[name])

        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT * FROM kristina_modes WHERE name = ?",
                (name,),
            ).fetchone()
        if row is None:
            raise ValueError(f"Missing canonical mode: {name}")
        return self._from_row(row)

    def snapshot(self) -> Dict[str, ModeState]:
        """Return a detached validated snapshot without advancing time."""
        if self.db_path is None:
            return {
                name: self._validate_state(state)
                for name, state in self._memory.items()
                if name in DEFAULT_MODE_DEFINITIONS
            }

        placeholders = ",".join("?" for _ in MODE_NAMES)
        with closing(self._connect()) as conn:
            rows = conn.execute(
                f"SELECT * FROM kristina_modes WHERE name IN ({placeholders})",
                MODE_NAMES,
            ).fetchall()
        result = {row["name"]: self._from_row(row) for row in rows}
        missing = set(MODE_NAMES) - set(result)
        if missing:
            raise ValueError("Missing canonical modes: " + ", ".join(sorted(missing)))
        return {name: result[name] for name in MODE_NAMES}

    def dominant(self, limit: int = 3):
        if type(limit) is not int or limit < 1:
            raise ValueError("limit must be a positive integer")
        return sorted(
            self.snapshot().values(),
            key=lambda state: (-state.amplitude, state.name),
        )[:limit]

    def set_amplitude(
        self,
        name: str,
        amplitude: float,
        *,
        phase: Optional[float] = None,
        at: Optional[datetime] = None,
    ) -> ModeState:
        """Explicit low-level mutation for later event processors and tests."""
        if name not in DEFAULT_MODE_DEFINITIONS:
            raise KeyError(name)
        new_amplitude = self._validate_number(
            amplitude, minimum=0.0, maximum=1.0, label="amplitude"
        )
        now = self._aware(at) if at is not None else self._now()

        if self.db_path is None:
            current = self.get(name)
            if now < current.updated_at:
                raise ValueError("Mode update cannot move backwards in time")
            new_phase = current.phase if phase is None else (
                self._validate_number(phase, label="phase") % math.tau
            )
            new_state = ModeState(
                name,
                current.baseline,
                new_amplitude,
                new_phase,
                current.half_life_hours,
                now,
            )
            self._memory[name] = new_state
            return new_state

        with closing(self._connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM kristina_modes WHERE name = ?",
                (name,),
            ).fetchone()
            if row is None:
                raise ValueError(f"Missing canonical mode: {name}")
            latest = self._from_row(row)
            if now < latest.updated_at:
                raise ValueError("Mode update cannot move backwards in time")
            new_phase = latest.phase if phase is None else (
                self._validate_number(phase, label="phase") % math.tau
            )
            conn.execute(
                """UPDATE kristina_modes
                   SET amplitude = ?, phase = ?, updated_at = ?
                   WHERE name = ?""",
                (new_amplitude, new_phase, now.isoformat(), name),
            )
        return self.get(name)

    @classmethod
    def _state_from_values(cls, values) -> ModeState:
        name, baseline, amplitude, phase, half_life_hours, updated_at, version = values
        if version != 1:
            raise ValueError("Unsupported organism mode version")
        try:
            updated = datetime.fromisoformat(updated_at)
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid organism mode timestamp") from exc
        return cls._validate_state(
            ModeState(name, baseline, amplitude, phase, half_life_hours, updated)
        )

    @staticmethod
    def _validate_event_identity(session_sha256, event_id, input_sha256):
        for value in (session_sha256, input_sha256):
            if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
                raise ValueError("Invalid organism event digest")
        if not isinstance(event_id, str) or not event_id.strip() or len(event_id) > 240:
            raise ValueError("Invalid organism event ID")

    @staticmethod
    def _canonical_event_kinds(kinds):
        if not isinstance(kinds, (list, tuple)) or not kinds:
            raise ValueError("Organism event requires at least one kind")
        if "user_message" not in kinds:
            raise ValueError("Organism message event must include user_message")
        if any(kind not in MODE_EVENT_DELTAS for kind in kinds):
            raise ValueError("Unsupported organism event kind")
        if len(set(kinds)) != len(kinds):
            raise ValueError("Duplicate organism event kind")
        return tuple(sorted(kinds))

    @staticmethod
    def _combined_deltas(kinds):
        totals = {}
        for kind in kinds:
            for name, change in MODE_EVENT_DELTAS[kind].items():
                totals[name] = totals.get(name, 0.0) + change
        return {name: totals[name] for name in sorted(totals)}

    @staticmethod
    def _event_payload_sha256(input_sha256, kinds):
        payload = json.dumps(
            {"input_sha256": input_sha256, "kinds": list(kinds)},
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf8")).hexdigest()

    @staticmethod
    def _relax_state(state: ModeState, at: datetime) -> ModeState:
        if at < state.updated_at:
            raise ValueError("Organism event cannot move mode time backwards")
        hours = (at - state.updated_at).total_seconds() / 3600.0
        factor = math.exp(-math.log(2.0) * hours / state.half_life_hours)
        amplitude = state.baseline + (state.amplitude - state.baseline) * factor
        return ModeState(
            state.name,
            state.baseline,
            amplitude,
            state.phase,
            state.half_life_hours,
            at,
        )

    @classmethod
    def _apply_deltas(cls, states, deltas, at):
        # Wall clocks can move backwards and tests may deliberately inject an
        # older clock. Never rewind slow state: apply the event at the latest
        # already-persisted mode timestamp, just like EmotionalCore clamps its
        # own wall-clock progression.
        effective_at = max([at] + [state.updated_at for state in states.values()])
        updated = {}
        for name in MODE_NAMES:
            state = cls._relax_state(states[name], effective_at)
            amplitude = max(0.0, min(1.0, state.amplitude + deltas.get(name, 0.0)))
            updated[name] = ModeState(
                name,
                state.baseline,
                amplitude,
                state.phase,
                state.half_life_hours,
                effective_at,
            )
        return updated

    def apply_message_event(
        self,
        *,
        session_sha256,
        event_id,
        input_sha256,
        kinds,
        at: Optional[datetime] = None,
        conn=None,
    ) -> bool:
        """Apply one validated user-message experience exactly once.

        When conn is provided, the caller owns the SQLite transaction. This is
        used by EmotionalCore so fast emotion, slow modes and both receipts
        commit or roll back together.
        """
        self._validate_event_identity(session_sha256, event_id, input_sha256)
        event_kinds = self._canonical_event_kinds(kinds)
        payload_sha256 = self._event_payload_sha256(input_sha256, event_kinds)
        deltas = self._combined_deltas(event_kinds)
        now = self._aware(at) if at is not None else self._now()

        if self.db_path is None:
            key = (session_sha256, event_id)
            previous = self._memory_events.get(key)
            if previous is not None:
                if previous != payload_sha256:
                    raise ValueError("Organism event ID was reused for different input")
                return False
            current = self.snapshot()
            updated = self._apply_deltas(current, deltas, now)
            self._memory = updated
            self._memory_events[key] = payload_sha256
            return True

        owns_connection = conn is None
        if owns_connection:
            conn = self._connect()
        try:
            if owns_connection:
                conn.execute("BEGIN IMMEDIATE")
            receipt = conn.execute(
                """SELECT payload_sha256 FROM organism_mode_events
                   WHERE session_sha256=? AND event_id=?""",
                (session_sha256, event_id),
            ).fetchone()
            if receipt is not None:
                previous_sha = receipt[0]
                if previous_sha != payload_sha256:
                    raise ValueError("Organism event ID was reused for different input")
                if owns_connection:
                    conn.commit()
                return False

            placeholders = ",".join("?" for _ in MODE_NAMES)
            rows = conn.execute(
                f"""SELECT name, baseline, amplitude, phase, half_life_hours,
                           updated_at, version
                    FROM kristina_modes
                    WHERE name IN ({placeholders})""",
                MODE_NAMES,
            ).fetchall()
            current = {}
            for row in rows:
                values = tuple(row)
                state = self._state_from_values(values)
                current[state.name] = state
            missing = set(MODE_NAMES) - set(current)
            if missing:
                raise ValueError("Missing canonical modes: " + ", ".join(sorted(missing)))

            updated = self._apply_deltas(current, deltas, now)
            for name in MODE_NAMES:
                state = updated[name]
                conn.execute(
                    """UPDATE kristina_modes
                       SET amplitude=?, phase=?, updated_at=?
                       WHERE name=?""",
                    (state.amplitude, state.phase, state.updated_at.isoformat(), name),
                )
            conn.execute(
                """INSERT INTO organism_mode_events
                   (session_sha256, event_id, payload_sha256, deltas_json, applied_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    session_sha256,
                    event_id,
                    payload_sha256,
                    json.dumps(deltas, sort_keys=True, separators=(",", ":")),
                    max(state.updated_at for state in updated.values()).isoformat(),
                ),
            )
            if owns_connection:
                conn.commit()
            return True
        except Exception:
            if owns_connection:
                conn.rollback()
            raise
        finally:
            if owns_connection:
                conn.close()

    def relax_to_baseline(self, at: Optional[datetime] = None) -> Dict[str, ModeState]:
        """Explicitly relax every mode toward its baseline using real elapsed time.

        One call over N hours is mathematically equivalent to N smaller calls,
        apart from floating-point rounding. The live runtime does not call this
        method yet.
        """
        now = self._aware(at) if at is not None else self._now()

        if self.db_path is None:
            updated = {}
            for name, current in self.snapshot().items():
                if now < current.updated_at:
                    updated[name] = current
                    continue
                hours = (now - current.updated_at).total_seconds() / 3600.0
                factor = math.exp(-math.log(2.0) * hours / current.half_life_hours)
                amplitude = current.baseline + (current.amplitude - current.baseline) * factor
                state = ModeState(
                    name,
                    current.baseline,
                    amplitude,
                    current.phase,
                    current.half_life_hours,
                    now,
                )
                self._memory[name] = state
                updated[name] = state
            return updated

        with closing(self._connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            placeholders = ",".join("?" for _ in MODE_NAMES)
            rows = conn.execute(
                f"SELECT * FROM kristina_modes WHERE name IN ({placeholders})",
                MODE_NAMES,
            ).fetchall()
            current = {row["name"]: self._from_row(row) for row in rows}
            missing = set(MODE_NAMES) - set(current)
            if missing:
                raise ValueError("Missing canonical modes: " + ", ".join(sorted(missing)))
            for name in MODE_NAMES:
                state = current[name]
                if now < state.updated_at:
                    continue
                hours = (now - state.updated_at).total_seconds() / 3600.0
                factor = math.exp(-math.log(2.0) * hours / state.half_life_hours)
                amplitude = state.baseline + (state.amplitude - state.baseline) * factor
                conn.execute(
                    """UPDATE kristina_modes
                       SET amplitude = ?, updated_at = ?
                       WHERE name = ?""",
                    (amplitude, now.isoformat(), name),
                )
        return self.snapshot()
