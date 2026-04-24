"""
AvatarFactory — фабрика создания ИИ-аватаров под конкретного сотрудника.
"""

from __future__ import annotations
import uuid
import logging
from typing import Dict, List, Optional, TYPE_CHECKING

from .profession_profile import ProfessionProfile, get_profession, PROFESSION_REGISTRY
from .user_profile import UserProfile, BehaviorPattern
from .avatar_instance import AvatarInstance
from .llm_adapter import BaseLLMAdapter

if TYPE_CHECKING:
    from .message_bus import MessageBus
    from .task_manager import TaskManager

logger = logging.getLogger(__name__)

# Стандартные поведенческие паттерны
DEFAULT_PATTERNS = [
    BehaviorPattern(name="утренняя продуктивность", trigger="8-12",
                    effect={"energy": 0.1, "focus": 0.15}),
    BehaviorPattern(name="послеобеденный спад", trigger="13-15",
                    effect={"energy": -0.1, "focus": -0.05}),
    BehaviorPattern(name="вечернее завершение", trigger="17-19",
                    effect={"energy": -0.1, "stress": -0.05, "satisfaction": 0.05}),
]


class AvatarFactory:
    """Фабрика для создания аватаров."""

    def __init__(self, message_bus: Optional["MessageBus"] = None,
                 task_manager: Optional["TaskManager"] = None,
                 llm_adapter: Optional[BaseLLMAdapter] = None):
        self.message_bus = message_bus
        self.task_manager = task_manager
        self.llm_adapter = llm_adapter

    def create_avatar(
        self,
        user_id: str,
        name: str,
        role_id: str,
        personality: Optional[Dict[str, float]] = None,
        work_preferences: Optional[Dict[str, str]] = None,
        behavior_patterns: Optional[List[BehaviorPattern]] = None,
    ) -> AvatarInstance:
        """
        Создать ИИ-аватара для сотрудника.

        Args:
            user_id: уникальный id сотрудника
            name: имя сотрудника
            role_id: id профессии из PROFESSION_REGISTRY
            personality: Big Five (опционально, иначе defaults)
            work_preferences: предпочтения (опционально)
            behavior_patterns: паттерны (опционально, иначе стандартные)

        Returns:
            AvatarInstance готовый к работе
        """
        # 1. Получаем профиль профессии
        profession = get_profession(role_id)
        if profession is None:
            raise ValueError(f"Профессия '{role_id}' не найдена в реестре. "
                             f"Доступные: {list(PROFESSION_REGISTRY.keys())}")

        # 2. Создаём профиль пользователя
        patterns = behavior_patterns if behavior_patterns is not None else DEFAULT_PATTERNS.copy()
        user_profile = UserProfile(
            user_id=user_id,
            name=name,
            role_id=role_id,
            behavior_patterns=patterns,
        )
        if personality:
            user_profile.personality.update(personality)
        if work_preferences:
            user_profile.work_preferences.update(work_preferences)

        # 3. Генерируем avatar_id
        avatar_id = f"avatar_{role_id}_{user_id}"

        # 4. Собираем экземпляр
        avatar = AvatarInstance(
            avatar_id=avatar_id,
            user_profile=user_profile,
            profession_profile=profession,
            message_bus=self.message_bus,
            task_manager=self.task_manager,
            llm_adapter=self.llm_adapter,
        )

        logger.info(f"AvatarFactory: created {avatar_id} ({name}, {profession.title})")
        return avatar

    @staticmethod
    def list_available_professions() -> List[str]:
        """Список доступных профессий."""
        return list(PROFESSION_REGISTRY.keys())
