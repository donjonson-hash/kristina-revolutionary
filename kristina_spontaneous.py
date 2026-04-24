"""
Kristina Spontaneous — Живые сообщения от Кристины
Без расписания, по настроению и контексту
"""

import asyncio
import random
from datetime import datetime, timedelta
from typing import Optional, List, Dict


class KristinaSpontaneous:
    """Кристина пишет когда ей захочется"""
    
    def __init__(self, orchestrator, dialog_memory):
        self.orch = orchestrator
        self.memory = dialog_memory
        self.last_check = {}
        self.min_interval = timedelta(hours=2)  # Минимум 2 часа между сообщениями
        
        # Триггеры для сообщений
        self.triggers = {
            'bored': {
                'chance': 0.3,  # 30% если скучно
                'messages': [
                    "Скучаю... Расскажи что-нибудь? 🙃",
                    "Ты там живой? Я вот кофе пью, а поговорить не с кем ☕",
                    "Придумай мне занятие, а то я уже 10 мин смотрю в стену 😅",
                    "Знаешь, я вспомнила наш разговор про {topic}...",
                ]
            },
            'memory': {
                'chance': 0.4,  # 40% если вспомнила
                'messages': [
                    "Слушай, а помнишь ты говорил про {memory}? Я всё думала об этом...",
                    "Только что увидела {trigger} и вспомнила тебя! 😊",
                    "Знаешь, мне сегодня приснилось что-то странное... Про {topic}",
                    "Вспомнила наш разговор. Улыбнулась ☺️",
                ]
            },
            'mood': {
                'chance': 0.5,  # 50% если настроение меняется
                'messages': [
                    "Знаешь, я сейчас такая {mood}... Хочется {desire}",
                    "У меня сегодня {mood} настроение. Ты как?",
                    "Такое чувство, что {feeling}... Не знаю почему",
                    "Я вся такая {mood} сегодня! {action}",
                ]
            },
            'question': {
                'chance': 0.35,  # 35% если любопытно
                'messages': [
                    "Вопрос: {question} 🤔",
                    "Знаешь, я всё думаю... {question}",
                    "Расскажи, {topic}? Интересно же!",
                    "А ты {action}? Я вот пробовала, но не уверена...",
                ]
            },
            'need': {
                'chance': 0.25,  # 25% если нужна помощь/совет
                'messages': [
                    "Поможешь мне кое с чем? {need}",
                    "Нужен твой мужской взгляд... {situation}",
                    "Я тут спорю с Эммой. Ты как думаешь, {question}?",
                    "Совет нужен! {problem}",
                ]
            }
        }
    
    async def should_message(self, user_id: str) -> Optional[str]:
        """Проверить, стоит ли написать"""
        
        # Проверяем интервал
        now = datetime.now()
        if user_id in self.last_check:
            if now - self.last_check[user_id] < self.min_interval:
                return None
        
        # Получаем историю
        history = await self.memory.get_context(user_id, limit=10)
        
        if not history:
            return None  # Новый пользователь — не пишем первой
        
        # Считаем время с последнего сообщения
        last_time = datetime.fromisoformat(history[-1]['time'])
        hours_passed = (now - last_time).total_seconds() / 3600
        
        # Если меньше 2 часов — точно не пишем
        if hours_passed < 2:
            return None
        
        # Если больше 24 часов — 100% пишем
        if hours_passed > 24:
            return await self._generate_message(user_id, history, 'miss_you')
        
        # Проверяем триггеры по настроению
        current_mood = self.orch.mood_core.current_mood
        
        # Триггер: скучно (если давно не писали)
        if hours_passed > 4 and random.random() < self.triggers['bored']['chance']:
            return await self._generate_message(user_id, history, 'bored')
        
        # Триггер: вспомнила что-то
        if random.random() < self.triggers['memory']['chance']:
            return await self._generate_message(user_id, history, 'memory')
        
        # Триггер: настроение
        if current_mood.intensity > 0.7 and random.random() < self.tiggers['mood']['chance']:
            return await self._generate_message(user_id, history, 'mood')
        
        # Триггер: любопытство
        if random.random() < self.triggers['question']['chance']:
            return await self._generate_message(user_id, history, 'question')
        
        # Триггер: нужна помощь
        if random.random() < self.triggers['need']['chance']:
            return await self._generate_message(user_id, history, 'need')
        
        self.last_check[user_id] = now
        return None
    
    async def _generate_message(self, user_id: str, history: List[Dict], trigger_type: str) -> str:
        """Сгенерировать сообщение на основе триггера"""
        
        # Извлекаем темы из истории
        user_msgs = [h['content'] for h in history if h['role'] == 'user']
        topics = self._extract_topics(user_msgs)
        
        # Формируем контекст для генерации
        context = {
            'topic': random.choice(topics) if topics else 'жизнь',
            'memory': self._extract_memory(history),
            'mood': self._mood_to_text(),
            'feeling': random.choice(['всё возможно', 'что-то важное', 'ничего не понятно']),
            'desire': random.choice(['поговорить', 'выпить кофе', 'узнать что-то новое']),
            'action': random.choice(['делал такое', 'знаешь ответ', 'пробовал']),
            'question': random.choice([
                'что ты думаешь о любви с первого взгляда',
                'какой у тебя любимый фильм',
                'ты веришь в судьбу',
                'что бы ты сделал с миллионом'
            ]),
            'need': random.choice([
                'не могу выбрать между двумя вариантами',
                'нужно мнение по дизайну',
                'не знаю что надеть сегодня'
            ]),
            'situation': random.choice([
                'ситуация странная',
                'соседка опять шумит',
                'на работе заваруха'
            ]),
            'problem': random.choice([
                'не могу решить',
                'сомневаюсь',
                'боюсь ошибиться'
            ])
        }
        
        # Выбираем шаблон
        templates = self.triggers.get(trigger_type, self.triggers['bored'])['messages']
        template = random.choice(templates)
        
        # Заполняем шаблон
        message = template.format(**context)
        
        # Сохраняем что мы написали
        await self.memory.add_message(user_id, 'assistant', message, 'spontaneous')
        self.last_check[user_id] = datetime.now()
        
        return message
    
    def _extract_topics(self, messages: List[str]) -> List[str]:
        """Извлечь темы из сообщений"""
        # Простая эвристика — ищем существительные
        words = ' '.join(messages).lower().split()
        # Фильтруем короткие слова и предлоги
        topics = [w for w in words if len(w) > 4 and w not in 
                 ['чтобы', 'когда', 'который', 'говорить', 'потому', 'сейчас', 'здесь']]
        return list(set(topics))[:5] or ['жизнь', 'работа', 'мечты']
    
    def _extract_memory(self, history: List[Dict]) -> str:
        """Извлечь конкретное воспоминание"""
        user_msgs = [h['content'] for h in history if h['role'] == 'user']
        if user_msgs:
            # Берём что-то конкретное из последних сообщений
            last = user_msgs[-1]
            words = last.split()
            if len(words) > 3:
                return ' '.join(words[:5]) + '...'
        return 'наш разговор'
    
    def _mood_to_text(self) -> str:
        """Преобразовать настроение в текст"""
        mood = self.orch.mood_core.current_mood
        
        if mood.valence > 0.5:
            return random.choice(['весёлое', 'радостное', 'игривое', 'вдохновлённое'])
        elif mood.valence < -0.3:
            return random.choice(['задумчивое', 'меланхоличное', 'уставшее'])
        else:
            return random.choice(['спокойное', 'обычное', 'нейтральное'])


# Тест
if __name__ == "__main__":
    import asyncio
    # from orchestrator import Orchestrator  # УДАЛЕНО: используем Brain v5.0
    from brain_agents_part5_llm import get_brain
    from dialog_memory import DialogMemory
    
    async def test():
        orch = Orchestrator()
        mem = DialogMemory()
        spont = KristinaSpontaneous(orch, mem)
        
        # Тест с реальным user_id
        msg = await spont.should_message('8229806914')
        if msg:
            print(f"📨 Кристина написала:\\n{msg}")
        else:
            print("⏳ Пока рано писать")
    
    asyncio.run(test())
