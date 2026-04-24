"""
Image Generator Module — Пейзажи Стокгольма от первого лица (iPhone 17 style)
Без Кристины на фото, только атмосфера города через её глаза
"""

import asyncio
import logging
import os
import base64
from typing import Optional, Dict, Any
import aiohttp

logger = logging.getLogger(__name__)

class StockholmScenesGenerator:
    """Генератор атмосферных пейзажей Стокгольма"""
    
    def __init__(self):
        # Локации Стокгольма для разных настроений
        self.locations = {
            "coffee": {
                "scene": "Gamla Stan historic cafe interior, wooden tables, large arched windows, warm morning light, coffee cup with latte art, cinnamon buns, cobblestone street visible through window, cozy Swedish atmosphere",
                "angle": "sitting at table, first-person view"
            },
            "book": {
                "scene": "Stockholm Public Library iconic circular reading room, white walls, wooden desks, soft natural light from skylights, open book on table, quiet peaceful atmosphere, Scandinavian design",
                "angle": "over the shoulder view, reading perspective"
            },
            "home": {
                "scene": "Södermalm apartment with large windows, white minimalist interior, plants on windowsill, Stockholm rooftops view, warm evening light, cozy blanket, candles, rain drops on glass",
                "angle": "window view from inside, looking out"
            },
            "street": {
                "scene": "Gamla Stan narrow cobblestone street, colorful historic buildings 17th century, bicycles parked, Swedish flags, charming cafes, autumn leaves, crisp Nordic air",
                "angle": "walking perspective, street level"
            },
            "water": {
                "scene": "Strandvägen waterfront promenade, Baltic sea, archipelago view, elegant boats, seagulls flying, Djurgården island in distance, crisp morning air, wooden docks",
                "angle": "standing on pier, looking at water"
            },
            "work": {
                "scene": "Modern Stockholm coworking space, large windows overlooking city, Apple devices on table, design sketches, industrial chic interior, plants, creative atmosphere, Stureplan view",
                "angle": "desk perspective, laptop screen visible"
            },
            "night": {
                "scene": "Stureplan evening, Stockholm city lights, wet pavement reflecting street lamps, historic buildings illuminated, sophisticated atmosphere, Nordic night, bokeh lights",
                "angle": "street level, looking at city lights"
            },
            "park": {
                "scene": "Djurgården green park, oak trees, Swedish nature, wooden bench, view of water, peaceful morning, birds singing, fresh grass, distant museum silhouette",
                "angle": "sitting on bench, looking at nature"
            },
            "metro": {
                "scene": "Stockholm T-bana subway station, artistic cave-like design, colorful tiles, escalator, unique Swedish metro art, underground architecture, people silhouettes",
                "angle": "platform view, waiting for train"
            },
            "market": {
                "scene": "Östermalms Saluhall food market, fresh Swedish products, seafood, cheeses, flowers, historic market hall interior, bustling atmosphere, local vendors",
                "angle": "walking through market, browsing stalls"
            }
        }
        
        self.api_key = os.getenv("PROXIAPI_KEY")
        self.base_url = "https://api.proxyapi.ru/openai/v1"
        
        if not self.api_key:
            logger.error("❌ PROXIAPI_KEY не задан!")
        else:
            logger.info("✅ Генератор пейзажей Стокгольма готов")
    
    def _analyze_thought(self, thought: str) -> str:
        """Анализируем мысль и выбираем локацию"""
        thought_lower = thought.lower()
        
        keywords = {
            "coffee": ["кофе", "кафе", "утро", "латте", "завтрак", "проснулась", "эспрессо"],
            "book": ["книга", "читаю", "литература", "учу", "библиотека", "знания"],
            "home": ["дома", "вечер", "дом", "квартира", "отдыхаю", "уют", "окно"],
            "street": ["улица", "шопинг", "магазин", "иду", "прогулка", "город", "гамла"],
            "water": ["вода", "море", "набережная", "парк", "природа", "свежий", "архипелаг"],
            "work": ["работа", "дизайн", "проект", "клиент", "встреча", "офис", "ноутбук"],
            "night": ["ночь", "вечеринка", "свидание", "ужин", "бар", "огни", "вечер"],
            "park": ["парк", "деревья", "природа", "отдых", "скамейка", "трава"],
            "metro": ["метро", "туннель", "станция", "транспорт", "поезд"],
            "market": ["рынок", "еда", "продукты", "шопинг", "магазины"]
        }
        
        for location, words in keywords.items():
            if any(word in thought_lower for word in words):
                return location
        
        return "street"  # По умолчанию — улицы города
    
    def _create_prompt(self, thought: str, context: str = "") -> str:
        """Создать промпт для пейзажа iPhone 17 style"""
        location_key = self._analyze_thought(thought)
        location = self.locations[location_key]
        
        # iPhone 17 style пейзаж без людей
        prompt = f"""iPhone 17 Pro Max photograph, vertical 9:16 format, 
shot on iPhone camera, slight natural grain, authentic mobile photography look,
{location['scene']}, {location['angle']},
natural lighting as seen by human eye, photorealistic, 
shot by young woman sharing her day, Instagram stories style, 
no people in frame, first-person perspective, 
Stockholm Sweden, Nordic atmosphere, 2026"""
        
        return " ".join(prompt.split())
    
    async def generate_image(self, thought: str, context: str = "", max_retries: int = 2) -> Optional[bytes]:
        """Генерация пейзажа через DALL-E 3"""
        for attempt in range(max_retries):
            try:
                prompt = self._create_prompt(thought, context)
                location = self._analyze_thought(thought)
                logger.info(f"📍 Локация: {location} | Генерация пейзажа...")
                
                if not self.api_key:
                    return None
                
                headers = {
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                }
                
                # DALL-E 3 поддерживает размеры: 1024x1024, 1792x1024, 1024x1792
                # Для stories используем вертикальный 1024x1792 (ближе к 9:16)
                data = {
                    "model": "dall-e-3",
                    "prompt": prompt[:4000],
                    "size": "1024x1792",  # Вертикальный формат для stories!
                    "quality": "standard",
                    "n": 1,
                    "response_format": "b64_json"
                }
                
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=180)) as session:
                    async with session.post(
                        f"{self.base_url}/images/generations",
                        headers=headers,
                        json=data
                    ) as resp:
                        
                        if resp.status != 200:
                            text = await resp.text()
                            logger.error(f"❌ HTTP {resp.status}")
                            if attempt < max_retries - 1:
                                await asyncio.sleep(5)
                                continue
                            return None
                        
                        import json
                        result = json.loads(await resp.text())
                        
                        b64_data = result["data"][0].get("b64_json")
                        if b64_data:
                            image_data = base64.b64decode(b64_data)
                            logger.info(f"✅ Пейзаж сгенерирован: {len(image_data)} байт")
                            return image_data
                        return None
                                
            except Exception as e:
                logger.error(f"❌ Ошибка: {e}")
                return None
        
        return None
    
    def get_status(self) -> Dict[str, Any]:
        return {"available": bool(self.api_key), "service": "Stockholm-Scenes-iPhone"}

_image_generator = None

def get_image_generator():
    global _image_generator
    if _image_generator is None:
        _image_generator = StockholmScenesGenerator()
    return _image_generator
