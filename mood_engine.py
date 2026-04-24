"""
Mood Engine v0.1 - простая система настроений Кристины
"""

import random
from datetime import datetime, timedelta
from broadcast import event_bus, Events
from enum import Enum
from typing import Dict, Optional

class MoodState(Enum):
    CALM = "спокойная"      # Утро, мало активности
    CURIOUS = "любопытная"  # Активный диалог
    TIRED = "усталая"       # Много сообщений, вечер

class MoodEngine:
    def __init__(self):
        self.current_mood = MoodState.CALM
        self.last_change = datetime.now()
        self.message_count = 0
        self.last_message_time = datetime.now()
        self.energy_level = 1.0  # 0.0 - 1.0
        
    def update(self, user_message: bool = True) -> MoodState:
        """Обновляет настроение на основе активности"""
        now = datetime.now()
        hour = now.hour
        
        # Сброс счётчика если прошло > 30 мин
        if now - self.last_message_time > timedelta(minutes=30):
            self.message_count = 0
            self.energy_level = min(1.0, self.energy_level + 0.3)
        
        if user_message:
            self.message_count += 1
            self.last_message_time = now
        
        # Логика переключения
        new_mood = self._calculate_mood(hour)
        
        if new_mood != self.current_mood:
            self.current_mood = new_mood
            self.last_change = now
            print(f"🎭 Mood changed: {self.current_mood.value}")
            event_bus.publish(Events.MOOD_CHANGED, {
                "old_mood": self.current_mood.value,
                "new_mood": new_mood.value,
                "energy": self.energy_level,
                "message_count": self.message_count
            })
        
        return self.current_mood
    
    def _calculate_mood(self, hour: int) -> MoodState:
        """Вычисляет настроение по времени и активности"""
        
        # Ночь (23-08) — всегда спокойная/усталая
        if hour >= 23 or hour < 8:
            return MoodState.CALM if self.energy_level > 0.5 else MoodState.TIRED
        
        # Много сообщений подряд — усталость
        if self.message_count > 5:
            self.energy_level = max(0.2, self.energy_level - 0.1)
            if self.energy_level < 0.4:
                return MoodState.TIRED
        
        # Активный диалог — любопытство
        if self.message_count > 0 and self.energy_level > 0.6:
            return MoodState.CURIOUS
        
        # По умолчанию — спокойная
        return MoodState.CALM
    
    def get_mood_prompt(self) -> str:
        """Возвращает модификатор промпта для текущего настроения"""
        prompts = {
            MoodState.CALM: "Ты сейчас спокойная, размеренная. Отвечай тепло, без спешки, можешь паузу сделать перед ответом.",
            MoodState.CURIOUS: "Ты сейчас любопытная, энергичная. Задай встречный вопрос, прояви интерес, можешь немного поддразнить.",
            MoodState.TIRED: "Ты сейчас немного устала. Отвечай короче, можешь сказать 'давай продолжим завтра' или 'сейчас не очень могу думать'."
        }
        return prompts.get(self.current_mood, prompts[MoodState.CALM])
    
    def get_delay(self) -> int:
        """Возвращает задержку ответа в зависимости от настроения"""
        delays = {
            MoodState.CALM: (30, 60),      # Медленнее
            MoodState.CURIOUS: (15, 30),   # Быстрее
            MoodState.TIRED: (45, 90)      # Медленно или не отвечает долго
        }
        return random.randint(*delays.get(self.current_mood, (20, 60)))
    
    def get_status(self) -> Dict:
        """Возвращает статус для отладки"""
        return {
            "mood": self.current_mood.value,
            "energy": round(self.energy_level, 2),
            "messages_count": self.message_count,
            "last_change": self.last_change.strftime("%H:%M")
        }

# Глобальный экземпляр
mood_engine = MoodEngine()
