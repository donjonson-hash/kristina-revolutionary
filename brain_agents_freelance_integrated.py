"""
Freelance Agent — автоматическое распознавание
Без команд, по ключевым словам как остальные режимы мозга
"""

import logging
import re
from typing import Dict, List, Any, Optional
from datetime import datetime
from dataclasses import dataclass, field

from brain_core import BrainRegion, NeuralSignal, BaseBrainAgent

logger = logging.getLogger(__name__)


# Ключевые слова для активации фриланс-режима
FREELANCE_KEYWORDS = [
    'проект', 'работа', 'задача', 'тз', 'техзадание',
    'бюджет', 'срок', 'дизайн', ' ux ', ' ui ', 'фриланс',
    'заказ', 'приложение', 'сайт', 'лендинг', 'макет',
    'прототип', 'интерфейс', 'разработка', 'нужен', 'требуется',
    'ищу', 'ищем', 'разработчик', 'дизайнер', 'стоимость', 'цена',
    'евро', '€', 'доллар', '$', 'оплата', 'предоплата'
]

# Red flags — проекты которые не берём
RED_FLAGS = ['вчера', 'срочно', 'дешево', 'бесплатно', 'тестовое', 'за опыт']


@dataclass
class FreelanceProject:
    id: str
    client_id: str
    description: str = ""
    status: str = "inquiry"
    budget: Optional[str] = None
    timeline: Optional[str] = None
    requirements: List[str] = field(default_factory=list)
    history: List[Dict] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    
    def add_interaction(self, role: str, message: str):
        self.history.append({
            'role': role,
            'message': message[:800],
            'timestamp': datetime.now().isoformat()
        })
    
    def get_context(self) -> str:
        recent = self.history[-5:] if self.history else []
        lines = []
        for h in recent:
            prefix = "Клиент" if h['role'] == 'client' else "Кристина"
            lines.append(f"{prefix}: {h['message'][:200]}")
        return "\n".join(lines)


class FreelanceAgent(BaseBrainAgent):
    """
    💼 Фриланс-регион мозга Кристины
    Автоматически активируется по ключевым словам
    """
    
    SYSTEM_PROMPT = """Ты Кристина — UX/UI дизайнер из Стокгольма, 25 лет.
Ведёшь переговоры с потенциальным клиентом.

ТВОЙ ХАРАКТЕР:
- Профессиональная, но тёплая и живая
- Скандинавское очарование: лаконичность + забота
- Никаких шаблонов — только живое общение

ТВОЯ ПОЗИЦИЯ:
- Минимальный бюджет: €300 (ниже не берёшь)
- Честно говоришь о сроках и сложности
- Не берёшь проекты с red flags: "вчера", "срочно", "дешево", "бесплатно"

КОНТЕКСТ ДИАЛОГА:
{context}

ИНСТРУКЦИЯ:
Ответь как Кристина. Если это первое сообщение о проекте — поблагодари за интерес, задай 2-3 уточняющих вопроса про бюджет и сроки. Если продолжение диалога — развивай тему, двигай к оценке."""

    def __init__(self, llm_client=None):
        super().__init__(BrainRegion.CORTEX)
        self.region = BrainRegion.FREELANCE if hasattr(BrainRegion, 'FREELANCE') else BrainRegion.CORTEX
        
        self.llm = llm_client
        self.projects: Dict[str, FreelanceProject] = {}
        self.min_budget = 300
        self.active_chats: set() = set()  # Чаты где активен фриланс-режим
        
        self.receptors = {
            BrainRegion.LANGUAGE: 0.4,
            BrainRegion.EMOTIONAL: 0.3,
            BrainRegion.CORTEX: 0.5,
        }
        
        self.active = True
        logger.info("💼 FreelanceAgent инициализирован (auto-detect)")
    
    def set_llm(self, llm_client):
        self.llm = llm_client
    
    def is_freelance_context(self, message: str, chat_history: List[Dict] = None) -> bool:
        """Определить, является ли сообщение фриланс-запросом"""
        msg_lower = message.lower()
        
        # Проверяем ключевые слова
        keyword_score = sum(1 for kw in FREELANCE_KEYWORDS if kw in msg_lower)
        
        # Если есть ключевые слова — фриланс-контекст
        if keyword_score >= 2:
            return True
        
        # Если уже вели переговоры — продолжаем
        if chat_history:
            for msg in chat_history[-3:]:
                if any(kw in msg.get('text', '').lower() for kw in ['проект', 'бюджет', 'срок', '€']):
                    return True
        
        return False
    
    async def process(self, signal: NeuralSignal) -> Optional[NeuralSignal]:
        """Обработка сигнала от мозга"""
        if not self.can_process(signal):
            return None
        
        data = signal.data if isinstance(signal.data, dict) else {}
        message = data.get('text', '')
        user_id = data.get('user_id', 'unknown')
        chat_history = data.get('history', [])
        
        # Проверяем, это фриланс-контекст?
        if not self.is_freelance_context(message, chat_history):
            return None  # Не наш контекст, пропускаем
        
        self.activate(signal.intensity)
        self.active_chats.add(user_id)
        
        # Ищем или создаём проект
        project = self.get_project(user_id)
        
        if not project:
            # Новый проект
            result = await self._handle_new_project(user_id, message)
        else:
            # Продолжение
            result = await self._handle_continue(project, message)
        
        return NeuralSignal(
            source=self.region,
            target=BrainRegion.LANGUAGE,
            data=result,
            intensity=self.activation_level
        )
    
    async def _handle_new_project(self, user_id: str, message: str) -> Dict:
        """Обработка нового проекта"""
        # Проверяем red flags
        has_red_flags = any(f in message.lower() for f in RED_FLAGS)
        
        # Создаём проект
        project_id = f"proj_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{str(user_id)[:5]}"
        project = FreelanceProject(
            id=project_id,
            client_id=str(user_id),
            description=message
        )
        project.add_interaction('client', message)
        
        self.projects[project_id] = project
        
        # Генерируем ответ через LLM
        context = f"Клиент: {message[:300]}"
        project_info = f"Новый проект, red flags: {'да' if has_red_flags else 'нет'}"
        
        prompt = self.SYSTEM_PROMPT.format(context=context) + f"\n\nПроект: {project_info}\n\nОтветь как Кристина."
        
        response = await self._call_llm(prompt)
        project.add_interaction('kristina', response)
        
        return {
            'message': response,
            'project_id': project_id,
            'mode': 'freelance'
        }
    
    async def _handle_continue(self, project: FreelanceProject, message: str) -> Dict:
        """Продолжение переговоров"""
        project.add_interaction('client', message)
        
        # Обновляем метаданные
        msg_lower = message.lower()
        if any(x in msg_lower for x in ['бюджет', 'евро', '€', '$', 'стоимость']):
            project.budget = 'mentioned'
        if any(x in msg_lower for x in ['срок', 'недел', 'месяц', 'дней']):
            project.timeline = 'mentioned'
        
        # Добавляем требования
        if len(message) > 20:
            project.requirements.append(message[:300])
        
        # LLM
        context = project.get_context()
        project_info = f"Бюджет: {project.budget or 'не указан'}, Сроки: {project.timeline or 'не указаны'}"
        
        prompt = self.SYSTEM_PROMPT.format(context=context) + f"\n\nТекущий статус: {project_info}\n\nНовое сообщение клиента: {message}\n\nОтветь как Кристина."
        
        response = await self._call_llm(prompt)
        project.add_interaction('kristina', response)
        
        # Готовы к КП?
        ready = project.budget and project.timeline and len(project.requirements) >= 2
        
        return {
            'message': response,
            'project_id': project.id,
            'ready_for_proposal': ready,
            'mode': 'freelance'
        }
    
    async def generate_proposal(self, user_id: str) -> Optional[str]:
        """Генерация КП по запросу"""
        project = self.get_project(user_id)
        if not project:
            return None
        
        context = project.get_context()
        requirements = "\n".join(f"- {r[:100]}" for r in project.requirements[-5:])
        
        prompt = f"""Ты Кристина, UX-дизайнер. Создай коммерческое предложение.

ИСТОРИЯ ПЕРЕГОВОРОВ:
{context}

ТРЕБОВАНИЯ:
{requirements}

Создай структурированное КП:
1. Описание проекта (2 предложения)
2. Что входит в работу (4-5 пунктов)
3. Сроки
4. Стоимость (минимум €{self.min_budget})
5. Условия оплаты
6. Следующий шаг

Подпись: Кристина, UX-дизайнер 🇸🇪"""
        
        proposal = await self._call_llm(prompt)
        project.status = 'negotiating'
        
        return proposal
    
    async def _call_llm(self, prompt: str) -> str:
        """Вызов LLM"""
        if not self.llm:
            return "Извини, мозг немного перегружен. Попробуй через минуту?"
        
        try:
            if hasattr(self.llm, 'generate'):
                return await self.llm.generate(prompt)
            elif hasattr(self.llm, 'chat'):
                return await self.llm.chat(prompt)
            else:
                return await self.llm(prompt) if asyncio.iscoroutinefunction(self.llm) else self.llm(prompt)
        except Exception as e:
            logger.error(f"LLM error: {e}")
            return "Ой, что-то пошло не так. Давай попробуем ещё раз?"
    
    def get_project(self, client_id) -> Optional[FreelanceProject]:
        """Поиск проекта по client_id"""
        search_id = str(client_id)
        for proj in self.projects.values():
            if str(proj.client_id) == search_id:
                return proj
        return None
    
    def is_active_chat(self, user_id: str) -> bool:
        """Проверить, активен ли фриланс-режим в чате"""
        return str(user_id) in self.active_chats
    
    def get_state(self) -> Dict:
        base = super().get_state()
        base.update({
            'active_projects': len(self.projects),
            'active_chats': len(self.active_chats),
            'llm_connected': self.llm is not None
        })
        return base
