"""
LLM Adapter для платформы аватаров.

Абстракция над конкретным LLM-провайдером (DeepSeek, Claude, OpenAI и т.д.).
Позволяет:
  - Подменить реализацию на mock для тестов
  - Переключаться между провайдерами без изменений в avatar_instance
  - Формировать промпты с учётом профессии и контекста аватара
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# Абстрактный интерфейс
# ═══════════════════════════════════════════════════════════

class BaseLLMAdapter(ABC):
    """Интерфейс LLM-адаптера для аватаров."""

    @abstractmethod
    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 800,
    ) -> str:
        """Сгенерировать ответ LLM."""
        ...

    async def close(self) -> None:
        """Закрыть ресурсы (сессии и т.д.)."""
        pass


# ═══════════════════════════════════════════════════════════
# DeepSeek реализация (основной провайдер проекта)
# ═══════════════════════════════════════════════════════════

class DeepSeekAdapter(BaseLLMAdapter):
    """Адаптер к DeepSeek API (совместим с OpenAI chat/completions)."""

    def __init__(self, api_key: Optional[str] = None, model: str = "deepseek-chat"):
        self.api_key = api_key or os.getenv("DEEPSEEK_API_KEY", "")
        self.model = model
        self.url = "https://api.deepseek.com/v1/chat/completions"
        self._session = None

    async def _get_session(self):
        # Ленивый импорт — aiohttp может быть не установлен в тестовом окружении
        import aiohttp
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=aiohttp.ClientTimeout(total=30),
            )
        return self._session

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 800,
    ) -> str:
        if not self.api_key:
            logger.warning("DeepSeekAdapter: API key не задан")
            return f"[LLM недоступен] {user_prompt[:100]}"

        session = await self._get_session()
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        try:
            async with session.post(self.url, json=payload) as resp:
                if resp.status != 200:
                    error = await resp.text()
                    logger.error(f"DeepSeek API {resp.status}: {error[:200]}")
                    return f"[LLM ошибка {resp.status}]"
                data = await resp.json()
                return data["choices"][0]["message"]["content"]
        except Exception as e:
            logger.exception("DeepSeekAdapter.generate error")
            return f"[LLM ошибка: {e}]"

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None


# ═══════════════════════════════════════════════════════════
# Mock реализация (для тестов без реального API)
# ═══════════════════════════════════════════════════════════

class MockLLMAdapter(BaseLLMAdapter):
    """
    Mock-адаптер: возвращает осмысленный ответ на основе
    ключевых слов из промпта. Не требует сети и API-ключей.
    """

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 800,
    ) -> str:
        combined = (system_prompt + " " + user_prompt).lower()

        # Определяем роль из system_prompt
        role = "специалист"
        if "ux" in combined or "дизайн" in combined:
            role = "UX-дизайнер"
        elif "backend" in combined or "api" in combined or "сервер" in combined:
            role = "Backend-разработчик"
        elif "менеджер" in combined or "pm" in combined or "проект" in combined:
            role = "Проектный менеджер"
        elif "qa" in combined or "тест" in combined:
            role = "QA-инженер"
        elif "frontend" in combined or "react" in combined or "компонент" in combined:
            role = "Frontend-разработчик"
        elif "devops" in combined or "docker" in combined or "deploy" in combined:
            role = "DevOps-инженер"

        # Определяем тип запроса
        if "задач" in combined or "delegation" in combined:
            return (
                f"Как {role}, я принимаю задачу. "
                f"Предлагаю следующий подход: "
                f"1) Анализ требований. "
                f"2) Декомпозиция на подзадачи. "
                f"3) Реализация с промежуточными ревью. "
                f"Ожидаемый срок: 2-3 рабочих дня."
            )

        if "помощь" in combined or "помоги" in combined or "нужен" in combined:
            return (
                f"Как {role}, готов помочь. "
                f"Для этой задачи предлагаю: провести анализ текущей ситуации, "
                f"определить ключевые требования и подготовить план действий. "
                f"Могу начать прямо сейчас."
            )

        if "реши" in combined or "решение" in combined or "метод" in combined:
            return (
                f"Как {role}, предлагаю решение: "
                f"Шаг 1 — собрать требования и ограничения. "
                f"Шаг 2 — подготовить черновой вариант. "
                f"Шаг 3 — ревью с командой и доработка. "
                f"Это самый эффективный подход для данной ситуации."
            )

        # Общий ответ
        return (
            f"Как {role}, я проанализировал запрос. "
            f"Мои ключевые рекомендации: "
            f"сфокусироваться на приоритетных аспектах задачи, "
            f"использовать проверенные подходы и привлечь коллег при необходимости."
        )


# ═══════════════════════════════════════════════════════════
# Фабрика / глобальный доступ
# ═══════════════════════════════════════════════════════════

_global_adapter: Optional[BaseLLMAdapter] = None


def get_llm_adapter() -> BaseLLMAdapter:
    """
    Получить LLM-адаптер.
    - Если задан DEEPSEEK_API_KEY — возвращает DeepSeekAdapter.
    - Иначе — MockLLMAdapter (для тестов / offline).
    """
    global _global_adapter
    if _global_adapter is not None:
        return _global_adapter

    api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if api_key:
        _global_adapter = DeepSeekAdapter(api_key=api_key)
        logger.info("LLM adapter: DeepSeek (live)")
    else:
        _global_adapter = MockLLMAdapter()
        logger.info("LLM adapter: Mock (offline)")
    return _global_adapter


def set_llm_adapter(adapter: BaseLLMAdapter) -> None:
    """Принудительно установить адаптер (для тестов)."""
    global _global_adapter
    _global_adapter = adapter


def reset_llm_adapter() -> None:
    """Сбросить адаптер (пересоздастся при следующем вызове)."""
    global _global_adapter
    _global_adapter = None
