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

try:
    from brain_unified import CortexAgent
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
    def __init__(self):
        self.cortex = CortexAgent() if CortexAgent is not None else None
        self.emotional = get_emotional_core() if get_emotional_core is not None else None
        self.memory = get_memory() if get_memory is not None else None

    async def process_signal(self, signal: Any, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Process a neural signal and enrich with emotion & memory context."""
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
                if hasattr(self.memory, "get_context_for_llm"):
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
