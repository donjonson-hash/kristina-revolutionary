"""Autonomous decision layer for Kristina proactive behaviour."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Optional


@dataclass(frozen=True)
class AutonomousDecision:
    action: str
    intention: Optional[str]
    score: float
    reason: str


class DesireEngine:
    """Transforms emotional state and interaction context into desires."""

    def calculate(self, emotional_state: Dict, context: Optional[Dict] = None) -> Dict[str, float]:
        context = context or {}
        state = emotional_state.get("state", emotional_state)

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
