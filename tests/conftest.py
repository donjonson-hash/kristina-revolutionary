"""
pytest fixtures for Kristina Revolutionary tests
"""

import os
import sys
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from typing import Dict, AsyncGenerator

# Добавляем корень проекта в PYTHONPATH
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# agents.ai_adapter создаёт AIClient при импорте, а тот требует ключ.
# Тесты API не вызывают (process замокан) — достаточно фиктивного значения.
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key-not-real")

# ─── Fixtures: Brain & Router ─────────────────────────────────

@pytest.fixture
def mock_ai_client():
    """Мок AI адаптера — не дёргаем API"""
    mock = MagicMock()
    mock.prepare_prompt = MagicMock(return_value="mocked prompt")
    mock.chat_completion = AsyncMock(return_value="mocked response from AI")
    return mock


@pytest.fixture
def router(persistent_memory):
    """AgentRouter с зарегистрированными тестовыми агентами"""
    from agents.base_agent import AgentResponse
    from agents.router import AgentRouter

    router = AgentRouter(memory=persistent_memory)
    return router


@pytest.fixture
async def router_with_agents(router):
    """Router с 3 зарегистрированными агентами"""
    from agents.kristina_persona import KristinaPersonaAgent
    from agents.kristina_advisor import KristinaAdvisorAgent
    from agents.kristina_creative import KristinaCreativeAgent
    from agents.base_agent import AgentResponse
    from unittest.mock import AsyncMock
    import copy

    persona = KristinaPersonaAgent()
    advisor = KristinaAdvisorAgent()
    creative = KristinaCreativeAgent()

    # Подменяем process на моки, чтобы не дёргать LLM
    persona.process = AsyncMock(return_value=AgentResponse(
        content="Я Кристина, привет!",
        agent_name="Kristina",
        confidence=0.9,
        emotion="friendly",
        suggested_actions=[],
        context_used={}
    ))
    advisor.process = AsyncMock(return_value=AgentResponse(
        content="Как твой личный советник...",
        agent_name="Kristina Advisor",
        confidence=0.9,
        emotion="thoughtful",
        suggested_actions=[],
        context_used={}
    ))
    creative.process = AsyncMock(return_value=AgentResponse(
        content="Креативная идея!",
        agent_name="Kristina Creative",
        confidence=0.9,
        emotion="excited",
        suggested_actions=[],
        context_used={}
    ))

    router.register_agent(persona, is_default=True)
    router.register_agent(advisor)
    router.register_agent(creative)

    return router, {"persona": persona, "advisor": advisor, "creative": creative}


@pytest.fixture
def base_context():
    """Базовый контекст для роутинга"""
    return {
        "user_id": "test_user",
        "user_name": "Тестер",
        "message_type": "text",
        "brain_recommendations": {}
    }


# ─── Fixtures: Emotional Core ─────────────────────────────────

@pytest.fixture
def emotional_core():
    """Эмоциональное ядро"""
    from emotional_core import EmotionalCore
    return EmotionalCore()


# ─── Fixtures: Database ───────────────────────────────────────

@pytest.fixture
async def memory_db():
    """Временная SQLite in-memory БД для тестов"""
    from database.sqlite import Database

    db = Database(":memory:")
    await db.connect()
    await db.init_tables()
    yield db
    await db.disconnect()


@pytest.fixture
def persistent_memory(tmp_path):
    """PersistentMemory с временным файлом"""
    from persistent_memory import PersistentMemory
    # Переопределяем путь БД
    test_db = tmp_path / "test_memory.db"
    pm = PersistentMemory(db_path=str(test_db))
    return pm


# ─── Fixtures: Mobile API ─────────────────────────────────────

@pytest.fixture
async def client():
    """TestClient для FastAPI мобильного API"""
    from fastapi.testclient import TestClient
    import mobile_api as api

    # Создаём приложение без middleware для rate limiting
    api_key = "test-secret-key-for-testing"
    import os
    os.environ["JWT_SECRET_KEY"] = api_key

    # Перезагружаем модуль, чтобы подхватить новый env
    import importlib
    importlib.reload(api)

    with TestClient(api.app) as c:
        yield c
