"""
Генерация фото-пейзажей Стокгольма через Kling AI
Формат: iPhone 17, вертикальное 9:16 (1080x1920)
"""

import asyncio
import logging
import random
from typing import Optional
from kling_api import KlingAPI

logger = logging.getLogger(__name__)

class StockholmSceneGenerator:
    """Генератор сцен Стокгольма для iPhone 9:16"""
    
    LOCATIONS = {
        "gamla_stan": {
            "name": "Гамла Стан",
            "prompts": [
                "Narrow cobblestone street in Gamla Stan, Stockholm, golden hour sunlight, colorful old buildings, woman walking with coffee, iPhone photo aesthetic, vertical 9:16, warm tones, cozy atmosphere, Instagram story style",
                "Gamla Stan Stockholm, charming alley with hanging flowers, bicycle parked, morning light, cinematic vertical shot, 9:16 aspect ratio, travel photography, aesthetic",
            ]
        },
        "sodermalm": {
            "name": "Сёдермальм",
            "prompts": [
                "Södermalm Stockholm, trendy street art, hipster cafe, young woman with laptop, autumn leaves, vertical iPhone shot, 9:16, cool tones, Nordic aesthetic",
                "Stockholm Södermalm, view over rooftops, sunset colors, cozy balcony with plants, vertical photo, 9:16, golden hour, lifestyle photography",
            ]
        },
        "ostermalm": {
            "name": "Эстермальм",
            "prompts": [
                "Östermalm Stockholm, elegant street, luxury shopping area, stylish woman, autumn fashion, vertical iPhone photo, 9:16, chic atmosphere, soft light",
                "Humlegården park Stockholm, cherry blossoms, people picnicking, spring vibes, iPhone vertical photo, 9:16, pastel colors, dreamy aesthetic",
            ]
        },
        "djurgarden": {
            "name": "Юргорден",
            "prompts": [
                "Djurgården Stockholm, waterfront view, boats, summer evening, woman enjoying sunset, iPhone vertical photo, 9:16, golden light, serene atmosphere",
                "Skansen area Stockholm, traditional Swedish houses, red cottages, green trees, vertical iPhone shot, 9:16, nostalgic summer feeling",
            ]
        },
        "norrmalm": {
            "name": "Норрмальм",
            "prompts": [
                "Norrmalm Stockholm, Sergels Torg, modern architecture, urban vibes, people walking, iPhone vertical photo, 9:16, city life aesthetic",
                "Stockholm city center, Hötorget, sunset over buildings, dramatic sky, vertical 9:16, cinematic urban photography",
            ]
        },
        "kungsholmen": {
            "name": "Кунгсхольмен",
            "prompts": [
                "Kungsholmen Stockholm, Rålambshovsparken, park by the water, people relaxing, summer vibes, iPhone vertical 9:16, blue sky, cheerful",
                "Stockholm City Hall view from Kungsholmen, waterfront promenade, evening walk, golden light, vertical iPhone photo, 9:16, iconic view",
            ]
        },
        "archipelago": {
            "name": "Архипелаг",
            "prompts": [
                "Stockholm archipelago view, islands in the distance, ferry boat, summer day, crystal clear water, iPhone vertical 9:16, travel wanderlust",
                "Archipelago sunset, calm water reflection, warm orange and pink colors, peaceful moment, vertical 9:16, serene beauty",
            ]
        },
        "winter_scenes": {
            "name": "Зимние сцены",
            "prompts": [
                "Stockholm winter, snow-covered Gamla Stan, cozy Christmas lights, woman in warm coat, iPhone vertical 9:16, magical winter atmosphere",
                "Cozy cafe interior Stockholm, window view of snow, warm light inside, fika time, vertical 9:16, hygge lifestyle",
            ]
        }
    }
    
    def __init__(self):
        self.kling = KlingAPI()
        logger.info("📸 StockholmSceneGenerator инициализирован")
    
    def get_random_scene(self) -> tuple:
        location_key = random.choice(list(self.LOCATIONS.keys()))
        location = self.LOCATIONS[location_key]
        prompt = random.choice(location["prompts"])
        return location_key, location["name"], prompt
    
    async def generate_scene(self, custom_prompt: str = None) -> Optional[str]:
        if custom_prompt:
            prompt = custom_prompt
        else:
            location_key, location_name, prompt = self.get_random_scene()
            logger.info(f"📍 Локация: {location_name}")
        
        iphone_prompt = f"{prompt}, shot on iPhone 17 Pro, vertical orientation, 9:16 aspect ratio, high quality, sharp details, natural colors"
        
        try:
            url = await self.kling.generate(prompt=iphone_prompt, aspect_ratio="9:16")
            if url:
                logger.info(f"✅ Сцена сгенерирована")
                return url
            return None
        except Exception as e:
            logger.error(f"❌ Ошибка: {e}")
            return None
    
    async def generate_for_location(self, location_key: str) -> Optional[str]:
        if location_key not in self.LOCATIONS:
            return await self.generate_scene()
        
        location = self.LOCATIONS[location_key]
        prompt = random.choice(location["prompts"])
        return await self.generate_scene(prompt)


_scene_generator = None

def get_scene_generator():
    global _scene_generator
    if _scene_generator is None:
        _scene_generator = StockholmSceneGenerator()
    return _scene_generator
