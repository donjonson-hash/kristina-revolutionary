"""Autonomous decision layer for Kristina proactive behaviour."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from types import MappingProxyType
from typing import Dict, Mapping, Optional


@dataclass(frozen=True)
class AutonomousDecision:
    action: str
    intention: Optional[str]
    score: float
    reason: str


@dataclass(frozen=True)
class ShadowDecisionReport:
    """Counterfactual decision that is never executed in shadow mode."""

    baseline: AutonomousDecision
    shadow: AutonomousDecision
    baseline_desires: Mapping[str, float]
    shadow_desires: Mapping[str, float]
    score_deltas: Mapping[str, float]
    decision_changed: bool
    max_abs_score_delta: float


# Provisional shadow-only coupling. Every coefficient acts on deviation from
# that mode's own baseline, never on raw amplitude. These values are
# engineering hypotheses to observe, not psychological measurements.
SHADOW_MODE_WEIGHTS = MappingProxyType({
    "talk": (
        ("empathy_963", 0.10),
        ("validation_need", 0.08),
        ("abandonment_wound", 0.06),
        ("withdrawal_147", -0.12),
        ("social_overload", -0.10),
        ("agency_exec", 0.04),
    ),
    "share": (
        ("creativity_357", 0.16),
        ("aesthetic_drive", 0.14),
        ("agency_exec", 0.08),
        ("self_critique", -0.10),
        ("social_overload", -0.08),
        ("withdrawal_147", -0.06),
    ),
    "ask": (
        ("empathy_963", 0.08),
        ("validation_need", 0.10),
        ("invisibility_wound", 0.06),
        ("withdrawal_147", -0.10),
        ("social_overload", -0.08),
    ),
    "be_alone": (
        ("social_overload", 0.18),
        ("withdrawal_147", 0.16),
        ("self_critique", 0.08),
        ("crisis_957", 0.20),
        ("empathy_963", -0.04),
        ("agency_exec", -0.06),
    ),
})
SHADOW_MAX_ABS_DESIRE_DELTA = 0.12


@dataclass(frozen=True)
class OrganismProjection:
    """Read-only slow-state view for decision observability.

    This object is deliberately descriptive. DesireEngine and DecisionEngine do
    not use it to change scores in this stage.
    """

    amplitudes: Mapping[str, float]
    deviations: Mapping[str, float]
    dominant: tuple[str, ...]
    shifted: tuple[str, ...]
    max_abs_deviation: float


def project_organism_modes(mode_store, limit: int = 3) -> OrganismProjection:
    """Snapshot slow modes without advancing or mutating them."""
    if type(limit) is not int or limit < 1:
        raise ValueError("limit must be a positive integer")

    snapshot = mode_store.snapshot()
    amplitudes = {name: float(state.amplitude) for name, state in snapshot.items()}
    deviations = {
        name: float(state.amplitude - state.baseline)
        for name, state in snapshot.items()
    }
    dominant = tuple(
        state.name
        for state in sorted(
            snapshot.values(),
            key=lambda state: (-state.amplitude, state.name),
        )[:limit]
    )
    shifted = tuple(
        name
        for name, deviation in sorted(
            deviations.items(),
            key=lambda item: (-abs(item[1]), item[0]),
        )
        if abs(deviation) > 1e-12
    )[:limit]
    max_abs_deviation = max((abs(value) for value in deviations.values()), default=0.0)
    return OrganismProjection(
        amplitudes=MappingProxyType(amplitudes),
        deviations=MappingProxyType(deviations),
        dominant=dominant,
        shifted=shifted,
        max_abs_deviation=max_abs_deviation,
    )


def format_organism_projection(projection: OrganismProjection) -> str:
    """Compact operational summary; contains no message text or user identity."""
    top = ",".join(projection.dominant) if projection.dominant else "none"
    shifted = ",".join(projection.shifted) if projection.shifted else "none"
    return f"top={top} shifted={shifted} max_dev={projection.max_abs_deviation:.3f}"


def shadow_desires(
    baseline_desires: Mapping[str, float],
    projection: OrganismProjection,
) -> Mapping[str, float]:
    """Apply bounded slow-mode influence to a counterfactual desire vector only."""
    if not isinstance(projection, OrganismProjection):
        raise ValueError("projection must be an OrganismProjection")

    adjusted = {}
    for desire, baseline in baseline_desires.items():
        value = float(baseline)
        weighted = sum(
            weight * projection.deviations.get(mode_name, 0.0)
            for mode_name, weight in SHADOW_MODE_WEIGHTS.get(desire, ())
        )
        bounded = max(
            -SHADOW_MAX_ABS_DESIRE_DELTA,
            min(SHADOW_MAX_ABS_DESIRE_DELTA, weighted),
        )
        adjusted[desire] = max(0.0, min(1.0, value + bounded))
    return MappingProxyType(adjusted)


def compare_shadow_decision(
    *,
    baseline_desires: Mapping[str, float],
    baseline_decision: AutonomousDecision,
    projection: OrganismProjection,
    decision_engine,
    context: Optional[Dict] = None,
    now: Optional[datetime] = None,
) -> ShadowDecisionReport:
    """Calculate a counterfactual without touching the executed baseline decision."""
    shadow = shadow_desires(baseline_desires, projection)
    shadow_decision = decision_engine.decide(dict(shadow), context or {}, now=now)
    baseline_copy = MappingProxyType({key: float(value) for key, value in baseline_desires.items()})
    score_deltas = MappingProxyType({
        key: float(shadow[key] - baseline_copy[key])
        for key in baseline_copy
    })
    changed = (
        baseline_decision.action,
        baseline_decision.intention,
        baseline_decision.reason,
    ) != (
        shadow_decision.action,
        shadow_decision.intention,
        shadow_decision.reason,
    )
    return ShadowDecisionReport(
        baseline=baseline_decision,
        shadow=shadow_decision,
        baseline_desires=baseline_copy,
        shadow_desires=shadow,
        score_deltas=score_deltas,
        decision_changed=changed,
        max_abs_score_delta=max((abs(value) for value in score_deltas.values()), default=0.0),
    )


def format_shadow_decision(report: ShadowDecisionReport) -> str:
    """Compact counterfactual telemetry with no conversation content."""
    return (
        f"changed={str(report.decision_changed).lower()} "
        f"baseline={report.baseline.action}:{report.baseline.intention or 'none'}:"
        f"{report.baseline.score:.3f}:{report.baseline.reason} "
        f"shadow={report.shadow.action}:{report.shadow.intention or 'none'}:"
        f"{report.shadow.score:.3f}:{report.shadow.reason} "
        f"max_delta={report.max_abs_score_delta:.3f}"
    )


class DesireEngine:
    """Transforms emotional state and interaction context into desires."""

    def calculate(self, emotional_state: Dict, context: Optional[Dict] = None) -> Dict[str, float]:
        context = context or {}
        state = emotional_state.get("state", emotional_state)

        # Stage 3 observation boundary: the caller may include a read-only
        # organism projection in context. It is intentionally not referenced
        # in any score formula below, so current behaviour remains invariant.
        projection = context.get("organism_projection")
        if projection is not None and not isinstance(projection, OrganismProjection):
            raise ValueError("organism_projection must be an OrganismProjection")

        energy = float(state.get("energy", 0.5))
        curiosity = float(state.get("curiosity", 0.5))
        loneliness = float(state.get("loneliness", 0.3))
        creativity = float(state.get("creativity", 0.5))
        irritation = float(state.get("irritation", 0.1))
        anxiety = float(state.get("anxiety", 0.2))

        hours_since_contact = max(0.0, float(context.get("hours_since_contact", 0.0)))
        distance = min(1.0, hours_since_contact / 12.0)

        return {
            "talk": self._clamp(0.35 * loneliness + 0.25 * curiosity + 0.20 * energy + 0.20 * distance - 0.25 * irritation),
            "share": self._clamp(0.45 * creativity + 0.25 * curiosity + 0.15 * energy + 0.15 * distance),
            "ask": self._clamp(0.55 * curiosity + 0.20 * loneliness + 0.10 * distance - 0.15 * irritation),
            "be_alone": self._clamp(0.45 * (1.0 - energy) + 0.30 * irritation + 0.25 * anxiety),
        }

    @staticmethod
    def _clamp(value: float) -> float:
        return max(0.0, min(1.0, value))


class DecisionEngine:
    """Chooses whether Kristina acts at all. Silence is a first-class decision."""

    def __init__(self, threshold: float = 0.62, cooldown: timedelta = timedelta(hours=2)):
        self.threshold = threshold
        self.cooldown = cooldown

    def decide(
        self,
        desires: Dict[str, float],
        context: Optional[Dict] = None,
        now: Optional[datetime] = None,
    ) -> AutonomousDecision:
        context = context or {}
        now = now or datetime.now()

        last_proactive = context.get("last_proactive")
        if last_proactive and now - last_proactive < self.cooldown:
            return AutonomousDecision("none", None, 0.0, "cooldown")

        if desires.get("be_alone", 0.0) >= 0.68:
            return AutonomousDecision("none", None, desires["be_alone"], "wants_space")

        candidates = {key: value for key, value in desires.items() if key != "be_alone"}
        if not candidates:
            return AutonomousDecision("none", None, 0.0, "no_desire")

        intention, score = max(candidates.items(), key=lambda item: item[1])
        if score < self.threshold:
            return AutonomousDecision("none", None, score, "impulse_too_weak")

        return AutonomousDecision("message", intention, score, "strong_internal_impulse")


class AutonomousKristina:
    """Small façade used by delivery code."""

    def __init__(self, emotional_core, threshold: float = 0.62):
        self.emotional_core = emotional_core
        self.desires = DesireEngine()
        self.decisions = DecisionEngine(threshold=threshold)
        self.last_proactive: Optional[datetime] = None

    def evaluate(self, hours_since_contact: float = 0.0, now: Optional[datetime] = None) -> AutonomousDecision:
        now = now or datetime.now()
        emotional_state = self.emotional_core.evolve()
        context = {
            "hours_since_contact": hours_since_contact,
            "last_proactive": self.last_proactive,
        }
        decision = self.decisions.decide(self.desires.calculate(emotional_state, context), context, now)
        if decision.action == "message":
            self.last_proactive = now
        return decision
