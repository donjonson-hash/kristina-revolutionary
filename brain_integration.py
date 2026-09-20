"""
Brain Integration Layer - Bridge to brain_unified (Cortex/Memory/Emotion).
This module provides a thin, testable interface to orchestrate the "мозг" as a unified
entity and expose a stable API for the rest of Kristina.
"""
from typing import Any, Dict, Optional
import logging
import asyncio
import json
import datetime
from dataclasses import asdict
from uuid import uuid4
from dialogue_state import preview_user

try:
    from brain_unified import CortexAgent, EmotionalAgent
except Exception:
    CortexAgent = None  # type: ignore

try:
    from emotional_core import get_emotional_core
except Exception:
    get_emotional_core = None  # type: ignore

try:
    from persistent_memory import get_memory
except Exception:
    get_memory = None  # type: ignore

logger = logging.getLogger(__name__)

class BrainBridge:
    """Lightweight orchestrator around brain_unified components."""
    def __init__(self, cortex=None, emotional=None, memory=None):
        self.cortex = cortex if cortex is not None else (CortexAgent() if CortexAgent is not None else None)
        self.emotional = emotional if emotional is not None else (get_emotional_core() if get_emotional_core is not None else None)
        self.memory = memory if memory is not None else (get_memory() if get_memory is not None else None)
        self.emotional_agent = EmotionalAgent(self.emotional) if self.emotional is not None and CortexAgent is not None else None

    async def process_signal(self, signal: Any, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Process a neural signal and enrich with emotion & memory context."""
        if context and context.get("appraise_event"):
            # The live Persona path: assess -> emotional response -> reply.
            # This branch has exactly one owner of the user-message event.
            appraisal = None
            if self.cortex is not None:
                try:
                    from cognitive_appraisal import Appraisal
                    kwargs = {}
                    if context.get("dialogue") is not None:
                        kwargs["dialogue"] = context["dialogue"]
                    if context.get("event_at") is not None:
                        kwargs["now"] = context["event_at"]
                    appraisal = await self.cortex.appraise(
                        signal.content, context.get("history", []), context.get("interest"),
                        **kwargs,
                    )
                    if appraisal is not None:
                        if not isinstance(appraisal, Appraisal):
                            raise ValueError("Cortex did not return an Appraisal")
                        appraisal = Appraisal.parse(json.dumps(asdict(appraisal), ensure_ascii=False), signal.content)
                        preview_user(context.get("dialogue"), appraisal.dialogue, signal.content,
                                     context.get("event_at") or datetime.datetime.now(datetime.timezone.utc))
                except Exception as exc:
                    appraisal = None
                    logger.warning("Cortex appraisal failed: %s", type(exc).__name__)
            observation = None
            if appraisal is not None and getattr(self.emotional, "appraisal_observer", None) is not None:
                try:
                    from experiments.appraisal_observer import AppraisalSource
                    observation = AppraisalSource.from_validated(
                        appraisal, user_input=signal.content, session_id=context.get("session_id"),
                        event_id=context.get("event_id") if context.get("event_id") is not None else uuid4().hex,
                    )
                except Exception as exc:
                    logger.warning("Appraisal shadow source unavailable: %s", type(exc).__name__)
            emotion = self.emotional_agent.react(
                appraisal, user_message=True, observation=observation,
            ) if self.emotional_agent else {}
            return {
                "cortex": {"status": "appraised" if appraisal else "unavailable"},
                "appraisal": appraisal,
                "emotion": emotion,
                "memory": {"memory_context": context.get("history", [])},
                "recommendations": {"agent_recommendations": [], "actions": []},
            }

        # Cortex processing
        if self.cortex is None:
            cortex_result = {"status": "uninitialized"}
        else:
            try:
                cortex_result = await self.cortex.process(signal)
            except Exception as e:
                logger.exception("Cortex processing error")
                cortex_result = {"status": "error", "detail": str(e)}

        # Emotion state
        emotion_state = {}
        if self.emotional is not None:
            try:
                emotion_state = self.emotional.get_emotional_state()
            except Exception:
                emotion_state = {}

        # Memory context for LLM prompts
        memory_context = {}
        if self.memory is not None and context is not None and context.get("session_id"):
            session_id = context["session_id"]
            try:
                memory_context = {
                    "memory_context": [],
                }
                if "history" in context:
                    memory_context["memory_context"] = context["history"]
                elif hasattr(self.memory, "get_context_for_llm"):
                    memory_context["memory_context"] = self.memory.get_context_for_llm(session_id, limit=5)
            except Exception:
                memory_context = {"memory_context": []}

        # Stage 2: recommendations (agent switching / actions)
        recommendations = {
            "agent_recommendations": [],
            "actions": []
        }
        try:
            if self.emotional is not None:
                ess = {}
                try:
                    ess = self.emotional.get_emotional_state()  # type: ignore
                except Exception:
                    ess = {}
                dominant = None
                if isinstance(ess, dict):
                    dominant = ess.get("dominant_emotion")
                if isinstance(dominant, str) and dominant.lower() in ["curious", "happy", "excited"]:
                    recommendations["agent_recommendations"] = ["Kristina-Advisor", "Kristina-Creative"]
                # memory-driven hint
                if memory_context and memory_context.get("memory_context"):
                    rec = recommendations["agent_recommendations"]
                    if not rec:
                        rec += ["Kristina-Advisor"]
                    recommendations["agent_recommendations"] = rec
            # basic actions for stage 2
            if recommendations["agent_recommendations"]:
                recommendations["actions"] = ["switch_to_recommended_agent"]
        except Exception:
            pass

        return {
            "cortex": cortex_result,
            "emotion": emotion_state,
            "memory": memory_context,
            "recommendations": recommendations,
        }

    def get_status(self) -> Dict[str, Any]:
        status = {
            "cortex": getattr(self.cortex, "get_status", lambda: {})(),
            "emotion": getattr(self.emotional, "get_status", lambda: {})() if self.emotional else {},
            "memory": getattr(self.memory, "get_stats", lambda: {})() if self.memory else {},
        }
        return status

_brain_bridge = None
def get_brain_bridge() -> BrainBridge:
    global _brain_bridge
    if _brain_bridge is None:
        _brain_bridge = BrainBridge()
    return _brain_bridge

__all__ = ["BrainBridge", "get_brain_bridge"]
