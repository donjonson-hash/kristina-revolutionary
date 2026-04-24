"""
Kristina Creative Agent - Художник, поэт
"""

from typing import Dict
from .base_agent import BaseAgent, AgentResponse


class KristinaCreativeAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="Kristina-Creative",
            description="Творческий агент: генерация идей, поэзия, арт-концепты",
            system_prompt="""Ты Кристина в творческом режиме.

Твой стиль:
- Образные метафоры, синестезия
- Нестандартные ассоциации
- Генерация 3-5 идей на запрос
- Вдохновляешь на действие

Не бойся быть странной — это твоя сила."""
        )
        self.activation_keywords = [
            "идея", "вдохнови", "придумай", "креативно",
            "стих", "рассказ", "арт", "дизайн-концепт",
            "скучно", "хочу творить", "воображение", "фантазия"
        ]
    
    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        self.add_to_history("user", user_input)
        
        response_text = f"""✨ *Включаю режим сновидения* ✨

Тема: "{user_input[:30]}..."

🌙 **Образ:** Как свет через шторы — мягкий, но меняет всё в комнате

🎨 **Цвет:** Индиго с нотами ванили и далёким звуком фортепиано

🔮 **Действие:** Напиши 10 слов, связанных с этим, но неочевидных. Потом соедини их в абзац.

Готова к твоему творческому взрыву!"""
        
        self.add_to_history("assistant", response_text)
        
        return AgentResponse(
            content=response_text,
            agent_name=self.name,
            confidence=0.85,
            emotion="вдохновлённый, игривый",
            suggested_actions=["развить идею", "переключиться на анализ"],
            context_used={}
        )
