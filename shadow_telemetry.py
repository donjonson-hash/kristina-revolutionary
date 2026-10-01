"""Durable telemetry for organism shadow decisions.

This module records counterfactual decision observations in the same SQLite
database used by Kristina's persistent state. It stores no conversation text
and no raw Telegram/session identifier.

The store is observational only. Callers must treat every write failure as
non-fatal and continue with the already-computed baseline production decision.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Optional

from autonomy_decision import OrganismProjection, ShadowDecisionReport


ALLOWED_KINDS = ("proactive", "creative")
TELEMETRY_VERSION = 1


def shadow_time_bucket(at: datetime, minutes: int = 30) -> datetime:
    """Return a stable UTC bucket start for lower-frequency creative telemetry."""
    aware = _aware(at)
    if type(minutes) is not int or minutes < 1 or minutes > 1440:
        raise ValueError("minutes must be an integer from 1 to 1440")
    seconds = minutes * 60
    epoch = int(aware.timestamp())
    return datetime.fromtimestamp(epoch - (epoch % seconds), tz=timezone.utc)


def _aware(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Shadow telemetry timestamps must be timezone-aware")
    return value.astimezone(timezone.utc)


def _finite(value, label: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"Invalid shadow telemetry {label}")
    return float(value)


def _hash_scope(scope: str) -> str:
    if not isinstance(scope, str) or not scope or len(scope) > 4096:
        raise ValueError("Invalid shadow telemetry scope")
    return hashlib.sha256(scope.encode("utf8")).hexdigest()


def _canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class ShadowTelemetryStore:
    """SQLite-backed, idempotent shadow decision observations."""

    def __init__(self, db_path: str):
        if not isinstance(db_path, (str, bytes)) and not hasattr(db_path, "__fspath__"):
            raise ValueError("Shadow telemetry requires a database path")
        self.db_path = str(db_path)
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS shadow_decision_telemetry (
                    observation_id TEXT PRIMARY KEY,
                    payload_sha256 TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind IN ('proactive','creative')),
                    scope_sha256 TEXT NOT NULL,
                    opportunity_at TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    baseline_action TEXT NOT NULL,
                    baseline_intention TEXT,
                    baseline_score REAL NOT NULL,
                    baseline_reason TEXT NOT NULL,
                    shadow_action TEXT NOT NULL,
                    shadow_intention TEXT,
                    shadow_score REAL NOT NULL,
                    shadow_reason TEXT NOT NULL,
                    decision_changed INTEGER NOT NULL CHECK (decision_changed IN (0,1)),
                    action_changed INTEGER NOT NULL CHECK (action_changed IN (0,1)),
                    intention_changed INTEGER NOT NULL CHECK (intention_changed IN (0,1)),
                    max_abs_score_delta REAL NOT NULL,
                    score_deltas_json TEXT NOT NULL,
                    mode_deviations_json TEXT NOT NULL,
                    shifted_modes_json TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                )"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS idx_shadow_decision_observed
                   ON shadow_decision_telemetry(observed_at)"""
            )
            conn.execute(
                """CREATE INDEX IF NOT EXISTS idx_shadow_decision_kind_observed
                   ON shadow_decision_telemetry(kind, observed_at)"""
            )

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    @staticmethod
    def _validate_kind(kind: str) -> str:
        if kind not in ALLOWED_KINDS:
            raise ValueError("Unsupported shadow telemetry kind")
        return kind

    @staticmethod
    def _decision_payload(report: ShadowDecisionReport, projection: OrganismProjection):
        if not isinstance(report, ShadowDecisionReport):
            raise ValueError("report must be a ShadowDecisionReport")
        if not isinstance(projection, OrganismProjection):
            raise ValueError("projection must be an OrganismProjection")

        baseline_score = _finite(report.baseline.score, "baseline score")
        shadow_score = _finite(report.shadow.score, "shadow score")
        max_delta = _finite(report.max_abs_score_delta, "max score delta")

        score_deltas = {
            str(name): _finite(value, f"score delta {name}")
            for name, value in sorted(report.score_deltas.items())
        }
        deviations = {
            str(name): _finite(value, f"mode deviation {name}")
            for name, value in sorted(projection.deviations.items())
        }
        shifted = [str(name) for name in projection.shifted]

        return {
            "baseline_action": str(report.baseline.action),
            "baseline_intention": report.baseline.intention,
            "baseline_score": baseline_score,
            "baseline_reason": str(report.baseline.reason),
            "shadow_action": str(report.shadow.action),
            "shadow_intention": report.shadow.intention,
            "shadow_score": shadow_score,
            "shadow_reason": str(report.shadow.reason),
            "decision_changed": bool(report.decision_changed),
            "action_changed": report.baseline.action != report.shadow.action,
            "intention_changed": report.baseline.intention != report.shadow.intention,
            "max_abs_score_delta": max_delta,
            "score_deltas": score_deltas,
            "mode_deviations": deviations,
            "shifted_modes": shifted,
        }

    def record_once(
        self,
        *,
        kind: str,
        scope: str,
        opportunity_at: datetime,
        observed_at: datetime,
        projection: OrganismProjection,
        report: ShadowDecisionReport,
    ) -> bool:
        """Persist one opportunity exactly once.

        The primary identity is kind + hashed scope + opportunity time. The
        first accepted observation wins; later attempts for the same opportunity
        are no-ops and can never overwrite the original evidence.
        """
        kind = self._validate_kind(kind)
        scope_sha256 = _hash_scope(scope)
        opportunity = _aware(opportunity_at)
        observed = _aware(observed_at)
        if observed < opportunity:
            # A scheduler can be late, but an observation cannot predate the
            # opportunity it claims to represent.
            raise ValueError("Shadow telemetry observation predates opportunity")

        decision = self._decision_payload(report, projection)
        identity = f"{kind}|{scope_sha256}|{opportunity.isoformat()}"
        observation_id = hashlib.sha256(identity.encode("utf8")).hexdigest()

        payload = {
            "kind": kind,
            "scope_sha256": scope_sha256,
            "opportunity_at": opportunity.isoformat(),
            "observed_at": observed.isoformat(),
            **decision,
            "version": TELEMETRY_VERSION,
        }
        payload_sha256 = hashlib.sha256(_canonical_json(payload).encode("utf8")).hexdigest()

        with closing(self._connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                """SELECT 1 FROM shadow_decision_telemetry
                   WHERE observation_id=?""",
                (observation_id,),
            ).fetchone()
            if existing is not None:
                return False

            conn.execute(
                """INSERT INTO shadow_decision_telemetry (
                    observation_id, payload_sha256, kind, scope_sha256,
                    opportunity_at, observed_at,
                    baseline_action, baseline_intention, baseline_score, baseline_reason,
                    shadow_action, shadow_intention, shadow_score, shadow_reason,
                    decision_changed, action_changed, intention_changed,
                    max_abs_score_delta, score_deltas_json, mode_deviations_json,
                    shifted_modes_json, version
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    observation_id,
                    payload_sha256,
                    kind,
                    scope_sha256,
                    opportunity.isoformat(),
                    observed.isoformat(),
                    decision["baseline_action"],
                    decision["baseline_intention"],
                    decision["baseline_score"],
                    decision["baseline_reason"],
                    decision["shadow_action"],
                    decision["shadow_intention"],
                    decision["shadow_score"],
                    decision["shadow_reason"],
                    int(decision["decision_changed"]),
                    int(decision["action_changed"]),
                    int(decision["intention_changed"]),
                    decision["max_abs_score_delta"],
                    _canonical_json(decision["score_deltas"]),
                    _canonical_json(decision["mode_deviations"]),
                    _canonical_json(decision["shifted_modes"]),
                    TELEMETRY_VERSION,
                ),
            )
        return True

    def recent(self, limit: int = 100, *, kind: Optional[str] = None):
        if type(limit) is not int or limit < 1 or limit > 10000:
            raise ValueError("limit must be from 1 to 10000")
        if kind is not None:
            kind = self._validate_kind(kind)

        query = "SELECT * FROM shadow_decision_telemetry"
        params = []
        if kind is not None:
            query += " WHERE kind=?"
            params.append(kind)
        query += " ORDER BY observed_at DESC, observation_id DESC LIMIT ?"
        params.append(limit)

        with closing(self._connect()) as conn:
            rows = conn.execute(query, params).fetchall()

        result = []
        for row in rows:
            item = dict(row)
            item["decision_changed"] = bool(item["decision_changed"])
            item["action_changed"] = bool(item["action_changed"])
            item["intention_changed"] = bool(item["intention_changed"])
            item["score_deltas"] = json.loads(item.pop("score_deltas_json"))
            item["mode_deviations"] = json.loads(item.pop("mode_deviations_json"))
            item["shifted_modes"] = json.loads(item.pop("shifted_modes_json"))
            result.append(item)
        return result

    def summary(self, *, since: Optional[datetime] = None):
        where = ""
        params = []
        if since is not None:
            where = " WHERE observed_at>=?"
            params.append(_aware(since).isoformat())

        with closing(self._connect()) as conn:
            total = conn.execute(
                f"""SELECT
                        COUNT(*) AS total,
                        COALESCE(SUM(decision_changed), 0) AS decision_changed,
                        COALESCE(SUM(action_changed), 0) AS action_changed,
                        COALESCE(SUM(intention_changed), 0) AS intention_changed,
                        COALESCE(AVG(max_abs_score_delta), 0.0) AS avg_max_delta,
                        COALESCE(MAX(max_abs_score_delta), 0.0) AS max_delta
                    FROM shadow_decision_telemetry{where}""",
                params,
            ).fetchone()
            by_kind = conn.execute(
                f"""SELECT kind,
                           COUNT(*) AS total,
                           COALESCE(SUM(decision_changed), 0) AS decision_changed,
                           COALESCE(SUM(action_changed), 0) AS action_changed,
                           COALESCE(SUM(intention_changed), 0) AS intention_changed
                    FROM shadow_decision_telemetry{where}
                    GROUP BY kind
                    ORDER BY kind""",
                params,
            ).fetchall()

        count = int(total["total"])
        return {
            "total": count,
            "decision_changed": int(total["decision_changed"]),
            "action_changed": int(total["action_changed"]),
            "intention_changed": int(total["intention_changed"]),
            "decision_changed_rate": (
                float(total["decision_changed"]) / count if count else 0.0
            ),
            "avg_max_abs_score_delta": float(total["avg_max_delta"]),
            "max_abs_score_delta": float(total["max_delta"]),
            "by_kind": {
                row["kind"]: {
                    "total": int(row["total"]),
                    "decision_changed": int(row["decision_changed"]),
                    "action_changed": int(row["action_changed"]),
                    "intention_changed": int(row["intention_changed"]),
                }
                for row in by_kind
            },
        }
