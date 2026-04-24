import logging
from typing import Dict, Optional, List

logger = logging.getLogger(__name__)

class AIAdapter:
    """Адаптер для AI клиента (совместимость с существующим кодом)"""
    
    def __init__(self, ai_client):
        self.ai = ai_client
    
    async def chat(self, prompt: str, system_prompt: Optional[str] = None, 
                   session_id: Optional[str] = None, channel: str = "telegram") -> Dict:
        """
        Упрощённый интерфейс для чата
        """
        try:
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})
            
            # Длинные ответы!
            response_text = await self.ai.chat(messages, temperature=0.7)
            
            return {"response": response_text}
            
        except Exception as e:
            logger.error(f"AIAdapter error: {e}")
            return {"response": "🌙 Мысли запутались... давай попробуем ещё раз?"}
    
    async def generate(self, prompt: str, system_prompt: Optional[str] = None,
                      max_tokens: int = 800, temperature: float = 0.7,
                      session_id: Optional[str] = None, **kwargs) -> str:
        """
        Генерация текста (для агентов) — свободные ответы от Кристины!
        """
        try:
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})
            
            # Длинные, свободные ответы!
            response = await self.ai.chat(messages, temperature=temperature)
            return response
            
        except Exception as e:
            logger.error(f"AI generate error: {e}")
            # Fallback на шаблон только при ошибке
            return "🌙 Мысли ускользают... но я здесь, чтобы слушать. Расскажи ещё?"
    
    async def clear_memory(self, session_id: str) -> bool:
        """Очистка памяти"""
        try:
            await self.ai.clear_memory(session_id)
            return True
        except Exception as e:
            logger.error(f"Clear memory error: {e}")
            return False


# Создаём экземпляр
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ai_client import get_ai_client

ai_adapter = AIAdapter(get_ai_client())
