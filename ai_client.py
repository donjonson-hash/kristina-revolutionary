"""
DeepSeek API клиент (v3.1 — P0 Hardened: shared pool, strict timeouts, typed errors)
Обратно совместим с вызовами в bot.py, cognitive_appraisal.py и agents/ai_adapter.py.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Dict, List, Optional

import aiohttp
from dotenv import load_dotenv

from kristina_identity import build_system_prompt

load_dotenv()

logger = logging.getLogger(__name__)


class AIClientError(RuntimeError):
    """Базовое типизированное исключение клиента LLM."""


class AIClientHTTPError(AIClientError):
    """Ошибка HTTP-ответа провайдера LLM."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body[:300]
        super().__init__(f"LLM HTTP {status}: {self.body}")


class AIClientTimeoutError(AIClientError):
    """Превышение таймаута ожидания ответа LLM."""


class AIClient:
    """DeepSeek API клиент с переиспользуемым пулом соединений и явными таймаутами."""

    DEFAULT_CONNECT_TIMEOUT = 5.0
    DEFAULT_TOTAL_TIMEOUT = 30.0
    DEFAULT_POOL_LIMIT = 20

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        url: str = "https://api.deepseek.com/v1/chat/completions",
        model: str = "deepseek-chat",
        total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        pool_limit: int = DEFAULT_POOL_LIMIT,
    ) -> None:
        self.api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise ValueError("DEEPSEEK_API_KEY not set")

        self.url = url
        self.model = model
        self.total_timeout = float(total_timeout)
        self.connect_timeout = float(connect_timeout)
        self.pool_limit = int(pool_limit)
        self._session: Optional[aiohttp.ClientSession] = None
        self._session_lock = asyncio.Lock()

    async def _get_session(self) -> aiohttp.ClientSession:
        async with self._session_lock:
            if self._session is None or self._session.closed:
                timeout = aiohttp.ClientTimeout(
                    total=self.total_timeout,
                    connect=self.connect_timeout,
                )
                connector = aiohttp.TCPConnector(
                    limit=self.pool_limit,
                    ttl_dns_cache=300,
                    enable_cleanup_closed=True,
                )
                self._session = aiohttp.ClientSession(
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    timeout=timeout,
                    connector=connector,
                )
            return self._session

    async def close(self) -> None:
        """Корректно закрыть пул HTTP-соединений при остановке процесса."""
        async with self._session_lock:
            if self._session and not self._session.closed:
                await self._session.close()
                self._session = None

    async def clear_memory(self, session_id: str) -> bool:
        """No-op хук для совместимости с agents/ai_adapter.py."""
        logger.debug("AIClient.clear_memory noop for session_id=%s", session_id)
        return True

    async def chat_strict(
        self,
        messages: List[Dict],
        *,
        temperature: float = 0.7,
        max_tokens: int = 800,
        timeout: Optional[float] = None,
    ) -> str:
        """
        Строгий вызов LLM (AUD-04 fix): выбрасывает AIClientError / AIClientTimeoutError /
        AIClientHTTPError вместо маскировки сбоев разговорным текстом.
        Рекомендуется для cognitive_appraisal, autonomy_decision и фоновых пайплайнов.
        """
        session = await self._get_session()
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        req_timeout = (
            aiohttp.ClientTimeout(total=float(timeout), connect=self.connect_timeout)
            if timeout is not None
            else None
        )
        try:
            async with session.post(self.url, json=payload, timeout=req_timeout) as response:
                if response.status != 200:
                    error_text = await response.text()
                    logger.error("DeepSeek API HTTP %s: %s", response.status, error_text[:200])
                    raise AIClientHTTPError(response.status, error_text)

                data = await response.json()
                choices = data.get("choices") or []
                if not choices or "message" not in choices[0]:
                    raise AIClientError("Malformed response payload: missing choices[0].message")
                content = choices[0]["message"].get("content")
                if not isinstance(content, str):
                    raise AIClientError("Malformed response payload: message.content is not str")
                return content
        except asyncio.TimeoutError as exc:
            logger.error("DeepSeek API timeout after %.1fs", timeout or self.total_timeout)
            raise AIClientTimeoutError("DeepSeek API request timed out") from exc
        except aiohttp.ClientError as exc:
            logger.error("DeepSeek network error: %s", exc)
            raise AIClientError(f"DeepSeek network error: {exc}") from exc

    async def chat(
        self,
        messages: List[Dict],
        temperature: float = 0.7,
        max_tokens: int = 800,
        *,
        raise_on_error: bool = False,
    ) -> str:
        """
        Обратно совместимая обёртка для bot.py и agents/ai_adapter.py.
        По умолчанию сохраняет прежний разговорный fallback для прямых ответов юзеру,
        но позволяет включить строгий режим raise_on_error=True без потери ошибок.
        """
        try:
            return await self.chat_strict(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except AIClientHTTPError:
            if raise_on_error:
                raise
            return "Блин, что-то с интернетом... Попробуй позже? 😅"
        except AIClientError:
            if raise_on_error:
                raise
            return "Ой, я тут задумалась... Можешь повторить? 💭"


_shared_client: Optional[AIClient] = None


def get_ai_client(*, singleton: bool = True) -> AIClient:
    """
    Возвращает общий экземпляр AIClient с переиспользуемым TCP/TLS-пулом (AUD-04 fix).
    Передайте singleton=False только в изолированных тестах.
    """
    global _shared_client
    if not singleton:
        return AIClient()
    if _shared_client is None:
        _shared_client = AIClient()
    return _shared_client


async def close_shared_ai_client() -> None:
    """Вызвать при shutdown приложения (post_shutdown в bot.py)."""
    global _shared_client
    if _shared_client is not None:
        await _shared_client.close()
        _shared_client = None


async def generate_response(
    prompt: str,
    agent_type: str = "Kristina",
    user_id: str = "default",
    context: Optional[list] = None,
) -> str:
    """Генерация ответа для Orchestrator v4.2 поверх общего пула сессий."""
    logger.debug("AI context received: %d messages (user_id=%s)", len(context) if context else 0, user_id)
    client = get_ai_client(singleton=True)
    try:
        system_content = build_system_prompt(agent_type)
        messages: List[Dict] = [{"role": "system", "content": system_content}]

        if context:
            for msg in context[-3:]:
                role = msg.get("role", "user")
                content_msg = msg.get("content", "")
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": content_msg})

        messages.append({"role": "user", "content": prompt})
        return await client.chat(messages, temperature=0.8, max_tokens=600)
    except Exception as exc:
        logger.error("generate_response error: %s", exc)
        return "Извини, я тут задумалась... Можешь повторить? 💭"


def generate_response_sync(prompt: str, agent_type: str = "Kristina", user_id: str = "default") -> str:
    """Синхронная обёртка (только для CLI/скриптов вне активного event loop)."""
    async def _run_once() -> str:
        client = AIClient()
        try:
            system_content = build_system_prompt(agent_type)
            messages = [
                {"role": "system", "content": system_content},
                {"role": "user", "content": prompt},
            ]
            return await client.chat(messages, temperature=0.8, max_tokens=600)
        finally:
            await client.close()

    return asyncio.run(_run_once())


def ai() -> AIClient:
    """Совместимость с bot.py — возвращает общий экземпляр AIClient."""
    return get_ai_client(singleton=True)
