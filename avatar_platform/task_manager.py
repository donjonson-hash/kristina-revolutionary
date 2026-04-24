"""
TaskManager — управление задачами между аватарами.

Задачи создаются пользователем или аватаром, распределяются
по исполнителям (другим аватарам), отслеживаются до завершения.
"""

from __future__ import annotations
import uuid
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class TaskStatus(Enum):
    CREATED = "created"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"              # аватар выполнил, ждёт одобрения
    APPROVED = "approved"
    REJECTED = "rejected"
    DONE = "done"
    CANCELLED = "cancelled"


class TaskPriority(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class Task:
    """Задача в системе."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = ""
    description: str = ""
    status: TaskStatus = TaskStatus.CREATED
    priority: TaskPriority = TaskPriority.MEDIUM

    # кто создал
    created_by: str = ""           # avatar_id или user_id
    # кому назначена
    assigned_to: str = ""          # avatar_id исполнителя
    # какие аватары участвуют (коллаборация)
    collaborators: List[str] = field(default_factory=list)

    # результат
    result: str = ""               # текст результата / артефакт
    rejection_reason: str = ""

    # предложенные методы решения (аватар предлагает сам)
    proposed_solutions: List[Dict[str, str]] = field(default_factory=list)

    # метаданные
    required_skills: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def update_status(self, new_status: TaskStatus) -> None:
        self.status = new_status
        self.updated_at = datetime.now().isoformat()


class TaskManager:
    """Центральный менеджер задач."""

    def __init__(self):
        self._tasks: Dict[str, Task] = {}

    # ── CRUD ─────────────────────────────────────────────

    def create_task(self, title: str, description: str,
                    created_by: str,
                    priority: TaskPriority = TaskPriority.MEDIUM,
                    required_skills: Optional[List[str]] = None,
                    metadata: Optional[Dict] = None) -> Task:
        """Создать новую задачу."""
        task = Task(
            title=title,
            description=description,
            created_by=created_by,
            priority=priority,
            required_skills=required_skills or [],
            metadata=metadata or {},
        )
        self._tasks[task.id] = task
        logger.info(f"TaskManager: created task {task.id} '{title}'")
        return task

    def get_task(self, task_id: str) -> Optional[Task]:
        return self._tasks.get(task_id)

    def list_tasks(self, status: Optional[TaskStatus] = None,
                   assigned_to: Optional[str] = None) -> List[Task]:
        """Список задач с фильтрацией."""
        tasks = list(self._tasks.values())
        if status:
            tasks = [t for t in tasks if t.status == status]
        if assigned_to:
            tasks = [t for t in tasks if t.assigned_to == assigned_to]
        return sorted(tasks, key=lambda t: t.created_at, reverse=True)

    # ── Назначение ────────────────────────────────────────

    def assign_task(self, task_id: str, avatar_id: str) -> bool:
        """Назначить задачу аватару."""
        task = self._tasks.get(task_id)
        if not task:
            return False
        task.assigned_to = avatar_id
        task.update_status(TaskStatus.ASSIGNED)
        logger.info(f"TaskManager: task {task_id} assigned to {avatar_id}")
        return True

    def find_best_executor(self, task: Task,
                           available_avatars: Dict[str, List[str]]) -> Optional[str]:
        """
        Найти лучшего исполнителя по навыкам.
        available_avatars: {avatar_id: [skill1, skill2, ...]}
        """
        if not task.required_skills:
            # Любой подойдёт
            return next(iter(available_avatars), None)

        best_id = None
        best_score = 0
        for avatar_id, skills in available_avatars.items():
            skills_lower = [s.lower() for s in skills]
            score = 0
            for req in task.required_skills:
                req_l = req.lower()
                # точное совпадение или подстрока
                for s in skills_lower:
                    if req_l in s or s in req_l:
                        score += 1
                        break
            if score > best_score:
                best_score = score
                best_id = avatar_id

        return best_id

    # ── Жизненный цикл ───────────────────────────────────

    def start_task(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if not task or task.status not in (TaskStatus.ASSIGNED, TaskStatus.CREATED):
            return False
        task.update_status(TaskStatus.IN_PROGRESS)
        return True

    def propose_solution(self, task_id: str, method: str, description: str) -> bool:
        """Аватар предлагает метод решения задачи."""
        task = self._tasks.get(task_id)
        if not task:
            return False
        task.proposed_solutions.append({
            "method": method,
            "description": description,
            "proposed_at": datetime.now().isoformat(),
        })
        logger.info(f"TaskManager: solution proposed for task {task_id}: {method}")
        return True

    def submit_result(self, task_id: str, result: str) -> bool:
        """Аватар сдаёт результат на ревью."""
        task = self._tasks.get(task_id)
        if not task:
            return False
        task.result = result
        task.update_status(TaskStatus.REVIEW)
        logger.info(f"TaskManager: task {task_id} submitted for review")
        return True

    def approve_task(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if not task or task.status != TaskStatus.REVIEW:
            return False
        task.update_status(TaskStatus.APPROVED)
        task.update_status(TaskStatus.DONE)
        return True

    def reject_task(self, task_id: str, reason: str = "") -> bool:
        task = self._tasks.get(task_id)
        if not task or task.status != TaskStatus.REVIEW:
            return False
        task.rejection_reason = reason
        task.update_status(TaskStatus.REJECTED)
        return True

    # ── Статистика ────────────────────────────────────────

    def get_stats(self) -> Dict[str, Any]:
        statuses = {}
        for t in self._tasks.values():
            s = t.status.value
            statuses[s] = statuses.get(s, 0) + 1
        return {
            "total_tasks": len(self._tasks),
            "by_status": statuses,
        }
