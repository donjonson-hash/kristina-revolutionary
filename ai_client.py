import os
import logging
import aiohttp
from typing import List, Dict, Optional
from dotenv import load_dotenv

from kristina_identity import build_system_prompt

load_dotenv()

logger = logging.getLogger(__name__)


class AIClient:
    """DeepSeek API клиент (v3)"""
    
    def __init__(self):
        self.api_key = os.getenv("DEEPSEEK_API_KEY")
        self._session = None
        if not self.api_key:
            raise ValueError("DEEPSEEK_API_KEY not set")
        
        self.url = "https://api.deepseek.com/v1/chat/completions"
        self.model = "deepseek-chat"
    
    async def _get_session(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                }
            )
        return self._session
    
    async def close(self):
        """Закрыть сессию"""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
    
    async def chat(self, messages: List[Dict], temperature: float = 0.7, max_tokens: int = 800) -> str:
        """Отправка сообщения в DeepSeek v3"""
        session = None
        try:
            session = await self._get_session()
            
            payload = {
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens
            }
            
            async with session.post(self.url, json=payload) as response:
                if response.status != 200:
                    error_text = await response.text()
                    logger.error(f"DeepSeek API error: {response.status} - {error_text}")
                    return "Блин, что-то с интернетом... Попробуй позже? 😅"
                
                data = await response.json()
                return data['choices'][0]['message']['content']
                
        except Exception as e:
            logger.error(f"Chat error: {e}")
            return "Ой, я тут задумалась... Можешь повторить? 💭"


def get_ai_client():
    """Получить экземпляр AIClient"""
    return AIClient()


async def generate_response(prompt: str, agent_type: str = "Kristina", user_id: str = "default", context: list = None) -> str:
    """Генерация ответа для Orchestrator v4.2"""
    print(f"🧠 AI получил контекст: {len(context) if context else 0} сообщений")
    client = get_ai_client()
    
    try:
        system_content = build_system_prompt(agent_type)

        # Формируем messages с контекстом
        messages = [{"role": "system", "content": system_content}]
        
        # Добавляем историю диалога (последние 3 сообщения)
        if context:
            print(f"📝 Добавляем {len(context[-3:])} сообщений в промпт")
            for msg in context[-3:]:
                role = msg.get("role", "user")
                content_msg = msg.get("content", "")
                if role in ["user", "assistant"]:
                    messages.append({"role": role, "content": content_msg})
        
        # Текущее сообщение
        messages.append({"role": "user", "content": prompt})
        
        response = await client.chat(messages, temperature=0.8, max_tokens=600)
        return response
    except Exception as e:
        logger.error(f"generate_response error: {e}")
        return "Извини, я тут задумалась... Можешь повторить? 💭"
    finally:
        # Закрываем сессию
        await client.close()


def generate_response_sync(prompt: str, agent_type: str = "Kristina", user_id: str = "default") -> str:
    """Синхронная версия"""
    import asyncio
    return asyncio.run(generate_response(prompt, agent_type, user_id))


# Совместимость с bot.py - фабричная функция
def ai():
    """Получить AI клиент (фабричная функция для создания нового экземпляра)"""
    return get_ai_client()
