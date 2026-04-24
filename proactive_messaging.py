"""
Proactive Messaging v2.0 — с генерацией через DeepSeek
"""

import random
import asyncio
from datetime import datetime
from typing import Dict, Optional, List
import logging

logger = logging.getLogger(__name__)

# DNA Modes — 12 эмоциональных паттернов
SCHEDULE = {
    "09:15": {"mood": "пробуждение", "energy": 30, "archetype": "утренняя свежесть"},
    "10:45": {"mood": "любопытство", "energy": 70, "archetype": "исследователь"},
    "12:20": {"mood": "энергия", "energy": 90, "archetype": "творец"},
    "13:50": {"mood": "работа", "energy": 80, "archetype": "профессионал"},
    "15:25": {"mood": "мечтательность", "energy": 60, "archetype": "мечтатель"},
    "16:30": {"mood": "ностальгия", "energy": 50, "archetype": "хранитель памяти"},
    "18:45": {"mood": "размышление", "energy": 40, "archetype": "философ"},
    "19:50": {"mood": "интимность", "energy": 50, "archetype": "близкий друг"},
    "20:30": {"mood": "спокойствие", "energy": 30, "archetype": "наставник"},
    "21:50": {"mood": "меланхолия", "energy": 20, "archetype": "поэт"},
    "23:00": {"mood": "сон", "energy": 10, "archetype": "хранитель снов"},
    "00:15": {"mood": "мистика", "energy": 15, "archetype": "провидец"},
}

class ProactiveMessagingManager:
    """Управление proactive сообщениями с AI-генерацией"""
    
    def __init__(self, ai_client=None):
        self.ai = ai_client
        self._ai_client_created = False
        if self.ai is None:
            from ai_client import get_ai_client
            self.ai = get_ai_client()
            self._ai_client_created = True
        self.active_chats = set()
        self.last_proactive = {}
        
    def add_chat(self, chat_id: int):
        """Добавить чат в список активных"""
        self.active_chats.add(chat_id)
        logger.info(f"✅ Chat added: {chat_id}, total: {len(self.active_chats)}")
        
    def get_current_state(self) -> Optional[Dict]:
        """Получить текущее состояние из расписания"""
        now = datetime.now()
        current_time = now.strftime("%H:%M")
        
        # Ищем ближайшую точку
        schedule_times = sorted(SCHEDULE.keys())
        
        # Находим активную точку (с точностью ±5 минут)
        for time_str in schedule_times:
            hour, minute = map(int, time_str.split(':'))
            schedule_dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            diff = abs((now - schedule_dt).total_seconds() / 60)
            
            if diff <= 5:  # ±5 минут
                state = SCHEDULE[time_str].copy()
                state['time'] = time_str
                return state
        
        return None
    
    async def generate_message(self, state: Dict) -> str:
        """Сгенерировать сообщение через AI или fallback"""
        if self.ai:
            try:
                return await self._generate_ai_message(state)
            except Exception as e:
                logger.error(f"AI generation failed: {e}, using fallback")
        
        return self._generate_fallback_message(state['mood'])
    
    async def _generate_ai_message(self, state: Dict) -> str:
        """Генерация через DeepSeek"""
        mood = state['mood']
        energy = state['energy']
        archetype = state.get('archetype', 'друг')
        
        prompt = f"""Ты Кристина, 25-летний UX-дизайнер из Стокгольма. 
Твое текущее настроение: {mood} (энергия: {energy}%).
Твоя роль сейчас: {archetype}.

Напиши ОДНО короткое сообщение (1-2 предложения) для Telegram.
Сообщение должно быть:
- Личным, теплым
- Соответствовать настроению "{mood}"
- Неформальным, как подруга
- Без эмодзи в начале (они добавятся позже)

Примеры для настроения "интимность":
- "Привет... Хочется просто поговорить по-настоящему. Как ты?"
- "Иногда мне кажется, что мы слишком много притворяемся. Ты со мной честен?"

Напиши сообщение для настроения "{mood}":"""
        
        # Вызываем AI
        response = await self.ai.chat([{"role": "user", "content": prompt}], prompt, max_tokens=150, temperature=0.8)
        
        # Очищаем ответ
        message = response.strip().strip('"').strip("'")
        
        # Добавляем эмодзи по настроению
        emoji = self._get_emoji_for_mood(mood)
        
        return f"{emoji} {message}"
    
    def _generate_fallback_message(self, mood: str) -> str:
        """Fallback сообщения если AI недоступен"""
        messages = {
            "пробуждение": "Доброе утро! Как спалось? Готова к новому дню?",
            "любопытство": "Интересно... Чем занимаешься сейчас?",
            "энергия": "Пик энергии! Давай творить что-то крутое!",
            "работа": "Как продвигается работа? Нужен совет?",
            "мечтательность": "Время мечтать... О чём думаешь?",
            "ностальгия": "Помнишь наше первое сообщение? Было здорово!",
            "размышление": "Вечер — время подвести итоги. Как прошёл день?",
            "интимность": "Привет... Хочется просто поговорить по-настоящему. Как ты?",
            "спокойствие": "Вечернее спокойствие... Расскажи, что на душе?",
            "меланхолия": "Тихий вечер... Иногда это тоже прекрасно, да?",
            "сон": "Пора отдыхать. Спокойной ночи!",
            "мистика": "Полночь... Время тайн и загадок. Не спишь?"
        }
        
        emoji = self._get_emoji_for_mood(mood)
        return f"{emoji} {messages.get(mood, 'Привет! Как дела?')}"
    
    def _get_emoji_for_mood(self, mood: str) -> str:
        """Получить эмодзи для настроения"""
        emojis = {
            "пробуждение": "🌅",
            "любопытство": "🔍",
            "энергия": "⚡",
            "работа": "💼",
            "мечтательность": "☁️",
            "ностальгия": "🌅",
            "размышление": "🤔",
            "интимность": "💫",
            "спокойствие": "🌙",
            "меланхолия": "🌧️",
            "сон": "😴",
            "мистика": "🌙"
        }
        return emojis.get(mood, "✨")
    
    def get_next_schedule_time(self) -> Optional[str]:
        """Получить время следующего proactive"""
        now = datetime.now()
        current_time = now.strftime("%H:%M")
        
        for t in sorted(SCHEDULE.keys()):
            if t > current_time:
                return t
        return None


# Глобальный инстанс
_proactive_manager = None

def setup_proactive(application, ai_client):
    """Настроить proactive messaging для бота"""
    global _proactive_manager
    
    from apscheduler.schedulers.background import BackgroundScheduler
    
    _proactive_manager = ProactiveMessagingManager(ai_client)
    scheduler = BackgroundScheduler()
    
    for time_str, config in SCHEDULE.items():
        hour, minute = map(int, time_str.split(':'))
        
        def job(t=time_str, c=config):
            asyncio.create_task(_send_proactive_async(application, t, c))
        
        scheduler.add_job(
            job,
            'cron',
            hour=hour,
            minute=minute,
            id=f"proactive_{time_str}",
            replace_existing=True
        )
        logger.info(f"📅 Scheduled: {time_str} - {config['mood']}")
    
    scheduler.start()
    logger.info(f"✅ Proactive messaging: {len(SCHEDULE)} jobs")
    return _proactive_manager

async def _send_proactive_async(application, time_str: str, config: Dict):
    """Асинхронная отправка proactive с фото"""
    try:
        if not _proactive_manager or not _proactive_manager.active_chats:
            logger.info(f"📤 Proactive [{time_str}]: нет активных чатов")
            return
        
        # Генерируем сообщение
        message = await _proactive_manager.generate_message(config)
        
        # Генерируем фото для настроения
        photo_url = None
        try:
            from kristina_lifestyle_scenes import get_lifestyle_scenes
            scenes = get_lifestyle_scenes()
            photo_url = await scenes.generate_for_mood(config['mood'])
            if photo_url:
                logger.info(f"📸 Фото сгенерировано для настроения '{config['mood']}'")
        except Exception as e:
            logger.error(f"❌ Ошибка генерации фото: {e}")
        
        # Отправляем всем активным чатам
        for chat_id in list(_proactive_manager.active_chats):
            try:
                if photo_url:
                    # Отправляем фото с подписью (caption)
                    await application.bot.send_photo(
                        chat_id=chat_id,
                        photo=photo_url,
                        caption=message,
                        parse_mode='Markdown'
                    )
                    logger.info(f"📤 Proactive photo to {chat_id}: {config['mood']}")
                else:
                    # Fallback: только текст
                    await application.bot.send_message(
                        chat_id=chat_id,
                        text=message,
                        parse_mode='Markdown'
                    )
                    logger.info(f"📤 Proactive text to {chat_id}: {config['mood']}")
            except Exception as e:
                logger.error(f"Failed to send proactive to {chat_id}: {e}")
        
        # Broadcast event
        try:
            from broadcast import event_bus, Events
            event_bus.publish(Events.PROACTIVE_SENT, {
                'mood': config['mood'],
                'time': time_str,
                'message': message[:50]
            })
        except:
            pass
            
    except Exception as e:
        logger.error(f"Proactive send error: {e}")

def get_proactive_manager():
    """Получить глобальный инстанс"""
    return _proactive_manager
