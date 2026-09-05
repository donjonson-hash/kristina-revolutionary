"""
Agent Router - исправленная версия с set_active_agent
"""

from typing import Dict, List, Optional, NamedTuple
from .base_agent import BaseAgent, AgentResponse
from github_readonly import GitHubReadOnlyTool, extract_github_repo_url
from conversation_context import conversation_session_id
from persistent_memory import get_memory
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
        if ref is None:
            return

        context["github_repo"] = ref.full_name
        try:
            evidence = await self.github_reader.inspect(ref)
            context["github_evidence"] = evidence
            context.pop("github_error", None)
            logger.info("🔎 GitHub read-only evidence loaded for %s (%s chars)", ref.full_name, len(evidence))
        except Exception as exc:
            context.pop("github_evidence", None)
            context["github_error"] = f"{type(exc).__name__}: {exc}"
            logger.warning("⚠️ GitHub read-only inspection failed for %s: %s", ref.full_name, exc)

    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        """Обработка через выбранного агента"""
        context = dict(context)
        session_id = conversation_session_id(context)
        context["session_id"] = session_id
        if session_id is None:
            context["history"] = []
            return await self._process(user_input, context)
        async with self.session_lock(session_id):
            context["history"] = self.memory.get_context_for_llm(session_id, limit=20)
            response = await self._process(user_input, context)
            self.memory.save_exchange(
                session_id, user_input, response.content,
                channel=context.get("channel") or context.get("source") or "web",
            )
            return response

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
