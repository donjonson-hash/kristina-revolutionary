"""
AvatarInstance — экземпляр ИИ-аватара конкретного сотрудника.

Объединяет: BrainBridge (мозг), ProfessionProfile, UserProfile,
память, эмоции. Умеет обрабатывать задачи и общаться с другими аватарами.
"""

from __future__ import annotations
import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from .profession_profile import ProfessionProfile
from .user_profile import UserProfile
from .message_bus import AvatarMessage
from .llm_adapter import BaseLLMAdapter, get_llm_adapter

if TYPE_CHECKING:
    from .message_bus import MessageBus
    from .task_manager import TaskManager, Task

logger = logging.getLogger(__name__)


class AvatarInstance:
    """Один ИИ-аватар = один сотрудник."""

    def __init__(
        self,
        avatar_id: str,
        user_profile: UserProfile,
        profession_profile: ProfessionProfile,
        message_bus: Optional["MessageBus"] = None,
        task_manager: Optional["TaskManager"] = None,
        llm_adapter: Optional[BaseLLMAdapter] = None,
    ):
        self.avatar_id = avatar_id
        self.user = user_profile
        self.profession = profession_profile
        self.message_bus = message_bus
        self.task_manager = task_manager
        self.llm = llm_adapter or get_llm_adapter()

        # Внутреннее состояние
        self._inbox: List[AvatarMessage] = []
        self._outbox: List[AvatarMessage] = []
        self.created_at = datetime.now().isoformat()

        # Авторегистрация в шине
        if self.message_bus:
            self.message_bus.subscribe(self.avatar_id, self._on_message)

    # ── Свойства ─────────────────────────────────────────

    @property
    def name(self) -> str:
        return self.user.name

    @property
    def role(self) -> str:
        return self.profession.title

    @property
    def skills(self) -> List[str]:
        return self.profession.core_skills

    # ── Построение промпта ────────────────────────────────

    def build_system_prompt(self) -> str:
        """Полный system prompt для LLM, собранный из профессии + профиля пользователя."""
        prof_prompt = self.profession.build_system_prompt(self.user.name)
        user_ctx = self.user.build_avatar_context()
        delegation = self.user.get_delegation_level()

        prompt = (
            f"{prof_prompt}\n"
            f"--- Контекст владельца ---\n"
            f"{user_ctx}\n"
            f"Уровень автономии: {delegation:.0%}. "
        )
        if delegation >= 0.8:
            prompt += "Ты можешь принимать решения самостоятельно и выполнять задачи без подтверждения.\n"
        elif delegation >= 0.5:
            prompt += "Предлагай решения, но спрашивай подтверждение для важных действий.\n"
        else:
            prompt += "Всегда спрашивай подтверждение перед выполнением.\n"

        return prompt

    # ── Обработка входящих сообщений от других аватаров ──

    async def _on_message(self, message: AvatarMessage) -> Optional[AvatarMessage]:
        """Обработчик входящих сообщений от шины."""
        self._inbox.append(message)
        logger.info(f"Avatar {self.avatar_id} received msg from {message.sender_id}: {message.subject}")

        if message.msg_type == "request":
            return await self._handle_request(message)
        elif message.msg_type == "task_delegation":
            return await self._handle_task_delegation(message)
        elif message.msg_type == "notify":
            # просто принимаем к сведению
            return None
        return None

    async def _handle_request(self, message: AvatarMessage) -> AvatarMessage:
        """Обработать запрос от другого аватара через LLM."""
        system_prompt = self.build_system_prompt() + (
            "\n\n--- Инструкция ---\n"
            "Тебе пришёл запрос от коллеги. Ответь по существу, "
            "используя свои профессиональные навыки. Будь конкретен и полезен.\n"
        )
        user_prompt = (
            f"Запрос от коллеги (тема: '{message.subject}'):\n"
            f"{message.body}\n\n"
            f"Ответь как {self.role}, кратко и по делу."
        )

        try:
            response_body = await self.llm.generate(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.7,
                max_tokens=400,
            )
        except Exception as e:
            logger.exception(f"Avatar {self.avatar_id}: LLM error in _handle_request")
            response_body = (
                f"[{self.role} / {self.name}] Получил запрос: '{message.subject}'. "
                f"Мои навыки: {', '.join(self.skills[:3])}. Готов помочь."
            )

        reply = AvatarMessage(
            sender_id=self.avatar_id,
            recipient_id=message.sender_id,
            msg_type="response",
            subject=f"Re: {message.subject}",
            body=response_body,
            reply_to=message.id,
        )
        self._outbox.append(reply)
        return reply

    async def _handle_task_delegation(self, message: AvatarMessage) -> AvatarMessage:
        """Принять делегированную задачу через LLM."""
        task_id = message.metadata.get("task_id", "")
        task_title = message.metadata.get("task_title", message.subject)

        # Предложить метод решения через LLM
        solution = await self._propose_solution(task_title, message.body)

        reply = AvatarMessage(
            sender_id=self.avatar_id,
            recipient_id=message.sender_id,
            msg_type="response",
            subject=f"Принял задачу: {task_title}",
            body=f"Предлагаю решение: {solution['method']}. {solution['description']}",
            reply_to=message.id,
            metadata={"task_id": task_id, "proposed_solution": solution},
        )
        self._outbox.append(reply)

        # Записать в TaskManager если доступен
        if self.task_manager and task_id:
            self.task_manager.propose_solution(task_id, solution["method"], solution["description"])

        return reply

    async def _propose_solution(self, task_title: str, task_body: str = "") -> Dict[str, str]:
        """Предложить метод решения задачи через LLM."""
        system_prompt = self.build_system_prompt() + (
            "\n\n--- Инструкция ---\n"
            "Тебе делегирована задача. Предложи конкретный метод решения.\n"
            "Ответь строго в формате:\n"
            "МЕТОД: <краткое название метода>\n"
            "ОПИСАНИЕ: <1-2 предложения о том, как ты будешь решать задачу>\n"
        )
        user_prompt = (
            f"Задача: {task_title}\n"
        )
        if task_body:
            user_prompt += f"Подробности: {task_body}\n"
        user_prompt += f"\nПредложи метод решения как {self.role}."

        try:
            raw = await self.llm.generate(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.7,
                max_tokens=300,
            )
            return self._parse_solution(raw, task_title)
        except Exception as e:
            logger.exception(f"Avatar {self.avatar_id}: LLM error in _propose_solution")
            return {"method": "анализ + план действий",
                    "description": "Проанализирую задачу и предложу пошаговый план."}

    @staticmethod
    def _parse_solution(raw_text: str, fallback_title: str = "") -> Dict[str, str]:
        """Извлечь метод и описание из текста LLM."""
        method = ""
        description = ""
        for line in raw_text.split("\n"):
            line_stripped = line.strip()
            lower = line_stripped.lower()
            if lower.startswith("метод:") or lower.startswith("method:"):
                method = line_stripped.split(":", 1)[1].strip()
            elif lower.startswith("описание:") or lower.startswith("description:"):
                description = line_stripped.split(":", 1)[1].strip()

        # Если LLM не следует формату — берём весь текст
        if not method:
            method = raw_text[:80].replace("\n", " ").strip()
        if not description:
            description = raw_text[80:].replace("\n", " ").strip() if len(raw_text) > 80 else raw_text

        return {"method": method, "description": description}

    # ── Отправка сообщений другим аватарам ────────────────

    async def send_message(self, recipient_id: str, subject: str, body: str,
                           msg_type: str = "request", metadata: Optional[Dict] = None) -> Optional[AvatarMessage]:
        """Отправить сообщение другому аватару."""
        if not self.message_bus:
            logger.warning(f"Avatar {self.avatar_id}: no message bus")
            return None

        msg = AvatarMessage(
            sender_id=self.avatar_id,
            recipient_id=recipient_id,
            msg_type=msg_type,
            subject=subject,
            body=body,
            metadata=metadata or {},
        )
        self._outbox.append(msg)
        return await self.message_bus.send(msg)

    async def request_help(self, recipient_id: str, subject: str, body: str,
                           timeout: float = 30.0) -> Optional[AvatarMessage]:
        """Попросить помощи у другого аватара и дождаться ответа."""
        if not self.message_bus:
            return None

        msg = AvatarMessage(
            sender_id=self.avatar_id,
            recipient_id=recipient_id,
            msg_type="request",
            subject=subject,
            body=body,
        )
        self._outbox.append(msg)
        return await self.message_bus.send_and_wait(msg, timeout=timeout)

    # ── Делегирование задачи другому аватару ──────────────

    async def delegate_task(self, recipient_id: str, task_title: str,
                            task_description: str) -> Optional[AvatarMessage]:
        """Делегировать задачу другому аватару."""
        task_id = ""
        if self.task_manager:
            task = self.task_manager.create_task(
                title=task_title,
                description=task_description,
                created_by=self.avatar_id,
            )
            self.task_manager.assign_task(task.id, recipient_id)
            task_id = task.id

        return await self.send_message(
            recipient_id=recipient_id,
            subject=task_title,
            body=task_description,
            msg_type="task_delegation",
            metadata={"task_id": task_id, "task_title": task_title},
        )

    # ── Статус ────────────────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        return {
            "avatar_id": self.avatar_id,
            "name": self.name,
            "role": self.role,
            "emotional_state": self.user.get_emotional_summary(),
            "delegation_level": self.user.get_delegation_level(),
            "inbox_count": len(self._inbox),
            "outbox_count": len(self._outbox),
        }
