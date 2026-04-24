"""
Kristina AI Avatar Platform — корпоративная мультиагентная система.

Каждый сотрудник компании получает ИИ-аватара, который:
- Учитывает профессию, навыки и рабочие паттерны
- Моделирует психоэмоциональное состояние владельца
- Выполняет рутинные задачи самостоятельно
- Общается с аватарами других сотрудников для решения задач
"""

from .profession_profile import ProfessionProfile, PROFESSION_REGISTRY
from .user_profile import UserProfile
from .avatar_instance import AvatarInstance
from .avatar_factory import AvatarFactory
from .message_bus import MessageBus, AvatarMessage
from .task_manager import TaskManager, Task, TaskStatus
from .avatar_network import AvatarNetwork
from .llm_adapter import BaseLLMAdapter, DeepSeekAdapter, MockLLMAdapter, get_llm_adapter, set_llm_adapter

__all__ = [
    "ProfessionProfile", "PROFESSION_REGISTRY",
    "UserProfile",
    "AvatarInstance",
    "AvatarFactory",
    "MessageBus", "AvatarMessage",
    "TaskManager", "Task", "TaskStatus",
    "AvatarNetwork",
]
