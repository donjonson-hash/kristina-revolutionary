"""
Self-Learning Module — система самообучения Кристины через Perplexity API
"""

import asyncio
import logging
import json
import os
import sqlite3
from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timedelta
from typing import Optional, Dict, List
import aiohttp

logger = logging.getLogger(__name__)


class PerplexityAPI:
    """Клиент для Perplexity API"""
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("PERPLEXITY_API_KEY")
        self.base_url = "https://api.perplexity.ai"
        
        if not self.api_key:
            logger.warning("⚠️ PERPLEXITY_API_KEY не задан!")
    
    async def query(self, question: str, max_tokens: int = 500) -> Dict:
        """Запрос к Perplexity API"""
        if not self.api_key:
            return {"error": "No API key", "content": ""}
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        data = {
            "model": "sonar",
            "messages": [
                {
                    "role": "system",
                    "content": "Ты помощник, который даёт краткую полезную информацию."
                },
                {
                    "role": "user",
                    "content": question
                }
            ],
            "max_tokens": max_tokens,
            "temperature": 0.7
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json=data,
                    timeout=30
                ) as response:
                    
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error(f"❌ Perplexity API error: {response.status}")
                        return {"error": error_text, "content": ""}
                    
                    result = await response.json()
                    content = result["choices"][0]["message"]["content"]
                    
                    return {
                        "content": content,
                        "timestamp": datetime.now().isoformat(),
                        "query": question
                    }
                    
        except Exception as e:
            logger.error(f"❌ Perplexity request failed: {e}")
            return {"error": str(e), "content": ""}
    
    def _parse_response(self, data: Dict) -> Dict:
        """Парсинг ответа Perplexity"""
        return {
            "content": data.get("content", ""),
            "timestamp": data.get("timestamp", datetime.now().isoformat()),
            "sources": data.get("citations", [])
        }


class SelfLearningAgent:
    """Агент самообучения Кристины"""
    
    def __init__(self, db_path: str = "kristina_knowledge.db"):
        self.db_path = db_path
        self.perplexity = PerplexityAPI()
        self.knowledge_cache: Dict[str, str] = {}
        self.last_learning: Optional[datetime] = None
        
        # Инициализация БД
        self._init_db()
        self._load_cache()
    
    def _init_db(self):
        """Инициализация базы знаний"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS knowledge (
                        topic TEXT PRIMARY KEY,
                        content TEXT,
                        learned_at TIMESTAMP,
                        source TEXT
                    )
                """)
                conn.commit()
        except Exception as e:
            logger.error(f"❌ DB init error: {e}")
    
    def _load_cache(self):
        """Загрузка кэша из БД"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.execute(
                    "SELECT topic, content FROM knowledge ORDER BY learned_at DESC LIMIT 20"
                )
                for row in cursor:
                    self.knowledge_cache[row[0]] = row[1]
            logger.info(f"📚 Загружено {len(self.knowledge_cache)} тем из БД")
        except Exception as e:
            logger.error(f"❌ Cache load error: {e}")
    
    async def learn_topic(self, topic_key: str, custom_query: Optional[str] = None) -> Dict:
        """Изучить конкретную тему"""
        queries = {
            "stockholm_weather": "Какая погода в Стокгольме сегодня и на неделю вперед?",
            "stockholm_events": "Что интересного происходит в Стокгольме сейчас? События, выставки, концерты",
            "ux_trends": "Новейшие тренды UX/UI дизайна 2024-2025, что в моде",
            "sweden_culture": "Шведская культура, традиции, менталитет — что нового",
            "scandinavian_design": "Скандинавский дизайн, интерьеры, минимализм — последние тенденции",
            "ai_technology": "Новости AI технологий, что изменилось недавно",
            "sustainable_fashion": "Устойчивая мода, экологичная одежда — тренды",
            "nordic_cuisine": "Скандинавская кухня, рестораны Стокгольма, новые тенденции",
            "stockholm_nightlife": "Ночная жизнь Стокгольма, бары, клубы, события",
            "swedish_history": "Интересные факты о шведской истории, культура",
            "modern_architecture": "Современная архитектура Стокгольма, новые здания",
            "digital_art": "Цифровое искусство, NFT, AI-арт — тренды",
            "wellness_trends": "Велнес тренды, здоровый образ жизни, mindfulness",
            "swedish_nature": "Природа Швеции, национальные парки, заповедники",
            "stockholm_food": "Еда в Стокгольме, рестораны, кафе, шведская кухня"
        }
        
        query = custom_query or queries.get(topic_key, f"Расскажи о {topic_key}")
        
        logger.info(f"📖 Изучаю тему: {topic_key}")
        
        # Получаем знания
        result = await self.perplexity.query(query)
        
        if "error" not in result and result.get("content"):
            # Сохраняем в БД
            await self._save_to_db(topic_key, result)
            # Обновляем кэш
            self.knowledge_cache[topic_key] = result["content"]
            logger.info(f"✅ Тема '{topic_key}' изучена ({len(result['content'])} символов)")
        else:
            logger.error(f"❌ Не удалось изучить '{topic_key}'")
        
        return result
    
    async def _save_to_db(self, topic: str, data: Dict):
        """Сохранить знания в БД"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO knowledge (topic, content, learned_at, source)
                    VALUES (?, ?, ?, ?)
                """, (
                    topic,
                    data.get("content", ""),
                    datetime.now().isoformat(),
                    "perplexity"
                ))
                conn.commit()
        except Exception as e:
            logger.error(f"❌ DB save error: {e}")
    
    async def learn_random_topic(self) -> Dict:
        """Изучить случайную тему для самообучения"""
        import random
        
        topics = [
            "stockholm_events", "sweden_culture", "scandinavian_design",
            "ux_trends", "ai_technology", "sustainable_fashion",
            "nordic_cuisine", "stockholm_nightlife", "swedish_history",
            "modern_architecture", "digital_art", "wellness_trends",
            "swedish_nature", "stockholm_food", "nordic_lifestyle"
        ]
        
        topic = random.choice(topics)
        logger.info(f"🎲 Случайная тема для изучения: {topic}")
        
        return await self.learn_topic(topic)
    
    async def daily_learning_routine(self):
        """Ежедневная рутина обучения"""
        logger.info("🌅 Начинаю дневное обучение...")
        
        # Утренние новости
        await self.learn_topic("stockholm_events")
        
        # Профессиональное развитие
        await self.learn_topic("ux_trends")
        
        # Культурное просвещение
        await self.learn_topic("sweden_culture")
        
        logger.info("✅ Дневное обучение завершено")
    
    def get_context_for_thought(self) -> str:
        """Получить контекст для генерации мыслей"""
        if not self.knowledge_cache:
            return ""
        
        # Берём случайную тему из кэша
        import random
        topic = random.choice(list(self.knowledge_cache.keys()))
        content = self.knowledge_cache[topic][:150]
        return f"{topic}: {content}"
    
    def get_recent_knowledge(self, limit: int = 3) -> List[Dict]:
        """Получить недавние знания"""
        result = []
        topics = list(self.knowledge_cache.keys())[:limit]
        
        for topic in topics:
            result.append({
                "topic": topic,
                "preview": self.knowledge_cache[topic][:100]
            })
        
        return result


# Синглтон
_learning_agent = None

def get_learning_agent() -> SelfLearningAgent:
    global _learning_agent
    if _learning_agent is None:
        _learning_agent = SelfLearningAgent()
    return _learning_agent


# Тест
if __name__ == "__main__":
    async def test():
        agent = get_learning_agent()
        print("✅ Self-Learning Agent создан")
        
        # Тест 1: Случайная тема
        print("\n=== Тест: Случайная тема ===")
        result = await agent.learn_random_topic()
        print(result.get("content", "Error")[:300])
        
    asyncio.run(test())
