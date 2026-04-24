"""
KRISTINA LIFESTYLE SCENES v1.0
Генератор фото для сториз — активная жизнь девушки 25 лет
Формат: iPhone 17 Pro, вертикальное 9:16, ultra-realistic
"""

import random
import asyncio
import logging
from typing import Optional, Dict, List
from kling_api import KlingAPI

logger = logging.getLogger(__name__)


class KristinaLifestyleScenes:
    """Генератор lifestyle-фото Кристины для Instagram Stories"""
    
    # 20 сцен покрывающих жизнь активной девушки
    SCENES = {
        # === УТРО / ЗАВТРАК / КОФЕ ===
        "morning_coffee": {
            "name": "Утренний кофе",
            "category": "food",
            "prompts": [
                "Swedish cafe interior, Stockholm, young blonde woman holding latte art coffee cup, natural morning light through window, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, cozy Scandinavian design, warm tones, Instagram story aesthetic, shot on iPhone, sharp details, photorealistic",
                "Cozy Stockholm cafe, woman having breakfast, avocado toast and coffee, morning sunlight, iPhone vertical photo, 9:16, realistic, natural colors, lifestyle photography",
                "Coffee shop window seat, Stockholm street view, woman with book and cappuccino, autumn morning, iPhone 17 Pro, 9:16 vertical, photorealistic, warm atmosphere"
            ]
        },
        
        # === СПОРТ / ФИТНЕС ===
        "gym_workout": {
            "name": "Тренировка в зале",
            "category": "sport",
            "prompts": [
                "Modern gym interior Stockholm, young athletic blonde woman doing workout, mirror selfie, sportswear, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, natural gym lighting, fitness lifestyle, Instagram story, photorealistic, sharp focus",
                "Yoga studio Stockholm, woman in yoga pose, morning light, peaceful atmosphere, iPhone vertical 9:16, realistic, wellness lifestyle",
                "Running track Stockholm waterfront, woman jogging, sunrise, athletic wear, iPhone photo, 9:16 vertical, realistic, energetic"
            ]
        },
        
        # === РАБОТА / UX ДИЗАЙН ===
        "ux_designer": {
            "name": "Работа UX-дизайнера",
            "category": "work",
            "prompts": [
                "Modern Stockholm office, coworking space, young woman working on MacBook, UI/UX design on screen, plants, minimalist Scandinavian interior, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, natural daylight, professional lifestyle, Instagram story",
                "Coffee shop workspace, laptop with Figma design, notebook, coffee, woman hands typing, iPhone vertical 9:16, realistic, freelancer lifestyle",
                "Home office Stockholm, dual monitors, design work, cozy apartment, woman focused on work, iPhone photo, 9:16, realistic, remote work"
            ]
        },
        
        # === ПРОГУЛКИ / ГОРОД ===
        "city_walks": {
            "name": "Прогулки по городу",
            "category": "lifestyle",
            "prompts": [
                "Gamla Stan Stockholm, cobblestone street, young stylish blonde woman walking, autumn leaves, colorful buildings, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, golden hour light, street style, Instagram story aesthetic",
                "Södermalm street art, trendy neighborhood, woman exploring, graffiti wall, iPhone vertical 9:16, realistic, urban exploration",
                "Stockholm waterfront promenade, sunset, woman silhouette, city skyline, iPhone photo, 9:16, realistic, peaceful evening"
            ]
        },
        
        # === ВЕЧЕР / БАР / КОКТЕЙЛИ ===
        "evening_drinks": {
            "name": "Вечерние напитки",
            "category": "nightlife",
            "prompts": [
                "Trendy Stockholm bar, cocktail in hand, young woman, ambient lighting, bokeh background, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, night mode, warm tones, nightlife aesthetic, Instagram story, photorealistic",
                "Rooftop bar Stockholm, city lights view, evening cocktail, stylish atmosphere, iPhone vertical 9:16, realistic, night out",
                "Wine bar interior, cozy evening, woman with glass of red wine, candlelight, iPhone photo, 9:16, realistic, intimate atmosphere"
            ]
        },
        
        # === НОЧНОЙ КЛУБ / ТАНЦЫ ===
        "nightclub": {
            "name": "Ночной клуб",
            "category": "nightlife",
            "prompts": [
                "Stockholm nightclub, dance floor lights, young woman dancing with friends, neon lights, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, motion blur background, party atmosphere, nightlife, Instagram story, photorealistic",
                "Club bathroom mirror selfie, Stockholm nightlife, stylish outfit, neon lighting, iPhone vertical 9:16, realistic, night out vibes",
                "DJ booth view, nightclub Stockholm, crowd dancing, energetic atmosphere, iPhone photo, 9:16, realistic, party night"
            ]
        },
        
        # === КОНЦЕРТ / ЖИВАЯ МУЗЫКА ===
        "concert": {
            "name": "Концерт",
            "category": "entertainment",
            "prompts": [
                "Stockholm concert venue, live music, crowd with phones, stage lights, young woman enjoying show, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, concert atmosphere, music event, Instagram story, photorealistic",
                "Festival Stockholm, outdoor concert, summer evening, people dancing, iPhone vertical 9:16, realistic, music festival vibes",
                "Intimate jazz club Stockholm, live band, candlelit tables, sophisticated evening, iPhone photo, 9:16, realistic, cultural night"
            ]
        },
        
        # === ШОППИНГ / МОДА ===
        "shopping": {
            "name": "Шоппинг",
            "category": "lifestyle",
            "prompts": [
                "Stockholm fashion district, shopping bags, stylish young woman, boutique storefront, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, street fashion, urban style, Instagram story, photorealistic",
                "Vintage thrift store Stockholm, trying on clothes, mirror selfie, unique finds, iPhone vertical 9:16, realistic, sustainable fashion",
                "Luxury department store, cosmetics section, testing makeup, elegant interior, iPhone photo, 9:16, realistic, beauty shopping"
            ]
        },
        
        # === ПАРК / ПРИРОДА / ОТДЫХ ===
        "park_relax": {
            "name": "Отдых в парке",
            "category": "nature",
            "prompts": [
                "Djurgården park Stockholm, sunny day, woman reading book on grass, picnic blanket, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, summer vibes, relaxed atmosphere, Instagram story, photorealistic",
                "Stockholm botanical garden, spring flowers, woman walking path, peaceful nature, iPhone vertical 9:16, realistic, nature lover",
                "Lake side Stockholm, kayaking, summer activity, water reflection, iPhone photo, 9:16, realistic, outdoor adventure"
            ]
        },
        
        # === ПУТЕШЕСТВИЯ / АРХИПЕЛАГ ===
        "travel_archipelago": {
            "name": "Путешествие по архипелагу",
            "category": "travel",
            "prompts": [
                "Stockholm archipelago, ferry boat deck, woman looking at islands, wind in hair, summer day, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, travel wanderlust, sea view, Instagram story, photorealistic",
                "Island hopping Stockholm, wooden pier, red Swedish houses, coastal view, iPhone vertical 9:16, realistic, summer vacation",
                "Boat trip Stockholm, sailing, sunset on water, horizon view, iPhone photo, 9:16, realistic, maritime adventure"
            ]
        },
        
        # === ДОМАШНИЙ УЮТ ===
        "home_cozy": {
            "name": "Домашний уют",
            "category": "lifestyle",
            "prompts": [
                "Scandinavian apartment Stockholm, cozy evening, woman on sofa with blanket, candles, hygge atmosphere, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, warm lighting, home sweet home, Instagram story, photorealistic",
                "Kitchen cooking, Stockholm apartment, preparing dinner, steam, cozy interior, iPhone vertical 9:16, realistic, home cooking",
                "Bedroom morning, messy bed, sunlight through curtains, lazy Sunday, iPhone photo, 9:16, realistic, casual lifestyle"
            ]
        },
        
        # === ИСКУССТВО / МУЗЕИ ===
        "art_museum": {
            "name": "Музей и искусство",
            "category": "culture",
            "prompts": [
                "Moderna Museet Stockholm, contemporary art, woman viewing painting, gallery space, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, cultural experience, art lover, Instagram story, photorealistic",
                "Photography exhibition Stockholm, black and white photos, artistic atmosphere, iPhone vertical 9:16, realistic, culture vulture",
                "Street art tour, Stockholm murals, colorful walls, urban art, iPhone photo, 9:16, realistic, art exploration"
            ]
        },
        
        # === ЕДА / РЕСТОРАНЫ ===
        "restaurant_dinner": {
            "name": "Ужин в ресторане",
            "category": "food",
            "prompts": [
                "Trendy Stockholm restaurant, dinner plate, food photography, ambient lighting, woman dining, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, gourmet experience, foodstagram, Instagram story, photorealistic",
                "Sushi restaurant Stockholm, beautifully plated food, chopsticks, intimate setting, iPhone vertical 9:16, realistic, dinner date",
                "Outdoor cafe terrace, summer evening, people watching, wine and tapas, iPhone photo, 9:16, realistic, social dining"
            ]
        },
        
        # === ЗАКАТ / ЗОЛОТОЙ ЧАС ===
        "golden_hour": {
            "name": "Золотой час",
            "category": "aesthetic",
            "prompts": [
                "Stockholm sunset, golden hour light, woman silhouette, city view, warm tones, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, magical light, aesthetic photography, Instagram story, photorealistic",
                "Rooftop sunset, Stockholm skyline, orange sky, reflective moment, iPhone vertical 9:16, realistic, golden moment",
                "Waterfront golden hour, sun reflection, peaceful atmosphere, end of day, iPhone photo, 9:16, realistic, serene beauty"
            ]
        },
        
        # === ДОЖДЬ / УЮТ ===
        "rainy_cozy": {
            "name": "Дождливый день",
            "category": "mood",
            "prompts": [
                "Stockholm rainy day, window view, raindrops, cozy indoor, woman with tea, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, melancholic beauty, cozy vibes, Instagram story, photorealistic",
                "Umbrella street, Stockholm autumn, puddle reflections, city lights, iPhone vertical 9:16, realistic, rainy mood",
                "Cafe window seat, rain outside, warm inside, book and coffee, iPhone photo, 9:16, realistic, cozy contrast"
            ]
        },
        
        # === ДРУЗЬЯ / ВЕЧЕРИНКА ===
        "friends_gathering": {
            "name": "Встреча с друзьями",
            "category": "social",
            "prompts": [
                "Stockholm apartment, friends gathering, drinks and snacks, casual party, laughter, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, social life, friendship, Instagram story, photorealistic",
                "Picnic with friends, Stockholm park, summer, blankets and food, group photo, iPhone vertical 9:16, realistic, friendship goals",
                "Game night, friends on sofa, controllers, fun atmosphere, iPhone photo, 9:16, realistic, casual hangout"
            ]
        },
        
        # === КНИГИ / КОФЕЙНЯ ===
        "book_cafe": {
            "name": "Книги и кофе",
            "category": "leisure",
            "prompts": [
                "Stockholm bookstore cafe, woman reading, coffee cup, cozy corner, bookshelves, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, intellectual vibe, book lover, Instagram story, photorealistic",
                "Library study session, laptop and books, focused work, quiet atmosphere, iPhone vertical 9:16, realistic, study grind",
                "Poetry reading, Stockholm literary cafe, artistic atmosphere, creative soul, iPhone photo, 9:16, realistic, cultural leisure"
            ]
        },
        
        # === ТАНЦЫ / ВЕЧЕРИНКА ===
        "dance_party": {
            "name": "Танцы",
            "category": "nightlife",
            "prompts": [
                "Dance class Stockholm, salsa or bachata, couple dancing, movement, energy, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, dance passion, rhythm, Instagram story, photorealistic",
                "Dance floor, nightclub, people moving, lights, energetic moment, iPhone vertical 9:16, realistic, dance vibes",
                "Ballet practice, studio mirrors, graceful movement, artistic expression, iPhone photo, 9:16, realistic, dance art"
            ]
        },
        
        # === ЗИМА / СНЕГ ===
        "winter_magic": {
            "name": "Зимняя магия",
            "category": "seasonal",
            "prompts": [
                "Stockholm winter, snow falling, Gamla Stan, woman in warm coat, fairy lights, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, winter wonderland, magical atmosphere, Instagram story, photorealistic",
                "Ice skating, Kungsträdgården, winter activity, frozen lake, iPhone vertical 9:16, realistic, winter fun",
                "Cozy Christmas market, mulled wine, holiday decorations, festive spirit, iPhone photo, 9:16, realistic, holiday vibes"
            ]
        },
        
        # === МОДНЫЙ ОБРАЗ ===
        "fashion_look": {
            "name": "Модный образ",
            "category": "fashion",
            "prompts": [
                "Stockholm street style, fashion forward outfit, mirror selfie, trendy look, iPhone 17 Pro photo, vertical 9:16, ultra-realistic, fashionista, outfit of the day, Instagram story, photorealistic",
                "Dressing room, trying on clothes, fashion haul, stylish choices, iPhone vertical 9:16, realistic, fashion diary",
                "Accessories flat lay, jewelry, watch, sunglasses, aesthetic arrangement, iPhone photo, 9:16, realistic, details matter"
            ]
        }
    }
    
    # Сопоставление настроений со сценами
    MOOD_SCENES = {
        "пробуждение": ["morning_coffee", "home_cozy", "golden_hour"],
        "любопытство": ["city_walks", "art_museum", "book_cafe"],
        "энергия": ["gym_workout", "dance_party", "travel_archipelago"],
        "работа": ["ux_designer", "book_cafe", "home_cozy"],
        "мечтательность": ["golden_hour", "park_relax", "rainy_cozy"],
        "ностальгия": ["home_cozy", "book_cafe", "winter_magic"],
        "размышление": ["park_relax", "rainy_cozy", "art_museum"],
        "интимность": ["evening_drinks", "home_cozy", "friends_gathering"],
        "спокойствие": ["park_relax", "home_cozy", "book_cafe"],
        "меланхолия": ["rainy_cozy", "golden_hour", "winter_magic"],
        "сон": ["home_cozy", "nightclub", "winter_magic"],
        "мистика": ["nightclub", "winter_magic", "golden_hour"]
    }
    
    def __init__(self):
        self.kling = KlingAPI()
        logger.info("📸 KristinaLifestyleScenes инициализирован (20 сцен)")
    
    def get_scene_for_mood(self, mood: str) -> tuple:
        """Получить сцену для настроения"""
        scene_keys = self.MOOD_SCENES.get(mood, ["city_walks"])
        scene_key = random.choice(scene_keys)
        scene = self.SCENES[scene_key]
        
        prompt = random.choice(scene["prompts"])
        return scene_key, scene["name"], prompt, scene["category"]
    
    async def generate_for_mood(self, mood: str) -> Optional[str]:
        """Генерация фото для конкретного настроения"""
        try:
            scene_key, scene_name, prompt, category = self.get_scene_for_mood(mood)
            logger.info(f"🎨 Генерация: {scene_name} ({category}) для настроения '{mood}'")
            
            # Генерация через Kling
            result = await self.kling.generate_image(prompt)
            
            if result:
                logger.info(f"✅ Фото готово: {scene_name}")
                return result
            else:
                logger.error("❌ Ошибка генерации")
                return None
                
        except Exception as e:
            logger.error(f"❌ Ошибка generate_for_mood: {e}")
            return None
    
    def get_random_scene(self) -> tuple:
        """Случайная сцена"""
        scene_key = random.choice(list(self.SCENES.keys()))
        scene = self.SCENES[scene_key]
        prompt = random.choice(scene["prompts"])
        return scene_key, scene["name"], prompt


# Singleton
_lifestyle_scenes = None

def get_lifestyle_scenes() -> KristinaLifestyleScenes:
    """Получить singleton экземпляр"""
    global _lifestyle_scenes
    if _lifestyle_scenes is None:
        _lifestyle_scenes = KristinaLifestyleScenes()
    return _lifestyle_scenes


# Тестирование
if __name__ == "__main__":
    async def test():
        scenes = get_lifestyle_scenes()
        
        # Тест для каждого настроения
        test_moods = ["пробуждение", "энергия", "вечеринка", "мечтательность"]
        
        for mood in test_moods:
            print(f"\n🎭 Тест: {mood}")
            scene_key, scene_name, prompt, category = scenes.get_scene_for_mood(mood)
            print(f"  Сцена: {scene_name} ({category})")
            print(f"  Промпт: {prompt[:80]}...")
            
            # Генерация (раскомментировать для реального теста)
            # result = await scenes.generate_for_mood(mood)
            # print(f"  Результат: {result[:60] if result else 'None'}...")
        
        print("\n✅ Тест завершён")
    
    asyncio.run(test())
