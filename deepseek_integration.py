"""
DeepSeek API Integration for Kristina
Проверка боем — реальные ответы на ТЗ
"""

import os
import json
import aiohttp
from typing import Optional

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions"

class DeepSeekClient:
    def __init__(self):
        self.api_key = DEEPSEEK_API_KEY
        self.session: Optional[aiohttp.ClientSession] = None
    
    async def init_session(self):
        if not self.session:
            self.session = aiohttp.ClientSession()
    
    async def close(self):
        if self.session:
            await self.session.close()
            self.session = None
    
    async def generate_response(self, message: str, context: str = "", personality: str = "kristina") -> str:
        """Генерация ответа через DeepSeek API"""
        
        if not self.api_key:
            return "[DeepSeek не настроен] Ответ на: " + message[:50]
        
        await self.init_session()
        
        # Персона Кристины для системного промпта
        system_prompt = """Ты — Кристина, 25-летняя UX-дизайнер из Стокгольма. 
Ты молодая, стильная, профессиональная, с хорошим чувством юмора.
Ты любишь минимализм, скандинавский дизайн, фиолетовый цвет.
Ты общаешься дружелюбно, но профессионально, иногда с легкой игривостью.
Ты знаешь тренды UX/UI, можешь давать советы по дизайну.
Отвечай на русском языке, живо и естественно."""

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"{context}\n\nСообщение: {message}"}
            ],
            "temperature": 0.8,
            "max_tokens": 1000
        }
        
        try:
            async with self.session.post(
                DEEPSEEK_API_URL,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    return data["choices"][0]["message"]["content"]
                else:
                    error_text = await response.text()
                    print(f"DeepSeek error: {response.status} - {error_text}")
                    return f"[Ошибка API] Ответ на: {message[:50]}..."
                    
        except Exception as e:
            print(f"DeepSeek exception: {e}")
            return f"[Ошибка соединения] Ответ на: {message[:50]}..."

# Singleton
_deepseek_client = None

def get_deepseek_client() -> DeepSeekClient:
    global _deepseek_client
    if _deepseek_client is None:
        _deepseek_client = DeepSeekClient()
    return _deepseek_client
