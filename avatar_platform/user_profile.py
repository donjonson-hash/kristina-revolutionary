"""
UserProfile — психоэмоциональный и поведенческий профиль пользователя.

Аватар моделирует владельца: стиль работы, реакции, предпочтения,
текущее эмоциональное состояние. Профиль обновляется по мере
взаимодействия.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from datetime import datetime
import json
import copy


@dataclass
class BehaviorPattern:
    """Поведенческий паттерн пользователя."""
    name: str                       # "утренняя продуктивность", "вечернее выгорание"
    trigger: str                    # когда срабатывает ("08:00-12:00", "deadline < 1d")
    effect: Dict[str, float] = field(default_factory=dict)  # модификаторы к эмоциям


@dataclass
class UserProfile:
    """Полный профиль пользователя для его ИИ-аватара."""

    # --- идентификация ---
    user_id: str
    name: str
    role_id: str                    # ссылка на ProfessionProfile.role_id

    # --- Big Five (психотип) ---
    personality: Dict[str, float] = field(default_factory=lambda: {
        "openness": 0.5,            # открытость опыту
        "conscientiousness": 0.5,   # добросовестность
        "extraversion": 0.5,        # экстраверсия
        "agreeableness": 0.5,       # доброжелательность
        "neuroticism": 0.5,         # невротизм
    })

    # --- текущее эмоциональное состояние ---
    emotional_state: Dict[str, float] = field(default_factory=lambda: {
        "energy": 0.7,
        "stress": 0.3,
        "focus": 0.6,
        "motivation": 0.7,
        "satisfaction": 0.6,
    })

    # --- рабочие предпочтения ---
    work_preferences: Dict[str, str] = field(default_factory=lambda: {
        "communication_style": "прямой",           # "прямой", "мягкий", "формальный"
        "response_length": "средний",              # "короткий", "средний", "подробный"
        "proactive_suggestions": "да",             # аватар предлагает идеи сам
        "delegation_comfort": "высокий",           # насколько доверяет аватару
    })

    # --- поведенческие паттерны ---
    behavior_patterns: List[BehaviorPattern] = field(default_factory=list)

    # --- история взаимодействий (метрики) ---
    interaction_stats: Dict[str, int] = field(default_factory=lambda: {
        "total_tasks_delegated": 0,
        "tasks_approved": 0,
        "tasks_rejected": 0,
        "messages_sent": 0,
    })

    # --- meta ---
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    last_active: str = field(default_factory=lambda: datetime.now().isoformat())

    # ──────────────────────────────────────────────────────
    #  Методы
    # ──────────────────────────────────────────────────────

    def update_emotion(self, key: str, delta: float) -> None:
        """Обновить эмоциональное состояние (ограничение 0.0 - 1.0)."""
        if key in self.emotional_state:
            self.emotional_state[key] = max(0.0, min(1.0, self.emotional_state[key] + delta))

    def apply_patterns(self, hour: int) -> Dict[str, float]:
        """Применить поведенческие паттерны на текущий час. Возвращает модификаторы."""
        mods: Dict[str, float] = {}
        for pat in self.behavior_patterns:
            # простой формат триггера: "HH-HH"
            if "-" in pat.trigger:
                parts = pat.trigger.split("-")
                try:
                    h_start, h_end = int(parts[0]), int(parts[1])
                    if h_start <= hour < h_end:
                        for k, v in pat.effect.items():
                            mods[k] = mods.get(k, 0.0) + v
                except ValueError:
                    pass
        # Применяем модификаторы
        for k, v in mods.items():
            self.update_emotion(k, v)
        return mods

    def get_delegation_level(self) -> float:
        """Насколько аватар может действовать автономно (0.0 - 1.0)."""
        comfort = self.work_preferences.get("delegation_comfort", "средний")
        levels = {"низкий": 0.3, "средний": 0.6, "высокий": 0.9}
        base = levels.get(comfort, 0.6)
        # Корректируем по доверию: чем больше задач одобрено — тем выше
        approved = self.interaction_stats.get("tasks_approved", 0)
        rejected = self.interaction_stats.get("tasks_rejected", 0)
        total = approved + rejected
        if total > 0:
            trust_bonus = (approved / total) * 0.1  # max +0.1
            base = min(1.0, base + trust_bonus)
        return round(base, 2)

    def get_emotional_summary(self) -> str:
        """Текстовое описание состояния для промпта."""
        e = self.emotional_state
        parts = []
        if e.get("energy", 0.5) > 0.7:
            parts.append("энергичен")
        elif e.get("energy", 0.5) < 0.4:
            parts.append("устал")
        if e.get("stress", 0.3) > 0.7:
            parts.append("под давлением")
        if e.get("focus", 0.5) > 0.7:
            parts.append("сфокусирован")
        if e.get("motivation", 0.5) < 0.4:
            parts.append("демотивирован")
        return ", ".join(parts) if parts else "нормальное состояние"

    def build_avatar_context(self) -> str:
        """Контекст пользователя для LLM-промпта аватара."""
        return (
            f"Владелец: {self.name}\n"
            f"Состояние: {self.get_emotional_summary()}\n"
            f"Стиль общения: {self.work_preferences.get('communication_style', 'прямой')}\n"
            f"Длина ответов: {self.work_preferences.get('response_length', 'средний')}\n"
            f"Уровень автономии: {self.get_delegation_level()}\n"
        )

    def record_task_result(self, approved: bool) -> None:
        """Записать результат делегированной задачи."""
        self.interaction_stats["total_tasks_delegated"] += 1
        if approved:
            self.interaction_stats["tasks_approved"] += 1
        else:
            self.interaction_stats["tasks_rejected"] += 1
        self.last_active = datetime.now().isoformat()

    def to_dict(self) -> Dict:
        """Сериализация в dict."""
        d = {
            "user_id": self.user_id,
            "name": self.name,
            "role_id": self.role_id,
            "personality": copy.deepcopy(self.personality),
            "emotional_state": copy.deepcopy(self.emotional_state),
            "work_preferences": copy.deepcopy(self.work_preferences),
            "behavior_patterns": [
                {"name": p.name, "trigger": p.trigger, "effect": p.effect}
                for p in self.behavior_patterns
            ],
            "interaction_stats": copy.deepcopy(self.interaction_stats),
            "created_at": self.created_at,
            "last_active": self.last_active,
        }
        return d

    @classmethod
    def from_dict(cls, data: Dict) -> "UserProfile":
        """Десериализация из dict."""
        patterns = [
            BehaviorPattern(**p)
            for p in data.get("behavior_patterns", [])
        ]
        return cls(
            user_id=data["user_id"],
            name=data["name"],
            role_id=data["role_id"],
            personality=data.get("personality", {}),
            emotional_state=data.get("emotional_state", {}),
            work_preferences=data.get("work_preferences", {}),
            behavior_patterns=patterns,
            interaction_stats=data.get("interaction_stats", {}),
            created_at=data.get("created_at", datetime.now().isoformat()),
            last_active=data.get("last_active", datetime.now().isoformat()),
        )
