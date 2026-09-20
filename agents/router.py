"""
Agent Router - исправленная версия с set_active_agent
"""

from typing import Dict, List, Optional, NamedTuple
from .base_agent import BaseAgent, AgentResponse
from github_readonly import GitHubReadOnlyTool, extract_github_repo_url
from conversation_context import conversation_session_id
from intention_cycle import IntentionStore, research_target
from repository_research import extract_research_target
from repository_dialogue import inspect_followup
from persistent_memory import get_memory
from dialogue_state import DialogueStore
from datetime import datetime, timezone
import asyncio
import logging

logger = logging.getLogger(__name__)


class RoutingDecision(NamedTuple):
    selected_agent: BaseAgent
    confidence: float
    alternatives: List[tuple]


class AgentRouter:
    def __init__(self, memory=None):
        self.agents: Dict[str, BaseAgent] = {}
        self.default_agent: Optional[BaseAgent] = None
        self.current_agent: Optional[BaseAgent] = None  # Активный по выбору пользователя
        self.github_reader = GitHubReadOnlyTool()
        self.github_followup = inspect_followup
        self._memory = memory
        self._session_locks = {}

    @property
    def memory(self):
        if self._memory is None:
            self._memory = get_memory()
        return self._memory

    def session_lock(self, session_id: str):
        return self._session_locks.setdefault(session_id, asyncio.Lock())

    def register_agent(self, agent: BaseAgent, is_default: bool = False):
        self.agents[agent.name] = agent
        logger.info(f"🎭 Зарегистрирован агент: {agent.name}")
        if is_default:
            self.default_agent = agent
            self.current_agent = agent  # По умолчанию default
            logger.info(f"⭐ Агент {agent.name} установлен как default")

    def set_active_agent(self, agent_name: str) -> bool:
        """Устанавливает активного агента по имени класса или имени агента"""
        # Ищем по имени класса (KristinaPersonaAgent) или по имени (Kristina)
        for name, agent in self.agents.items():
            if agent.__class__.__name__ == agent_name or agent.name == agent_name:
                self.current_agent = agent
                agent.activate()
                logger.info(f"🎯 Активирован агент: {agent.name}")
                return True
        logger.warning(f"❌ Агент не найден: {agent_name}")
        return False

    async def route(self, user_input: str, context: Dict) -> RoutingDecision:
        """Авто-выбор агента по ключевым словам (если нет фиксированного)"""
        agent_id = context.get("agent_id")
        if agent_id is not None:
            names = {
                "kristina": "Kristina",
                "advisor": "Kristina-Advisor",
                "creative": "Kristina-Creative",
                "trendscout": "TrendScout",
            }
            selected = self.agents.get(names.get(agent_id, agent_id))
            if selected is None:
                raise ValueError(f"Unknown agent: {agent_id}")
            return RoutingDecision(selected_agent=selected, confidence=1.0, alternatives=[])
        # Stage 2: учесть мозговые рекомендации, если они есть
        brain_recs = context.get("brain_recommendations", {}) or {}
        agent_recs = brain_recs.get("agent_recommendations", [])
        if agent_recs:
            for rec_name in agent_recs:
                for name, agent in self.agents.items():
                    if agent.__class__.__name__ == rec_name or agent.name == rec_name:
                        logger.info(f"🎯 Brain-recommended агент активирован: {agent.name}")
                        return RoutingDecision(selected_agent=agent, confidence=1.0, alternatives=[])

        # Если есть current_agent (выбран пользователем) — используем его
        if self.current_agent:
            return RoutingDecision(
                selected_agent=self.current_agent,
                confidence=1.0,
                alternatives=[]
            )

        # Иначе — авто-выбор по скорам
        scores = []
        for name, agent in self.agents.items():
            score = agent.should_activate(user_input)
            scores.append((agent, score))

        scores.sort(key=lambda x: x[1], reverse=True)
        best_agent, best_score = scores[0] if scores else (None, 0)

        if best_score >= 0.5:
            decision = RoutingDecision(
                selected_agent=best_agent,
                confidence=best_score,
                alternatives=scores[1:3]
            )
        else:
            # Fallback на default
            decision = RoutingDecision(
                selected_agent=self.default_agent or best_agent,
                confidence=0.3,
                alternatives=[]
            )

        return decision

    async def _attach_github_evidence(self, user_input: str, context: Dict) -> None:
        """Inspect a GitHub URL using GET-only API calls and attach bounded evidence."""
        ref = extract_github_repo_url(user_input)
        target = context.get('research_target')
        if ref is None and not target:
            return

        context['repository_action'] = 'not_run'
        try:
            if ref:
                evidence = await asyncio.wait_for(self.github_reader.inspect(ref), timeout=90)
            else:
                evidence = await asyncio.wait_for(self.github_followup(
                    target, user_input, context.get('history', [])), timeout=90)
            if evidence:
                context["github_evidence"] = evidence
                context['repository_action'] = 'completed'
                logger.info("GitHub evidence supplied (%s chars)", len(evidence))
        except Exception as exc:
            context.pop("github_evidence", None)
            context["github_error"] = type(exc).__name__
            context['repository_action'] = 'failed'
            logger.warning("GitHub inspection failed: %s", type(exc).__name__)

    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        """Обработка через выбранного агента"""
        context = dict(context)
        session_id = conversation_session_id(context)
        context["session_id"] = session_id
        context.pop("_appraisal", None)
        context["interest"] = None
        context["intention"] = None
        context["research_target"] = None
        context['research_availability'] = None
        context['repository_action'] = 'not_run'
        for key in ('github_evidence', 'github_error', 'github_repo'):
            context.pop(key, None)
        # Request payloads cannot supply persisted scene/question state or clocks.
        context["dialogue"] = None
        context["event_at"] = datetime.now(timezone.utc)
        if session_id is None:
            context["history"] = []
            return await self._process(user_input, context)
        store = DialogueStore(self.memory)
        event_id = context.get("event_id")
        if event_id is not None:
            saved = store.get_exchange(session_id, event_id, user_input)
            if saved is not None:
                return self._replayed_response(saved)
        # Arrival matters even while a proactive generation holds this lock.
        # Revoke its prepared claim now; an already dispatched send is separate.
        store.cancel_reserved(session_id)
        async with self.session_lock(session_id):
            if event_id is not None:
                saved = store.get_exchange(session_id, event_id, user_input)
                if saved is not None:
                    return self._replayed_response(saved)
            context["dialogue"] = store.get(session_id)
            context["history"] = self.memory.get_context_for_llm(session_id, limit=20)
            context["interest"] = self.memory.get_interest(session_id)
            context["intention"] = IntentionStore(self.memory).get_current(session_id)
            context['research_availability'] = IntentionStore(self.memory).availability(session_id)
            target = research_target(self.memory, session_id)
            current_target = extract_research_target(user_input)
            context["research_target"] = current_target or (target['url'] if target else None)
            if current_target and (target is None or current_target != target["url"]):
                # A different target creates a source revision when the exchange commits.
                context["intention"] = None
                context['research_availability'] = {'status': 'not_scheduled',
                    'blockers': ['source_changing'], 'next_planning_at': None}
            response = await self._process(user_input, context)
            saved = self.memory.save_exchange(
                session_id, user_input, response.content,
                channel=context.get("channel") or context.get("source") or "web",
                appraisal=context.get("_appraisal"),
                event_id=event_id,
                expected_revision=context["dialogue"]["revision"],
                now=context["event_at"],
                speaker=response.agent_name,
            )
            if saved["response"] != response.content or saved["agent_name"] != response.agent_name:
                # A second process may have committed this transport event
                # while generation ran. Return the committed reply, not a second
                # unrecorded version of the same event.
                return self._replayed_response(saved)
            return response

    @staticmethod
    def _replayed_response(saved):
        return AgentResponse(content=saved["response"], agent_name=saved["agent_name"],
                             confidence=1.0, emotion="", suggested_actions=[],
                             context_used={"replayed_event": True})

    async def _process(self, user_input: str, context: Dict) -> AgentResponse:
        await self._attach_github_evidence(user_input, context)
        decision = await self.route(user_input, context)
        response = await decision.selected_agent.process(user_input, context)
        return response

    def get_active_agent(self) -> Optional[BaseAgent]:
        """Возвращает текущего активного агента"""
        return self.current_agent or self.default_agent

    def get_all_agents_status(self) -> Dict:
        return {
            name: {
                "description": agent.description,
                "is_active": agent.is_active,
                "history_count": len(agent.conversation_history),
                "keywords": agent.activation_keywords
            }
            for name, agent in self.agents.items()
        }


# Создаём глобальный экземпляр
router = AgentRouter()
