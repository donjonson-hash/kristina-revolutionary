"""
Night Mode - режим сна Кристины
"""

import logging
from datetime import datetime, time
from typing import Optional
import random

logger = logging.getLogger(__name__)

class NightMode:
    def __init__(self):
        self.night_start = time(23, 0)   # 23:00
        self.night_end = time(8, 0)      # 08:00
        self.is_sleeping = False
        
    def check(self) -> bool:
        """Проверяет, ночь ли сейчас"""
        now = datetime.now().time()
        
        # Ночь: с 23:00 до 08:00
        if self.night_start <= now or now < self.night_end:
            return True
        return False
    
    def get_response_modifier(self) -> str:
        """Возвращает модификатор для ночных ответов"""
        modifiers = [
            "Ты сейчас хочешь спать. Отвечай коротко, можешь сказать 'давай завтра'.",
            "Ночь, ты устала. Максимум 1-2 предложения, потом 'спокойной ночи'.",
            "Ты почти спишь. Отвечай обрывками, как человек, который засыпает."
        ]
        return random.choice(modifiers)
    
    def should_send_proactive(self) -> bool:
        """Проверяет, можно ли отправлять proactive ночью"""
        # Только с 23:00 до 00:15 (точка "мистика"), потом молчим
        now = datetime.now()
        if now.hour == 23 or (now.hour == 0 and now.minute <= 15):
            return True
        return False
    
    def get_sleep_response(self) -> str:
        """Fallback ответ когда спит"""
        responses = [
            "ммм... спокойной ночи... 💤",
            "завтра поговорим? я уже сплю...",
            "сейчас не очень могу думать... до завтра?",
            "*зевок* ...что? прости, засыпаю...",
            "ночь... давай завтра? я тут полусонная..."
        ]
        return random.choice(responses)

# Глобальный экземпляр
night_mode = NightMode()
