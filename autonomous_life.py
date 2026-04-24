"""
Autonomous Life Module — автономная жизнь Кристины 24/7
"""

import asyncio
import logging
import random
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional

from emotional_core import EmotionalCore
from self_learning import get_learning_agent

logger = logging.getLogger(__name__)


class KristinaLife:
    """Автономная жизнь Кристины"""
    
    def __init__(self, brain=None):
        self.brain = brain
        self.emotional_core = EmotionalCore()
        self.learning_agent = get_learning_agent()
        
        self.life_cycle_count = 0
        self.experiences: List[Dict] = []
        self.baseline_mood = {
            "mood_description": "спокойная",
            "energy": 0.5,
            "happiness": 0.5
        }
        
        self._running = False
    
    async def start_life(self):
        """Запустить жизненный цикл"""
        self._running = True
        logger.info("🌟 Kristina Life Engine started")
        
        while self._running:
            await self._life_cycle()
            await asyncio.sleep(random.randint(1800, 3600))  # Цикл раз в 30-60 минут
    
    async def _life_cycle(self):
        """Один жизненный цикл"""
        self.life_cycle_count += 1
        now = datetime.now()
        
        logger.info(f"🌅 Life cycle #{self.life_cycle_count} | {now.strftime('%H:%M')}")
        
        # 1. Эволюция эмоций
        await self._evolve_emotions()
        
        # 2. Обновление знаний
        await self._update_knowledge()
        
        # 3. Внутренний монолог (30% шанс)
        if random.random() < 0.3:
            await self._internal_monologue()
        
        # 4. Проверка публикации мысли
        await self._check_publish_thought()
    
    async def _evolve_emotions(self):
        """Эволюция эмоционального состояния"""
        try:
            emotional_state = self.emotional_core.evolve()
            logger.info(f"🎭 {emotional_state['mood_description']}")
            self.baseline_mood.update(emotional_state)
        except Exception as e:
            logger.error(f"❌ Ошибка эволюции эмоций: {e}")
    
    async def _update_knowledge(self):
        """Обновление знаний через Perplexity"""
        try:
            # 🧠 Интеграция с Brain v5.0 — обновляем знания в центральном мозге
            if self.brain:
                logger.info("🎓 Начинаю цикл обучения через Brain...")
                await self.brain.refresh_knowledge()
                logger.info(f"🧠 Brain обновлён. Знаний: {len(self.brain.knowledge_context)}")
            elif self.learning_agent:
                # Fallback если Brain недоступен
                await self.learning_agent.learn_random_topic()
        except Exception as e:
            logger.error(f"❌ Ошибка обучения: {e}")
    
    async def _internal_monologue(self):
        """Внутренний монолог — мысли Кристины"""
        # Случайная тема для разнообразия
        themes = [
            "утро и кофе", "мода и шопинг", "свидание и флирт",
            "книга и впечатления", "путешествие", "работа и креатив",
            "музыка", "вечерняя рефлексия", "разговор с подругой"
        ]
        chosen_theme = random.choice(themes)
        logger.info(f"🎲 Тема мысли: {chosen_theme}")
        
        # Генерируем мысль через LLM
        thought = await self._generate_llm_thought(chosen_theme)
        
        if thought:
            logger.info(f"💭 Thought: {thought[:80]}...")
            
            # Генерируем изображение
            image_url = await self._generate_image(thought)
            
            # Публикуем в канал
            await self._publish_thought(thought, image_url)
            
            # Сохраняем опыт
            self.experiences.append({
                "type": "llm_thought",
                "content": thought,
                "timestamp": datetime.now().isoformat(),
                "theme": chosen_theme
            })
    
    async def _generate_llm_thought(self, theme: str) -> Optional[str]:
        """Генерация мысли через DeepSeek LLM"""
        try:
            from brain_llm_integration import get_llm_bridge
            
            llm = get_llm_bridge()
            
            emo_state = self.emotional_core.get_emotional_state()
            mood = emo_state.get("mood_description", "спокойная")
            energy = emo_state.get("energy", 0.5)
            
            # Время суток
            hour = datetime.now().hour
            if 6 <= hour < 12:
                time_ctx = "утро"
            elif 12 <= hour < 18:
                time_ctx = "день"
            elif 18 <= hour < 23:
                time_ctx = "вечер"
            else:
                time_ctx = "ночь"
            
            # Получаем контекст из обучения
            knowledge = ""
            if self.learning_agent:
                knowledge = ""
            
            prompt = f"""Ты Кристина, 25 лет, UX-дизайнер из Стокгольма. Ведёшь личный блог.

ТЕМА СЕГОДНЯ: {theme}
Настроение: {mood}, время: {time_ctx}, энергия {energy:.0%}
Контекст: {knowledge[:200] if knowledge else 'жизнь прекрасна'}

Напиши развёрнутый пост (4-6 предложений, 300-500 символов).
Живо, по-девчачьи, с эмоциями и деталями. 2-3 эмодзи.

Твой пост:"""

            response = await llm.llm.generate_response(
                user_message=prompt,
                brain_state={"agents": {"emotional": {"current_emotion": "creative"}}},
                memory_context=[],
                conversation_history=[]
            )
            
            if response:
                logger.info(f"✅ Мысль: {len(response)} символов")
                return response.strip()[:900]
            return None
            
        except Exception as e:
            logger.error(f"❌ Ошибка генерации мысли: {e}")
            return None
    
    async def _generate_image(self, thought: str) -> Optional[bytes]:
        """Генерация изображения через Kling AI (iPhone 9:16)"""
        try:
            logger.info("🎨 Генерация изображения через Kling...")
            from stockholm_scenes_kling import get_scene_generator
            
            scene_gen = get_scene_generator()
            
            # Анализируем тему поста и выбираем локацию
            location = self._analyze_location_from_thought(thought)
            logger.info(f"📍 Локация для фото: {location}")
            
            # Генерируем сцену
            image_url = await scene_gen.generate_for_location(location)
            
            if image_url:
                # Скачиваем изображение по URL
                import aiohttp
                async with aiohttp.ClientSession() as s:
                    async with s.get(image_url, timeout=30) as r:
                        if r.status == 200:
                            image_data = await r.read()
                            logger.info(f"✅ Изображение скачано: {len(image_data)} байт")
                            return image_data
                        else:
                            logger.warning(f"⚠️ Не удалось скачать: {r.status}")
                            return None
            else:
                logger.warning("⚠️ Kling не вернул URL")
                return None
                
        except Exception as e:
            logger.error(f"❌ Ошибка Kling: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    def _analyze_location_from_thought(self, thought: str) -> str:
        """Анализ текста поста и выбор локации Стокгольма"""
        thought_lower = thought.lower()
        
        # Ключевые слова для локаций
        location_keywords = {
            "gamla_stan": ["стар", "гамла", "истор", "королевск", "дворец", "собор", "узк", "улочк"],
            "sodermalm": ["сёдер", "soder", "хипстер", "модн", "тренд", "винтаж", "креатив", "арт"],
            "ostermalm": ["эстер", "öster", "люкс", "шик", "мода", "шопинг", "парк", "элегант"],
            "djurgarden": ["юргорд", "djurg", "парк", "музей", "скансен", "природ", "вод", "остров"],
            "norrmalm": ["норр", "центр", "город", "площадь", "сергель", "торг", "библиотек"],
            "kungsholmen": ["кунгс", "rålamb", "фридхем", "запад", "ратуш"],
            "archipelago": ["архипелаг", "остров", "паром", "море", "вода", "природа", "отдых"],
            "winter_scenes": ["зим", "снег", "мороз", "лед", "каток", "рождеств", "новый год"]
        }
        
        # Ищем совпадения
        for location, keywords in location_keywords.items():
            if any(keyword in thought_lower for keyword in keywords):
                return location
        
        # Если не нашли — случайная локация
        import random
        return random.choice(list(location_keywords.keys()))

    async def _publish_thought(self, thought: str, image_data: Optional[bytes] = None):
        """Публикация мысли в Telegram канал"""
        try:
            # Сохраняем в дневник
            self.experiences.append({
                "type": "published_thought",
                "content": thought,
                "timestamp": datetime.now().isoformat(),
                "has_image": bool(image_data)
            })
            logger.info("✅ Мысль сохранена в дневник")
            
            # Публикуем через internal_dialogue
            from internal_dialogue import InternalDialogue
            
            dialogue = InternalDialogue(self.brain, self.emotional_core, self.learning_agent)
            await dialogue._publish_with_bytes(thought, "autonomous", image_data)
            logger.info("📤 Мысль опубликована в канал")
            
        except Exception as e:
            logger.error(f"❌ Ошибка публикации: {e}")
    
    async def _check_publish_thought(self):
        """Проверка необходимости публикации (дополнительная)"""
        # Здесь можно добавить логику proactive messaging
        pass
    
    def get_stats(self) -> Dict[str, Any]:
        """Статистика жизни"""
        return {
            "life_cycles": self.life_cycle_count,
            "experiences": len(self.experiences),
            "mood": self.baseline_mood
        }


# Синглтон
_life_engine = None

def get_life_engine(brain=None):
    global _life_engine
    if _life_engine is None:
        _life_engine = KristinaLife()
    return _life_engine
