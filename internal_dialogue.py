"""
Internal Dialogue Module — внутренний монолог Кристины
Публикует мысли в Telegram-канал (с фото или текст)
"""

import asyncio
import logging
import random
import os
import aiohttp
from datetime import datetime
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class InternalDialogue:
    """Генератор внутренних мыслей Кристины"""
    
    def __init__(self, brain, emotional_core, learning_agent):
        self.brain = brain
        self.emotional_core = emotional_core
        self.learning_agent = learning_agent
        self.last_thought_time = None
        self.thought_count = 0
        self.channel_id = os.getenv("KRISTINA_CHANNEL_ID")
        
        self.topic_emoji = {
            "ux_design": "🎨", "ui_trends": "✏️", "design_inspiration": "🖼️", "tech_gadgets": "📱",
            "stockholm_life": "🇸🇪", "sweden_culture": "🦌", "scandinavian_design": "🏠", "nordic_lifestyle": "🌲",
            "weather_mood": "🌤", "seasonal_changes": "🍂", "morning_routine": "☕", "night_thoughts": "🌙",
            "creativity": "💫", "art_exhibitions": "🎭", "photography": "📸", "visual_inspiration": "👁️",
            "literature": "📚", "book_reviews": "📖", "history": "🏛️", "philosophy_thoughts": "🤔",
            "fashion_trends": "👗", "minimalist_living": "🕊️", "wellness": "🧘‍♀️", "mindfulness": "🎐",
            "travel_inspiration": "✈️", "city_exploring": "🗺️", "hidden_gems": "💎", "weekend_getaways": "🎒",
            "dating_life": "💋", "relationship_thoughts": "💕", "self_discovery": "🔮", "intimate_moments": "🌹",
            "feminine_energy": "🌸", "seduction_art": "🍷", "pleasure_aesthetics": "🍓", "body_positivity": "💃",
            "erotic_art": "🔥", "sensual_photography": "📷", "intimacy_aesthetics": "🛁", "desire_exploration": "💭",
            "cinema_indie": "🎬", "music_discoveries": "🎵", "podcast_recommendations": "🎧", "nightlife": "🌃",
            "autonomous": "💭"
        }
    
    async def _download_image(self, url: str) -> bytes:
        """Скачать изображение по URL"""
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(url, timeout=30) as r:
                    if r.status == 200:
                        return await r.read()
                    else:
                        logger.error(f"❌ Не удалось скачать изображение: {r.status}")
                        return None
        except Exception as e:
            logger.error(f"❌ Ошибка скачивания: {e}")
            return None
    
    async def _publish_to_channel(self, thought: str, topic: str, image_url: str = None):
        """Публикация в Telegram-канал (с фото если есть image_url)"""
        if not self.channel_id:
            logger.warning("⚠️ KRISTINA_CHANNEL_ID not set")
            return
        
        emoji = self.topic_emoji.get(topic, "💭")
        text = f"{emoji} {thought}"
        
        try:
            token = os.getenv("KRISTINA_TELEGRAM_TOKEN")
            if not token:
                logger.error("❌ KRISTINA_TELEGRAM_TOKEN not set")
                return
            
            # Если есть image_url — скачиваем и отправляем файлом
            if image_url:
                logger.info(f"📥 Скачивание изображения...")
                image_data = await self._download_image(image_url)
                
                if image_data:
                    # Отправляем как файл
                    url = f"https://api.telegram.org/bot{token}/sendPhoto"
                    
                    form = aiohttp.FormData()
                    form.add_field('chat_id', self.channel_id)
                    form.add_field('caption', text[:1024])
                    form.add_field('parse_mode', 'HTML')
                    form.add_field('photo', image_data, filename='kristina.jpg', content_type='image/jpeg')
                    
                    async with aiohttp.ClientSession() as s:
                        async with s.post(url, data=form, timeout=60) as r:
                            if r.status == 200:
                                logger.info(f"✅ Фото опубликовано [{topic}]")
                            else:
                                error = await r.text()
                                logger.error(f"❌ Telegram error: {r.status} - {error[:200]}")
                else:
                    # Если не скачалось — отправляем текст
                    logger.warning("⚠️ Не удалось скачать фото, отправляем текст")
                    await self._send_text(token, text, topic)
            else:
                await self._send_text(token, text, topic)
                        
        except Exception as e:
            logger.error(f"❌ Failed to publish: {e}")
            import traceback
            traceback.print_exc()
    
    async def _send_text(self, token: str, text: str, topic: str):
        """Отправка текстового сообщения"""
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": self.channel_id,
            "text": text,
            "parse_mode": "HTML"
        }
        
        async with aiohttp.ClientSession() as s:
            async with s.post(url, json=payload, timeout=30) as r:
                if r.status == 200:
                    logger.info(f"💭 Текст опубликован [{topic}]")
                else:
                    logger.error(f"❌ Telegram error: {r.status}")
    
    async def publish_with_image(self, thought: str, image_url: str, topic: str = "autonomous"):
        """Публикация мысли с изображением"""
        await self._publish_to_channel(thought, topic, image_url)
    
    def get_stats(self) -> Dict[str, Any]:
        return {
            "thought_count": self.thought_count,
            "last_thought": self.last_thought_time.isoformat() if self.last_thought_time else None,
            "channel_configured": bool(self.channel_id)
        }

    async def _publish_with_bytes(self, thought: str, topic: str, image_data: bytes = None):
        """Публикация с байтами изображения"""
        if not self.channel_id:
            return
        
        emoji = self.topic_emoji.get(topic, "💭")
        text = f"{emoji} {thought}"
        
        try:
            token = os.getenv("KRISTINA_TELEGRAM_TOKEN")
            if not token:
                return
            
            if image_data:
                # Отправляем фото из байтов
                url = f"https://api.telegram.org/bot{token}/sendPhoto"
                
                form = aiohttp.FormData()
                form.add_field('chat_id', self.channel_id)
                form.add_field('caption', text[:1024])
                form.add_field('parse_mode', 'HTML')
                form.add_field('photo', image_data, filename='kristina.jpg', content_type='image/jpeg')
                
                async with aiohttp.ClientSession() as s:
                    async with s.post(url, data=form, timeout=60) as r:
                        if r.status == 200:
                            logger.info(f"✅ Фото опубликовано")
                        else:
                            logger.error(f"❌ Ошибка: {r.status}")
            else:
                await self._send_text(token, text, topic)
                        
        except Exception as e:
            logger.error(f"❌ Ошибка: {e}")
