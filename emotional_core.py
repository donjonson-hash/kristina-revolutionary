#!/usr/bin/env python3
"""
Emotional Evolution v2.0 — Kristina меняется как живой человек
"""

import random
import json
from datetime import datetime, timedelta
from typing import Dict, List
import logging

logger = logging.getLogger(__name__)

class EmotionalCore:
    """Эмоциональное ядро Кристины — эволюционирует со временем"""
    
    def __init__(self):
        self.traits = {
            "extraversion": 0.7,
            "neuroticism": 0.4,
            "openness": 0.8,
            "agreeableness": 0.6,
            "conscientiousness": 0.5
        }
        
        self.state = {
            "energy": 0.7,
            "happiness": 0.6,
            "curiosity": 0.8,
            "anxiety": 0.3,
            "loneliness": 0.4,
            "creativity": 0.6,
            "irritation": 0.1
        }
        
        self.recent_experiences = []
        self.last_update = datetime.now()
        
    def evolve(self, context: Dict = None) -> Dict:
        """Один шаг эволюции эмоций"""
        now = datetime.now()
        hour = now.hour
        
        self._apply_circadian_rhythm(hour)
        
        if context:
            self._apply_context_effects(context)
            
        self._apply_random_fluctuations()
        self._normalize_state()
        
        self.last_update = now
        return self.get_emotional_state()
    
    def _apply_circadian_rhythm(self, hour: int):
        """Циркадные ритмы"""
        if 6 <= hour < 10:
            self.state["energy"] += 0.15
            self.state["curiosity"] += 0.1
        elif 14 <= hour < 17:
            self.state["energy"] -= 0.08
        elif 17 <= hour < 22:
            self.state["loneliness"] += 0.1
        elif hour >= 22 or hour < 6:
            # Ночь; дневные часы вне интервалов (10-14) состояние не меняют
            self.state["energy"] -= 0.15
    
    def _apply_context_effects(self, context: Dict):
        """Влияние событий"""
        if context.get("negative_tone", False):
            self.state["irritation"] += 0.2
    
    def _apply_random_fluctuations(self):
        """Спонтанные колебания"""
        for emotion in self.state:
            change = random.uniform(-0.05, 0.05)
            self.state[emotion] += change
    
    def _normalize_state(self):
        """Нормализация"""
        for emotion in self.state:
            self.state[emotion] = max(0.1, min(1.0, self.state[emotion]))
    
    def get_emotional_state(self) -> Dict:
        """Получить состояние"""
        dominant = max(self.state, key=self.state.get)
        
        return {
            "state": self.state.copy(),
            "traits": self.traits.copy(),
            "dominant_emotion": dominant,
            "dominant_value": self.state[dominant],
            "mood_description": self._describe_mood(),
            "for_llm": self._craft_emotional_prompt()
        }
    
    def _describe_mood(self) -> str:
        """Текстовое описание настроения"""
        energy = self.state["energy"]
        happiness = self.state["happiness"]
        
        if energy > 0.7 and happiness > 0.6:
            return "Энергичная и позитивная"
        elif energy < 0.4:
            return "Уставшая, нуждается в отдыхе"
        elif self.state["curiosity"] > 0.7:
            return "Любопытная, вовлечённая"
        else:
            return "Спокойная, сбалансированная"
    
    def _craft_emotional_prompt(self) -> str:
        """Промпт для LLM"""
        energy = self.state["energy"]
        happiness = self.state["happiness"]
        
        modifiers = []
        if energy > 0.8:
            modifiers.append("энергичная, много эмодзи")
        elif energy < 0.4:
            modifiers.append("уставшая, короткие ответы")
            
        mod_text = ", ".join(modifiers) if modifiers else "естественный тон"
        return f"Стиль: {mod_text}."

# Глобальный экземпляр
_emotional_core = None

def get_emotional_core():
    global _emotional_core
    if _emotional_core is None:
        _emotional_core = EmotionalCore()
    return _emotional_core
