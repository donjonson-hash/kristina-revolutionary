"""
Brain Core — базовые классы нейро-архитектуры Кристины
"""

import asyncio
import random
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, auto
from typing import Dict, List, Any, Optional, Callable, Set

logger = logging.getLogger(__name__)


class BrainRegion(Enum):
    FREELANCE = "freelance"  # 💼 Фриланс-регион
    """Анатомические регионы мозга"""
    CORTEX = "cortex"           # Префронтальная кора — CEO
    VISUAL = "visual"           # Затылочная кора — зрение
    AUDITORY = "auditory"       # Височная кора — слух/речь
    MOTOR = "motor"             # Лобная доля — действия
    EMOTIONAL = "emotional"     # Лимбическая система — эмоции
    MEMORY = "memory"           # Гиппокамп — память
    LANGUAGE = "language"       # Брока/Вернике — язык
    THALAMUS = "thalamus"       # Таламус — маршрутизатор


class NeuroTransmitter(Enum):
    """Нейромедиаторы"""
    DOPAMINE = "dopamine"       # Награда, мотивация
    SEROTONIN = "serotonin"     # Настроение
    ADRENALINE = "adrenaline"   # Возбуждение
    ACETYLCHOLINE = "acetylcholine"  # Память
    GABA = "gaba"               # Торможение
    GLUTAMATE = "glutamate"     # Возбуждение
    OXYTOCIN = "oxytocin"       # Привязанность


@dataclass
class NeuralSignal:
    """Сигнал между нейронами (синапс)"""
    source: BrainRegion
    target: BrainRegion
    data: Any
    intensity: float = 0.5
    neurotransmitter: str = "glutamate"
    timestamp: datetime = field(default_factory=datetime.now)
    trace_id: str = field(default_factory=lambda: f"tr{random.randint(1000,9999)}")
    
    def __post_init__(self):
        self.intensity = max(0.0, min(1.0, self.intensity))


class SynapticPlasticity:
    """LTP/LTD — пластичность синапсов"""
    
    def __init__(self):
        self.weights: Dict[tuple, float] = {}  # (pre, post) -> weight
        self.learning_rate = 0.1
    
    def get_weight(self, pre: BrainRegion, post: BrainRegion) -> float:
        return self.weights.get((pre, post), 0.5)
    
    def strengthen(self, pre: BrainRegion, post: BrainRegion, amount: float = 0.1):
        """LTP — долговременная потенциация"""
        key = (pre, post)
        self.weights[key] = min(1.0, self.weights.get(key, 0.5) + amount)
    
    def weaken(self, pre: BrainRegion, post: BrainRegion, amount: float = 0.05):
        """LTD — депрессия синапса"""
        key = (pre, post)
        self.weights[key] = max(0.1, self.weights.get(key, 0.5) - amount)


class BaseBrainAgent:
    """Базовый класс для всех агентов мозга"""
    
    def __init__(self, region: BrainRegion):
        self.region = region
        self.active = False
        self.activation_level = 0.0
        self.receptors: Dict[BrainRegion, float] = {}
        self.plasticity = SynapticPlasticity()
        self.processing_history: List[NeuralSignal] = []
        self.last_activation = datetime.now()
        
    async def process(self, signal: NeuralSignal) -> Optional[NeuralSignal]:
        """Обработка входящего сигнала — override в подклассах"""
        raise NotImplementedError(f"Agent {self.region} must implement process()")
    
    def activate(self, level: float = 1.0):
        """Возбуждение нейронов"""
        self.active = True
        self.activation_level = min(1.0, self.activation_level + level)
        self.last_activation = datetime.now()
        logger.debug(f"[{self.region.value.upper()}] α={self.activation_level:.2f}")
    
    def inhibit(self, level: float = 0.3):
        """Торможение (GABA-эргический эффект)"""
        self.activation_level = max(0.0, self.activation_level - level)
        if self.activation_level < 0.1:
            self.active = False
    
    def modulate(self, nt: str, amount: float):
        """Нейромодуляция"""
        if nt == "dopamine":
            self.activation_level = min(1.0, self.activation_level + amount * 0.5)
        elif nt == "serotonin":
            self.inhibit(amount * 0.3)
        elif nt == "adrenaline":
            self.activate(amount)
    
    def can_process(self, signal: NeuralSignal) -> bool:
        """Проверка порога обработки"""
        threshold = self.receptors.get(signal.source, 0.3)
        return signal.intensity >= threshold and self.active
    
    def get_state(self) -> Dict:
        """Состояние агента"""
        return {
            "region": self.region.value,
            "active": self.active,
            "activation": self.activation_level,
            "receptors": {k.value: v for k, v in self.receptors.items()}
        }

def get_brain_region(region_str: str) -> BrainRegion:
    """Получить BrainRegion из строки"""
    try:
        return BrainRegion(region_str.lower())
    except ValueError:
        return BrainRegion.CORTEX  # default
