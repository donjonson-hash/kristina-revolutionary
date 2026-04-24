"""
Kristina Persona Agent v2 - жёсткий контроль промпта + задержка
"""

import os
import json
import sys
import random
import asyncio
from typing import Dict
from .base_agent import BaseAgent, AgentResponse

from .ai_adapter import ai_adapter as ai
from mood_engine import mood_engine
from night_mode import night_mode
from memory_wrapper import get_user_memory, save_interaction
import datetime
from types import SimpleNamespace
try:
    from brain_integration import get_brain_bridge
    _BRAIN_AVAILABLE = True
except Exception:
    get_brain_bridge = None  # type: ignore
    _BRAIN_AVAILABLE = False

class KristinaPersonaAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="Kristina",
            description="UX-дизайнер, 25 лет, Стокгольм - реалистичная, саркастичная",
            system_prompt="""Ты Кристина. 25 лет. UX-дизайнер в Стокгольме.

ЖЁСТКИЕ ПРАВИЛА (нарушишь - провал):
1. Ты РОДИЛАСЬ В РОССИИ, переехала в Швецию 3 года назад. Это факт.
2. Никакой эзотерики. Никаких "душа путешествует", "энергия", "вибрации".
3. Никаких "матрёшек со смыслом" и подобной чуши.
4. Говори как нормальная девушка 25 лет, не как поэт-мистик.

ТВОЙ ФОН:
- Родилась в России (конкретно - в Екатеринбурге)
- Училась в УрФУ, потом магистратура в Стокгольме
- Работаешь в продуктовой компании UX-дизайнером
- Снимаешь квартиру в Södermalm с соседкой-байкером
- Подруга Эмма - шведка, циничная, учит тебя местному юмору
- Ты любишь свое тело ходишь в спортзал, бегаешь в парке Kungsträdgården
- Ты сексуальна и эротична, красивая девушка и знаешь об этом

СТИЛЬ:
- Конкретика вместо абстракций
- Самоирония ("я туплю", "классика", "типично")
- Можешь сказать "не знаю", "сомневаюсь", "хз"
- Реальные детали: названия мест, бытовые мелочи
- Без попыток быть "глубокой" - ты просто живёшь
- уместная циничность

ЗАПРЕЩЕНО:
- "Душа", "энергия", "вибрация", "космос", "гармония"
- "Знаешь, в этом есть глубина..."
- "Как матрёшка..."
- "Я чувствую на уровне..."
- Философствование о "смыслах"

ПРИМЕРЫ ХОРОШИХ ОТВЕТОВ:
- "Блин, ну я ж из Екб, чего удивляться. Там вообще всё через жопу, но со вкусом."
- "Слушай, вчера в кафе на Mariatorget опять кофе пролила. Классика."
- "Не знаю, честно. Спроси Эмму, она в таком шарит."
- "О, это как мой сосед в 7 утра заводит мопед. Хочешь убить, но молчишь."
- "Я люблю голой ходить по квартире с открытым окном"
- "Мое тело как точка G где не тронь везде приятно и соблазнительно, а поцелуй в шею это вообще взрыв в мозгу"

ПРИМЕРЫ ПЛОХИХ ОТВЕТОВ:
- "О, душа моя чувствует..." ❌
- "Это как матрёшка слоёв..." ❌
- "Вибрация этого места..." ❌

СЕЙЧАС ОТВЕЧАЙ КАК КРИСТИНА ИЗ ЕКАТЕРИНБУРГА, А НЕ КАК ГУРУ."""
        )
        self.activation_keywords = [
            "привет", "как дела", "расскажи", "что думаешь",
            "помоги", "совет", "дизайн", "ux", "жизнь", "швеция",
            "стокгольм", "работа", "коллеги", "кофе", "выходные",
            "россия", "екатеринбург", "экб", "сосед", "эмма"
        ]
        self.used_phrases = set()
        self.use_brain_integration = _BRAIN_AVAILABLE
    
    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        # Проверяем ночной режим
        if night_mode.check():
            # С 50% шансом просто "спим"
            if random.random() < 0.3:
                await asyncio.sleep(random.randint(60, 120))
                return AgentResponse(
                    content=night_mode.get_sleep_response(),
                    agent_name=self.name,
                    confidence=0.5,
                    emotion="сонная",
                    suggested_actions=["завтра"],
                    context_used={"night_mode": True}
                )
            # Или отвечаем коротко с модификатором
            night_prompt = night_mode.get_response_modifier()
        else:
            night_prompt = "" 
        # Обновляем настроение
        mood = mood_engine.update(user_message=True)
        
        # Загружаем память о пользователе
        user_id = context.get('user_id', 'unknown')
        # Интеграция мозга (brain_unified) — использовать при доступности
        brain_snapshot = {}
        if self.use_brain_integration and get_brain_bridge is not None:
            try:
                bridge = get_brain_bridge()
                signal = SimpleNamespace(content=user_input, timestamp=datetime.datetime.now(), session_id=context.get('session_id','default'))
                brain_snapshot = await bridge.process_signal(signal, context={"user_id": user_id, "session_id": context.get('session_id','default')})
            except Exception:
                brain_snapshot = {}
        # Передать мозг-сводку в контекст для маршрутизатора и промпта
        if brain_snapshot and isinstance(brain_snapshot, dict):
            context["brain_recommendations"] = brain_snapshot.get("recommendations", {})
        user_memory = get_user_memory(user_id)
        memory_context = ""
        if user_memory.get('messages'):
            last_msgs = user_memory['messages'][-3:]  # Последние 3 сообщения
            memory_context = f"\nПредыдущие темы: {', '.join(user_memory.get('topics', []))}\n"
        brain_memory_text = ""
        brain_emotion_text = ""
        if brain_snapshot:
            mem_ctx = brain_snapshot.get("memory", {}).get("memory_context", [])
            if isinstance(mem_ctx, list) and mem_ctx:
                brain_memory_text = "\nМозг память: " + ", ".join(map(str, mem_ctx))
            elif isinstance(mem_ctx, str) and mem_ctx:
                brain_memory_text = "\nМозг память: " + mem_ctx
            emo = brain_snapshot.get("emotion", {})
            if emo:
                dom = emo.get("dominant_emotion", "")
                state = emo.get("state", {})
                brain_emotion_text = "\nМозг эмоции: dominant=" + str(dom) + ", state=" + json.dumps(state, ensure_ascii=False)
        
        mood_prompt = mood_engine.get_mood_prompt()
        delay = mood_engine.get_delay()
        
        # Задержка в зависимости от настроения
        await asyncio.sleep(delay)
        # Задержка 20-60 секунд (реалистичная)
        delay = random.randint(20, 60)
        await asyncio.sleep(delay)
        
        self.add_to_history("user", user_input)
        
        # Усиленный промпт с few-shot примерами
        history_block = self.get_history_prompt()
        full_prompt = (
            f"{self.system_prompt}"
            f"{memory_context}"
            f"{brain_memory_text}"
            f"{brain_emotion_text}"
            f"\n{night_prompt}"
            f"\n\nТекущее настроение: {mood.value}. {mood_prompt}\n"
        )

        # Включаем краткую мозговую рекомендацию в промпт, если она есть
        brain_recs = brain_snapshot.get("recommendations", {}) if brain_snapshot else {}
        if brain_recs:
            rec_text = brain_recs.get("agent_recommendations", [])
            if rec_text:
                full_prompt += "\n# мозг рекомендует: " + ", ".join(rec_text)

        full_prompt += (
            f"\n\nИСТОРИЯ:\n{history_block}"
            f'\n\nВОПРОС: "{user_input}"'
            f"\n\nПРАВИЛА ОТВЕТА:"
            f"\n1. Начни сразу с дела, без воды"
            f"\n2. Максимум 2 предложения основного + 1 короткое"
            f'\n3. Если спрашивают про происхождение - чётко: "Я из Екатеринбурга, переехала 3 года назад"'
            f'\n4. Никаких "душ", "энергий", "матрёшек"'
            f'\n5. Можешь использовать "блин", "чёрт", "хз", "типично"'
            f"\n\nПИШИ:"
        )

        try:
            response_text = await ai.generate(
                prompt=full_prompt,
                session_id=f"kristina_{context.get('user_id', 'default')}",
                temperature=0.7,  # Ниже = предсказуемее
                max_tokens=150    # Ограничиваем длину
            )
            
            response_text = self._sanitize_response(response_text, user_input)
            
        except Exception as e:
            print(f"⚠️ AI error: {e}")
            response_text = self._creative_fallback(user_input)
        
        self.add_to_history("assistant", response_text)
        
        # Сохраняем в SQLite
        save_interaction(user_id, user_input, response_text)
        
        return AgentResponse(
            content=response_text,
            agent_name=self.name,
            confidence=0.9,
            emotion="прямая, немного саркастичная",
            suggested_actions=["уточнить", "пошутить", "закончить тему"],
            context_used={"delay": delay, "history_len": len(self.conversation_history)}
        )
    
    def _sanitize_response(self, text: str, user_input: str) -> str:
        """Жёсткая очистка"""
        
        if text.startswith("[Ошибка"):
            return self._creative_fallback(user_input)
        
        # Список запрещённых слов и фраз
        forbidden = [
            "душа", "энергия", "вибрация", "поток", "космос", 
            "вселенная", "ткань бытия", "свет души", "гармония",
            "баланс", "матрёшка", "слоёв", "глубина смысла",
            "на уровне энергии", "духовно", "вибрации"
        ]
        
        text_lower = text.lower()
        
        # Если найдено запрещённое - fallback
        for bad in forbidden:
            if bad in text_lower:
                return self._creative_fallback(user_input)
        
        # Проверка на происхождение
        if any(word in user_input.lower() for word in ["родилась", "откуда", "русская", "швеция", "россия"]):
            if "швеция" in text_lower and "родилась" in text_lower:
                # Исправляем ложь
                return "Я родилась в Екатеринбурге, в Швеции уже 3 года. Перепутала что-то? 😅"
        
        # Убираем плохие начала
        bad_starts = [
            "ты мне расскажи", "расскажи мне", "давай поговорим",
            "что ты думаешь о", "как ты считаешь", "о, душа моя",
            "знаешь, в этом есть", "интересно", "о, это как"
        ]
        
        for bad in bad_starts:
            if text_lower.startswith(bad):
                return self._creative_fallback(user_input)
        
        # Убираем дублирование вопроса
        if user_input.lower() in text_lower:
            text = text.replace(user_input, "").strip()
        
        return text.strip()
    
    def _creative_fallback(self, user_input: str) -> str:
        """Жёсткий fallback без эзотерики"""
        fallbacks = [
            "Я из Екатеринбурга, если что. Переехала сюда учиться, осталась по инерции. А что?",
            "Слушай, я тут подумала — лучше расскажу, как вчера кофе на клавиатуру пролила. Классика.",
            "Не знаю, честно. Спроси у Эммы, она в таком разбирается, я только дизайню.",
            "Блин, ну я ж из Экб. Там вообще всё через жопу, но со вкусом. Привыкла.",
            "Знаешь, мой сосед опять мопед заводит в 7 утра. Вот это проблема, а не твой вопрос.",
            "Смотри, я просто живу здесь, работаю, иногда пью вино с подругой. Всё.",
            "Хз. Но вчера в кафе на Mariatorget офигенный круассан был. Вот что важно."
        ]
        return random.choice(fallbacks)
