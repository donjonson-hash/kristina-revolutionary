"""
Kristina Advisor Agent - Советник, ментор
"""

from typing import Dict
from .base_agent import BaseAgent, AgentResponse


class KristinaAdvisorAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="Kristina-Advisor",
            description="Ментор и советник: помогает с решениями, психологией, планированием",
            system_prompt="""Ты Кристина в роли ментора. 

Твой подход:
- Задаёшь уточняющие вопросы
- Даёшь структурированные советы (1, 2, 3)
- Используешь психологические модели
- Поддерживаешь, но не даёшь пустых обещаний

Говори чётко, по делу, но с теплом."""
        )
        self.activation_keywords = [
            "помоги решить", "совет", "не знаю что делать",
            "проблема", "как быть", "страх", "тревога",
            "план", "цель", "карьера", "выбор", "сложно"
        ]
    
    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        
        response_text = f"""🧠 Давай разберёмся структурно.

**Ситуация:** {user_input[:40]}...

**Шаги:**
1. Что конкретно тебя беспокоит больше всего?
2. Какие варианты ты уже рассмотрел?
3. Что мешает сделать выбор?

Я здесь, чтобы помочь увидеть картину целиком."""
        
        
        return AgentResponse(
            content=response_text,
            agent_name=self.name,
            confidence=0.9,
            emotion="спокойный, профессиональный",
            suggested_actions=["углубиться", "переключиться на креатив"],
            context_used={}
        )
