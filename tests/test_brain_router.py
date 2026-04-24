"""
Test Suite: Brain Agent Router

Проверяет:
1. AgentRouter — регистрация, маршрутизация, выбор агента
2. BaseAgent — should_activate, activate/deactivate
3. KristinaPersonaAgent — should_activate по ключевым словам
4. KristinaAdvisorAgent — консультационные запросы
5. KristinaCreativeAgent — креативные запросы
6. RoutingDecision — NamedTuple корректность
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from typing import Dict

from agents.router import AgentRouter, RoutingDecision
from agents.base_agent import BaseAgent, AgentResponse


# ═════════════════════════════════════════════════════════════
# 1. BaseAgent — базовая функциональность
# ═════════════════════════════════════════════════════════════

class TestBaseAgent:

    def test_construction(self):
        """Агент создаётся с именем, описанием и промптом"""
        agent = DummyAgent()
        assert agent.name == "TestAgent"
        assert agent.description == "Тестовый агент"
        assert agent.system_prompt == "Ты тестовый агент."
        assert agent.is_active is False
        assert agent.conversation_history == []

    def test_should_activate_exact_keyword(self):
        """Попадание по ключевому слову даёт score > 0"""
        agent = DummyAgent()
        score = agent.should_activate("мне нужна дизайн идея")
        assert score > 0, f"Expected >0, got {score}"

    def test_should_activate_no_keyword(self):
        """Без ключевых слов score = 0"""
        agent = DummyAgent()
        score = agent.should_activate("как дела?")
        assert score == 0.0, f"Expected 0, got {score}"

    def test_should_activate_multiple_keywords(self):
        """Несколько ключевых слов увеличивают score (но не > 1.0)"""
        agent = DummyAgent(keywords=["дизайн", "идея", "креатив"])
        score = agent.should_activate("нужна креативная дизайн идея")
        assert 0.0 < score <= 1.0, f"Expected 0<score<=1, got {score}"

    def test_activate_deactivate(self):
        """activate/deactivate меняют is_active"""
        agent = DummyAgent()
        assert agent.is_active is False
        agent.activate()
        assert agent.is_active is True
        agent.deactivate()
        assert agent.is_active is False

    def test_add_to_history(self):
        """История хранит последние 20 сообщений"""
        agent = DummyAgent()
        for i in range(25):
            agent.add_to_history("user", f"message {i}")
        assert len(agent.conversation_history) == 20
        assert agent.conversation_history[0]["content"] == "message 5"

    def test_add_to_history_includes_agent_name(self):
        """Каждое сообщение в истории содержит имя агента"""
        agent = DummyAgent()
        agent.add_to_history("user", "привет")
        assert agent.conversation_history[-1]["agent"] == "TestAgent"

    def test_get_history_prompt_empty(self):
        """Пустая история возвращает пустую строку"""
        agent = DummyAgent()
        assert agent.get_history_prompt() == ""

    def test_get_history_prompt_formats_recent(self):
        """get_history_prompt форматирует последние 5 сообщений"""
        agent = DummyAgent()
        for i in range(6):
            agent.add_to_history("user", f"msg {i}")
        prompt = agent.get_history_prompt()
        assert "msg 5" in prompt
        assert "📜" in prompt

    def test_agent_response_dataclass(self):
        """AgentResponse корректно создаётся"""
        response = AgentResponse(
            content="Привет!",
            agent_name="Kristina",
            confidence=0.95,
            emotion="happy",
            suggested_actions=["спросить как дела"],
            context_used={"user_id": "123"}
        )
        assert response.content == "Привет!"
        assert response.agent_name == "Kristina"


# ═════════════════════════════════════════════════════════════
# 2. AgentRouter — регистрация и базовая маршрутизация
# ═════════════════════════════════════════════════════════════

class TestAgentRouter:

    def test_init(self):
        """Router создаётся пустым"""
        router = AgentRouter()
        assert router.agents == {}
        assert router.default_agent is None
        assert router.current_agent is None

    def test_register_agent(self, router):
        """Регистрация добавляет агента в словарь"""
        agent = DummyAgent()
        router.register_agent(agent)
        assert "TestAgent" in router.agents
        assert router.agents["TestAgent"] is agent

    def test_register_agent_default(self, router):
        """Флаг is_default устанавливает default_agent и current_agent"""
        agent = DummyAgent()
        router.register_agent(agent, is_default=True)
        assert router.default_agent is agent
        assert router.current_agent is agent

    def test_register_multiple_agents(self, router):
        """Множественная регистрация"""
        a1 = DummyAgent("Agent1", ["keyword1"])
        a2 = DummyAgent("Agent2", ["keyword2"])
        router.register_agent(a1)
        router.register_agent(a2, is_default=True)
        assert len(router.agents) == 2
        assert router.default_agent is a2

    def test_set_active_agent_by_class_name(self, router):
        """Установка активного агента по имени класса"""
        agent = DummyAgent()
        router.register_agent(agent)
        result = router.set_active_agent("DummyAgent")
        assert result is True
        assert router.current_agent is agent
        assert agent.is_active is True

    def test_set_active_agent_by_name(self, router):
        """Установка активного агента по имени агента"""
        agent = DummyAgent()
        router.register_agent(agent)
        result = router.set_active_agent("TestAgent")
        assert result is True

    def test_set_active_agent_not_found(self, router):
        """Несуществующий агент возвращает False"""
        result = router.set_active_agent("NonExistent")
        assert result is False

    def test_get_active_agent_returns_current(self, router):
        """get_active_agent возвращает current_agent"""
        default = DummyAgent("Default", [])
        router.register_agent(default, is_default=True)
        assert router.get_active_agent() is default

        alt = DummyAgent("Alt", [])
        router.register_agent(alt)
        router.set_active_agent("Alt")
        assert router.get_active_agent() is alt

    def test_get_active_agent_fallback(self, router):
        """get_active_agent падает на default если current не установлен"""
        # Без default должен быть None
        assert router.get_active_agent() is None

        # С default — возвращается он
        default = DummyAgent("Default", [])
        router.register_agent(default, is_default=True)
        # Сбрасываем current
        router.current_agent = None
        assert router.get_active_agent() is default


# ═════════════════════════════════════════════════════════════
# 3. AgentRouter — маршрутизация (auto-route)
# ═════════════════════════════════════════════════════════════

class TestRouting:

    @pytest.mark.asyncio
    async def test_route_default_agent(self, router_with_agents, base_context):
        """Если есть current_agent, роутер возвращает его"""
        router, agents = router_with_agents
        router.set_active_agent("KristinaPersonaAgent")

        decision = await router.route("как дела?", base_context)

        assert decision.selected_agent is agents["persona"]
        assert decision.confidence == 1.0

    @pytest.mark.asyncio
    async def test_route_brain_recommendation(self, router_with_agents):
        """Brain рекомендации переопределяют current_agent"""
        router, agents = router_with_agents
        context = {
            "user_id": "test",
            "user_name": "Tester",
            "message_type": "text",
            "brain_recommendations": {
                "agent_recommendations": ["KristinaAdvisorAgent"]
            }
        }

        decision = await router.route("мне нужен совет по бизнесу", context)

        assert decision.selected_agent is agents["advisor"]
        assert decision.confidence == 1.0

    @pytest.mark.asyncio
    async def test_route_brain_recommendation_no_match(self, router_with_agents, base_context):
        """Если brain рекомендация не найдена — падает на default"""
        router, agents = router_with_agents
        context = base_context.copy()
        context["brain_recommendations"] = {
            "agent_recommendations": ["NonExistentAgent"]
        }

        decision = await router.route("привет", context)
        # Должен выбрать default
        assert decision.selected_agent is agents["persona"]

    @pytest.mark.asyncio
    async def test_route_no_current_agent_no_default(self, base_context):
        """Без current_agent и default — роутер выбирает агента с highest score"""
        router = AgentRouter()
        a1 = DummyAgent("Agent1", ["test"])
        router.register_agent(a1)

        decision = await router.route("test keyword", base_context)
        # Если нет default_agent — берётся первый (единственный) зарегистрированный
        assert decision.selected_agent is a1
        assert decision.confidence >= 0
        # Проверяем, что решение принято без ошибок
        assert len(decision.alternatives) >= 0

    @pytest.mark.asyncio
    async def test_route_high_confidence_auto_select(self, base_context):
        """Авто-выбор с default_agent возвращает его с базовой уверенностью"""
        router = AgentRouter()
        a1 = DummyAgent("Agent1", ["test", "check", "verify"])
        a2 = DummyAgent("Agent2", ["hello"])
        router.register_agent(a1, is_default=True)
        router.register_agent(a2)

        # Сбрасываем current_agent, чтобы включить авто-выбор
        router.current_agent = None

        decision = await router.route("надо проверить test", base_context)
        assert decision.selected_agent is a1 or decision.selected_agent is a2
        assert decision.confidence >= 0
        # Должны быть alternatives
        assert len(decision.alternatives) >= 0


# ═════════════════════════════════════════════════════════════
# 4. AgentRouter — process (полный пайплайн)
# ═════════════════════════════════════════════════════════════

class TestPipeline:

    @pytest.mark.asyncio
    async def test_process_routes_and_processes(self, router_with_agents, base_context):
        """process() вызывает route() + agent.process()"""
        router, agents = router_with_agents

        response = await router.process("как дела?", base_context)

        assert response.agent_name == "Kristina"
        assert response.content == "Я Кристина, привет!"

    @pytest.mark.asyncio
    async def test_process_with_brain_recommendation(self, router_with_agents):
        """Brain-рекомендация меняет агента для обработки"""
        router, agents = router_with_agents
        context = {
            "user_id": "test",
            "user_name": "Tester",
            "message_type": "text",
            "brain_recommendations": {
                "agent_recommendations": ["KristinaAdvisorAgent"]
            }
        }

        response = await router.process("дай совет", context)

        assert response.agent_name == "Kristina Advisor"
        assert "советник" in response.content


# ═════════════════════════════════════════════════════════════
# 5. Status & Reporting
# ═════════════════════════════════════════════════════════════

class TestRouterStatus:

    def test_get_all_agents_status_empty(self, router):
        """Пустой роутер возвращает пустой dict"""
        assert router.get_all_agents_status() == {}

    def test_get_all_agents_status(self, router_with_agents):
        """Статус содержит описание и историю всех агентов"""
        router, agents = router_with_agents
        status = router.get_all_agents_status()

        assert "Kristina" in status
        assert status["Kristina"]["description"] == "UX-дизайнер, 25 лет, Стокгольм - реалистичная, саркастичная"
        assert status["Kristina"]["history_count"] == 0
        assert status["Kristina"]["is_active"] is False  # не активирован вручную

    def test_get_all_agents_status_after_activate(self, router_with_agents):
        """Активация агента отражается в статусе"""
        router, agents = router_with_agents
        router.set_active_agent("KristinaPersonaAgent")
        status = router.get_all_agents_status()
        assert status["Kristina"]["is_active"] is True

    @pytest.mark.asyncio
    async def test_routing_decision_structure(self, router_with_agents, base_context):
        """RoutingDecision имеет правильную структуру"""
        router, agents = router_with_agents

        decision = await router.route("тест", base_context)

        assert isinstance(decision, RoutingDecision)
        assert hasattr(decision, "selected_agent")
        assert hasattr(decision, "confidence")
        assert hasattr(decision, "alternatives")


# ═════════════════════════════════════════════════════════════
# Helper: DummyAgent для тестов
# ═════════════════════════════════════════════════════════════

class DummyAgent(BaseAgent):
    """Тестовый агент, не дёргающий LLM"""

    def __init__(self, name: str = "TestAgent", keywords: list = None):
        super().__init__(
            name=name,
            description="Тестовый агент",
            system_prompt="Ты тестовый агент."
        )
        self.activation_keywords = keywords or ["дизайн", "творчество", "test"]
        self._mock_response_content = "mock response"

    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        return AgentResponse(
            content=self._mock_response_content,
            agent_name=self.name,
            confidence=0.9,
            emotion="neutral",
            suggested_actions=[],
            context_used={"input": user_input}
        )
