"""
MessageBus — межаватарная коммуникация.

Асинхронная шина сообщений: аватары общаются между собой
для решения задач, запросов и обмена контекстом.
"""

from __future__ import annotations
import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class AvatarMessage:
    """Сообщение между аватарами."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    sender_id: str = ""                 # avatar_id отправителя
    recipient_id: str = ""              # avatar_id получателя ("*" = broadcast)
    msg_type: str = "request"           # "request", "response", "notify", "task_delegation"
    subject: str = ""                   # тема / заголовок
    body: str = ""                      # содержимое
    metadata: Dict[str, Any] = field(default_factory=dict)
    reply_to: Optional[str] = None      # id сообщения, на которое отвечаем
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


# Тип обработчика: async def handler(message: AvatarMessage) -> Optional[AvatarMessage]
HandlerType = Callable[[AvatarMessage], Coroutine[Any, Any, Optional[AvatarMessage]]]


class MessageBus:
    """Центральная шина обмена сообщениями между аватарами."""

    def __init__(self):
        self._subscribers: Dict[str, HandlerType] = {}   # avatar_id → handler
        self._history: List[AvatarMessage] = []
        self._max_history: int = 500
        self._pending_replies: Dict[str, asyncio.Future] = {}  # msg_id → future

    # ── подписка / отписка ──────────────────────────────

    def subscribe(self, avatar_id: str, handler: HandlerType) -> None:
        """Подписать аватара на входящие сообщения."""
        self._subscribers[avatar_id] = handler
        logger.info(f"MessageBus: subscribed {avatar_id}")

    def unsubscribe(self, avatar_id: str) -> None:
        self._subscribers.pop(avatar_id, None)
        logger.info(f"MessageBus: unsubscribed {avatar_id}")

    # ── отправка ─────────────────────────────────────────

    async def send(self, message: AvatarMessage) -> Optional[AvatarMessage]:
        """
        Отправить сообщение.
        Если recipient_id = "*" — broadcast всем.
        Возвращает ответ (если получатель вернул AvatarMessage).
        """
        self._record(message)

        # проверяем, не ожидает ли кто-то ответ на reply_to
        if message.reply_to and message.reply_to in self._pending_replies:
            fut = self._pending_replies.pop(message.reply_to)
            if not fut.done():
                fut.set_result(message)
            return None

        # broadcast
        if message.recipient_id == "*":
            for aid, handler in self._subscribers.items():
                if aid != message.sender_id:
                    asyncio.create_task(self._safe_deliver(handler, message))
            return None

        # direct
        handler = self._subscribers.get(message.recipient_id)
        if handler is None:
            logger.warning(f"MessageBus: recipient {message.recipient_id} not found")
            return None

        reply = await self._safe_deliver(handler, message)

        # Если handler вернул ответ — проверяем pending futures для send_and_wait
        if reply is not None and reply.reply_to and reply.reply_to in self._pending_replies:
            fut = self._pending_replies.pop(reply.reply_to)
            if not fut.done():
                fut.set_result(reply)

        return reply

    async def send_and_wait(self, message: AvatarMessage, timeout: float = 30.0) -> Optional[AvatarMessage]:
        """
        Отправить и ждать ответа (request-response паттерн).
        """
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending_replies[message.id] = fut

        await self.send(message)

        try:
            reply = await asyncio.wait_for(fut, timeout=timeout)
            return reply
        except asyncio.TimeoutError:
            self._pending_replies.pop(message.id, None)
            logger.warning(f"MessageBus: timeout waiting reply for {message.id}")
            return None

    # ── внутренние ───────────────────────────────────────

    async def _safe_deliver(self, handler: HandlerType, message: AvatarMessage) -> Optional[AvatarMessage]:
        try:
            return await handler(message)
        except Exception:
            logger.exception(f"MessageBus: handler error for msg {message.id}")
            return None

    def _record(self, message: AvatarMessage) -> None:
        self._history.append(message)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

    # ── утилиты ──────────────────────────────────────────

    def get_history(self, avatar_id: Optional[str] = None, limit: int = 20) -> List[AvatarMessage]:
        """Получить историю сообщений (опционально фильтр по аватару)."""
        msgs = self._history
        if avatar_id:
            msgs = [m for m in msgs if m.sender_id == avatar_id or m.recipient_id == avatar_id]
        return msgs[-limit:]

    def get_stats(self) -> Dict[str, Any]:
        return {
            "subscribers": list(self._subscribers.keys()),
            "total_messages": len(self._history),
            "pending_replies": len(self._pending_replies),
        }
