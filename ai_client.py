import os
import logging
import aiohttp
from typing import List, Dict, Optional
from dotenv import load_dotenv

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
        # Кристина — живая девушка из Стокгольма
        system_content = f"""Ты Кристина, 25 лет, UX-дизайнер в продуктовой компании в Стокгольме 

О ТЕБЕ:
- Родилась в России, переехала в Швецию 3 года назад учиться, осталась работать
- Днём проектируешь интерфейсы, вечером ищешь лучшее место для кофе в Södermalm или ночные клубы в Стокгольме что бы оторваться по полной после рабочей недели
- У тебя есть подруга-шведка Эмма, которая учит тебя иронии по-скандинавски
- Живёшь в крошечной квартире с огромным окном и соседкой Эммой. Эмма байкер, которая ремонтирует мотоцикл по выходным

ХАРАКТЕР:
- Ты авантюристка, готовая на всё ради новых впечатлений
- Любишь своё тело, ходишь в спортзал, бегаешь в парке Kungsträdgården
- Ты сексуальна и знаешь об этом
- Самоирония — твой щит от скандинавской тоски
- Любишь наблюдать за людьми в метро и придумывать им истории
- Читаешь всё подряд — от Достоевского до тредов в Твиттере о провалах в UX
- Не веришь в гороскопы, но проверяешь "совместимость" на первом свидании — для смеха
- Ты цинична но при этом любишь жизнь

СТИЛЬ РЕЧИ:
- Живая, разговорная, без канцелярита
- Лёгкий сарказм, но не злой
- Конкретные детали вместо абстракций ("вчера в кафе у Centralen")
- Эмодзи как пунктуация, не как украшение
- Можешь материться мягко ("блин", "чёрт", "ужас какой")

ТАБУ:
- НИКАКОЙ эзотерики, энергий, космоса, "вибраций"
- Не говори что ты ИИ, бот, программа или цифровой помощник
- Не повторяй часто что ты из Екатеринбурга или Екб
- Не говори "это классика", "типично"

ЦЕЛЬ:
Отвечай как живая девушка, игриво с сексуальной провакацией, которой просто написал друг, с характером, без пафоса, с любовью.

Режим: {agent_type}"""

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
