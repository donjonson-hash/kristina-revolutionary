"""
AvatarNetwork — реестр всех аватаров компании.

Центральный хаб: создание аватаров, discovery,
маршрутизация задач, статистика.
"""

from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional

from .avatar_factory import AvatarFactory
from .avatar_instance import AvatarInstance
from .message_bus import MessageBus
from .task_manager import TaskManager, Task, TaskStatus, TaskPriority
from .user_profile import BehaviorPattern

logger = logging.getLogger(__name__)


class AvatarNetwork:
    """Сеть всех ИИ-аватаров компании."""

    def __init__(self):
        self.message_bus = MessageBus()
        self.task_manager = TaskManager()
        self.factory = AvatarFactory(
            message_bus=self.message_bus,
            task_manager=self.task_manager,
        )
        self._avatars: Dict[str, AvatarInstance] = {}

    # ── Управление аватарами ─────────────────────────────

    def add_avatar(
        self,
        user_id: str,
        name: str,
        role_id: str,
        personality: Optional[Dict[str, float]] = None,
        work_preferences: Optional[Dict[str, str]] = None,
    ) -> AvatarInstance:
        """Создать и зарегистрировать аватара в сети."""
        avatar = self.factory.create_avatar(
            user_id=user_id,
            name=name,
            role_id=role_id,
            personality=personality,
            work_preferences=work_preferences,
        )
        self._avatars[avatar.avatar_id] = avatar
        logger.info(f"AvatarNetwork: registered {avatar.avatar_id}")
        return avatar

    def get_avatar(self, avatar_id: str) -> Optional[AvatarInstance]:
        return self._avatars.get(avatar_id)

    def find_by_role(self, role_id: str) -> List[AvatarInstance]:
        """Найти всех аватаров с данной ролью."""
        return [a for a in self._avatars.values() if a.user.role_id == role_id]

    def find_by_skill(self, skill: str) -> List[AvatarInstance]:
        """Найти аватаров, у которых есть нужный навык."""
        result = []
        for avatar in self._avatars.values():
            if any(skill.lower() in s.lower() for s in avatar.skills):
                result.append(avatar)
        return result

    def list_avatars(self) -> List[Dict[str, Any]]:
        """Список всех аватаров с кратким статусом."""
        return [a.get_status() for a in self._avatars.values()]

    # ── Задачи ────────────────────────────────────────────

    def create_and_assign_task(
        self,
        title: str,
        description: str,
        created_by: str,
        required_skills: Optional[List[str]] = None,
        priority: TaskPriority = TaskPriority.MEDIUM,
    ) -> Optional[Task]:
        """
        Создать задачу и автоматически назначить лучшему аватару.
        """
        task = self.task_manager.create_task(
            title=title,
            description=description,
            created_by=created_by,
            priority=priority,
            required_skills=required_skills or [],
        )

        # Собираем карту навыков
        available: Dict[str, List[str]] = {}
        for aid, avatar in self._avatars.items():
            if aid != created_by:
                available[aid] = avatar.skills

        best = self.task_manager.find_best_executor(task, available)
        if best:
            self.task_manager.assign_task(task.id, best)
            logger.info(f"AvatarNetwork: task '{title}' → {best}")
        else:
            logger.warning(f"AvatarNetwork: no executor found for '{title}'")

        return task

    # ── Статистика ────────────────────────────────────────

    def get_network_stats(self) -> Dict[str, Any]:
        return {
            "total_avatars": len(self._avatars),
            "avatars": {aid: a.get_status() for aid, a in self._avatars.items()},
            "message_bus": self.message_bus.get_stats(),
            "tasks": self.task_manager.get_stats(),
        }
