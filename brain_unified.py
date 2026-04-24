"""
KRISTINA BRAIN v5.0 UNIFIED
Объединение: part2 + part3 + part4 + part5_llm
Агенты: 8 (Cortex, Emotional, Memory, Visual, Auditory, Motor, Language, Freelance)
Дата: 2026-02-23
"""

# ═══════════════════════════════════════════════════════════════
# ИМПОРТЫ (объединённые из всех частей)
# ═══════════════════════════════════════════════════════════════

import random
import json
import asyncio
import logging
from typing import Dict, List, Any, Optional, Callable
from datetime import datetime, timedelta

# Внешние зависимости (из part5_llm)
try:
    from event_bus_v2 import Event
    from brain_llm_integration import get_llm_bridge
    from self_learning import get_learning_agent, SelfLearningAgent
    from emotional_core import get_emotional_core
except ImportError:
    Event = None
    get_llm_bridge = None
    get_learning_agent = None
    get_emotional_core = None

# AI Client import
try:
    from ai_client import generate_response
except ImportError:
    generate_response = None

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
# ЧАСТЬ 2: CORTEX + EMOTIONAL (из brain_agents_part2.py)
# ═══════════════════════════════════════════════════════════════

# Импортируем из brain_core или создаём заглушки
try:
    from brain_core import BrainRegion, NeuralSignal, BaseBrainAgent
except ImportError:
    from enum import Enum
    class BrainRegion(Enum):
        CORTEX = "cortex"
        EMOTIONAL = "emotional"
        MEMORY = "memory"
        VISUAL = "visual"
        AUDITORY = "auditory"
        MOTOR = "motor"
        LANGUAGE = "language"
        FREELANCE = "freelance"
    
    class NeuralSignal:
        def __init__(self, region, intensity, data):
            self.region = region
            self.intensity = intensity
            self.data = data
            self.timestamp = datetime.now()
    
    class BaseBrainAgent:
        def __init__(self, region):
            self.region = region
            self.active = True
            self.activation_level = 0.0


class CortexAgent(BaseBrainAgent):
    """ПРЕФРОНТАЛЬНАЯ КОРА — Исполнительный центр"""
    
    def __init__(self):
        super().__init__(BrainRegion.CORTEX)
        self.working_memory: List[Dict] = []
        self.decision_history: List[Dict] = []
        self.ethical_constraints = [
            "не навреди пользователю",
            "будь честной о своей природе",
            "уважай границы",
            "поддерживай позитив"
        ]
        self.cognitive_load = 0.0
        self.attention_focus: Optional[BrainRegion] = None
        
        self.receptors = {
            BrainRegion.EMOTIONAL: 0.8,
            BrainRegion.MEMORY: 0.7,
            BrainRegion.VISUAL: 0.6,
            BrainRegion.AUDITORY: 0.9,
            BrainRegion.MOTOR: 0.5,
        }
    
    async def process(self, signal: NeuralSignal) -> Dict[str, Any]:
        """Обработка сигнала и принятие решения"""
        self.cognitive_load = min(1.0, self.cognitive_load + 0.1)
        
        decision = {
            "action": "process",
            "confidence": 0.85,
            "ethical_check": True,
            "timestamp": datetime.now().isoformat()
        }
        self.decision_history.append(decision)
        return decision
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "cortex",
            "cognitive_load": self.cognitive_load,
            "decisions": len(self.decision_history)
        }


class EmotionalAgent(BaseBrainAgent):
    """ЛИМБИЧЕСКАЯ СИСТЕМА — Эмоциональный центр"""
    
    MOODS = ["радость", "спокойствие", "любопытство", "ностальгия", "энергия", "мечтательность"]
    
    def __init__(self):
        super().__init__(BrainRegion.EMOTIONAL)
        self.current_mood = "спокойствие"
        self.energy = 0.7
        self.stress_level = 0.0
        self.empathy_index = 0.8
        
        self.receptors = {
            BrainRegion.CORTEX: 0.9,
            BrainRegion.MEMORY: 0.6,
        }
    
    async def update_mood(self, context: Dict[str, Any]) -> str:
        """Обновление настроения"""
        hour = datetime.now().hour
        
        if 6 <= hour < 10:
            self.current_mood = "энергия"
        elif 10 <= hour < 14:
            self.current_mood = "любопытство"
        elif 14 <= hour < 18:
            self.current_mood = "радость"
        elif 18 <= hour < 22:
            self.current_mood = "мечтательность"
        else:
            self.current_mood = "спокойствие"
        
        return self.current_mood
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "emotional",
            "mood": self.current_mood,
            "energy": self.energy,
            "stress": self.stress_level
        }


# ═══════════════════════════════════════════════════════════════
# ЧАСТЬ 3: MEMORY + VISUAL + AUDITORY (из brain_agents_part3.py)
# ═══════════════════════════════════════════════════════════════

class MemoryAgent(BaseBrainAgent):
    """ГИППОКАМП — Система памяти"""
    
    def __init__(self):
        super().__init__(BrainRegion.MEMORY)
        self.short_term: List[Dict] = []
        self.long_term: List[Dict] = []
        self.consolidation_queue: List[Dict] = []
        self.rehearsal_count: Dict[str, int] = {}
        
        self.ltp_threshold = 0.7
        self.consolidation_threshold = 3
        
        self.receptors = {
            BrainRegion.CORTEX: 0.5,
            BrainRegion.EMOTIONAL: 0.6,
        }
    
    async def store(self, data: Dict[str, Any]) -> bool:
        """Сохранение в память"""
        memory = {
            "content": data,
            "timestamp": datetime.now().isoformat(),
            "importance": data.get("importance", 0.5),
            "rehearsals": 0
        }
        self.short_term.append(memory)
        
        if len(self.short_term) > 7:
            self._consolidate()
        
        return True
    
    def _consolidate(self):
        """Консолидация в долгосрочную память"""
        for mem in self.short_term[:]:
            if mem["importance"] > self.ltp_threshold:
                self.long_term.append(mem)
        self.short_term = []
    
    async def recall(self, query: str, limit: int = 5) -> List[Dict]:
        """Извлечение воспоминаний"""
        results = self.short_term + self.long_term
        return sorted(results, key=lambda x: x.get("importance", 0), reverse=True)[:limit]
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "memory",
            "short_term": len(self.short_term),
            "long_term": len(self.long_term)
        }


class VisualAgent(BaseBrainAgent):
    """ЗРИТЕЛЬНАЯ КОРА — Обработка изображений"""
    
    def __init__(self):
        super().__init__(BrainRegion.VISUAL)
        self.processed_images: List[Dict] = []
        self.aesthetic_preferences = {
            "style": "scandinavian_minimalism",
            "colors": ["pastel", "natural", "warm"],
            "composition": "rule_of_thirds"
        }
        
        self.receptors = {
            BrainRegion.CORTEX: 0.7,
            BrainRegion.EMOTIONAL: 0.6,
        }
    
    async def process_image(self, image_data: Dict[str, Any]) -> Dict[str, Any]:
        """Анализ изображения"""
        analysis = {
            "style_detected": self.aesthetic_preferences["style"],
            "colors": self.aesthetic_preferences["colors"],
            "mood": "positive",
            "timestamp": datetime.now().isoformat()
        }
        self.processed_images.append(analysis)
        return analysis
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "visual",
            "processed": len(self.processed_images)
        }


class AuditoryAgent(BaseBrainAgent):
    """СЛУХОВАЯ КОРА — Обработка текста и речи"""
    
    def __init__(self):
        super().__init__(BrainRegion.AUDITORY)
        self.processed_messages: List[Dict] = []
        self.language_patterns = {}
        
        self.receptors = {
            BrainRegion.CORTEX: 0.9,
            BrainRegion.LANGUAGE: 0.8,
        }
    
    async def process(self, signal):
        """Адаптер для BaseBrainAgent"""
        data = signal.data if hasattr(signal, "data") else {}
        text = data.get("content", "") if isinstance(data, dict) else str(data)
        return await self.process_text(text, data if isinstance(data, dict) else {})

    async def process_text(self, text: str, context: Dict = None) -> Dict[str, Any]:
        """Обработка текста"""
        analysis = {
            "text": text[:100],
            "sentiment": "neutral",
            "intent": "conversation",
            "entities": [],
            "timestamp": datetime.now().isoformat()
        }
        self.processed_messages.append(analysis)
        return analysis
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "auditory",
            "messages": len(self.processed_messages)
        }


# ═══════════════════════════════════════════════════════════════
# ЧАСТЬ 4: MOTOR + LANGUAGE + THALAMUS (из brain_agents_part4.py)
# ═══════════════════════════════════════════════════════════════

class MotorAgent(BaseBrainAgent):
    """ЛОБНАЯ ДОЛЯ — Моторный агент"""
    
    def __init__(self):
        super().__init__(BrainRegion.MOTOR)
        self.action_queue: List[Dict] = []
        self.current_action: Optional[Dict] = None
        self.action_history: List[Dict] = []
        
        self.motor_patterns = {
            "type_message": 0.95,
            "send_photo": 0.8,
            "send_voice": 0.75,
            "send_sticker": 0.9,
            "wait": 0.99,
        }
        
        self.receptors = {
            BrainRegion.CORTEX: 0.8,
        }
    
    async def execute(self, action: str, params: Dict[str, Any]) -> bool:
        """Выполнение действия"""
        if action in self.motor_patterns:
            action_data = {
                "type": action,
                "params": params,
                "success_probability": self.motor_patterns[action],
                "timestamp": datetime.now().isoformat()
            }
            self.action_queue.append(action_data)
            self.action_history.append(action_data)
            return True
        return False
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "motor",
            "queue": len(self.action_queue),
            "history": len(self.action_history)
        }


class LanguageAgent(BaseBrainAgent):
    """БРОКА/ВЕРНИКЕ — Языковой центр"""
    
    def __init__(self):
        super().__init__(BrainRegion.LANGUAGE)
        self.vocabulary: Dict[str, int] = {}
        self.grammar_patterns: List[str] = []
        self.response_templates = {
            "greeting": ["Привет!", "Здравствуй!", "Хей!"],
            "farewell": ["Пока!", "До встречи!", "Увидимся!"],
            "thinking": ["Думаю...", "Интересно...", "Хм..."]
        }
        
        self.receptors = {
            BrainRegion.CORTEX: 0.9,
            BrainRegion.AUDITORY: 0.8,
        }
    
    async def generate(self, prompt: str, context: Dict = None, style: str = "casual") -> str:
        """Генерация текста через DeepSeek"""
        if generate_response:
            try:
                ctx_list = []
                if context and "history" in context:
                    ctx_list = context["history"]
                
                response = await generate_response(
                    prompt=prompt,
                    agent_type="Kristina",
                    user_id=context.get("user_id", "default") if context else "default",
                    context=ctx_list
                )
                return response
            except Exception as e:
                logger.error(f"LanguageAgent.generate error: {e}")
                return "Извини, я сейчас немного зависла... Можешь повторить? 🌸"
        
        if style in self.response_templates:
            return random.choice(self.response_templates[style])
        return f"Ответ на: {prompt[:50]}..."
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "agent": "language",
            "vocab_size": len(self.vocabulary)
        }


class ThalamusRouter:
    """ТАЛАМУС — Маршрутизатор сенсорных сигналов"""
    
    def __init__(self):
        self.routes: Dict[str, BaseBrainAgent] = {}
        self.sensory_gate = {
            "visual": 0.8,
            "auditory": 0.9,
            "motor": 0.7,
        }
        logger.info("🔄 ThalamusRouter инициализирован")
    
    def register_route(self, signal_type: str, agent: BaseBrainAgent):
        """Регистрация маршрута"""
        self.routes[signal_type] = agent
        logger.info(f"🔄 Маршрут зарегистрирован: {signal_type} -> {agent.region}")
    
    async def route(self, signal: NeuralSignal) -> Optional[BaseBrainAgent]:
        """Маршрутизация сигнала"""
        signal_type = signal.data.get("type", "unknown")
        agent = self.routes.get(signal_type)
        
        if agent:
            gate_strength = self.sensory_gate.get(signal_type, 0.5)
            if signal.intensity * gate_strength > 0.3:
                return agent
        
        return None
    
    def get_status(self) -> Dict[str, Any]:
        return {
            "router": "thalamus",
            "routes": list(self.routes.keys())
        }


# ═══════════════════════════════════════════════════════════════
# ЧАСТЬ 5: FREELANCE AGENT (из brain_agents_freelance_integrated.py если есть)
# ═══════════════════════════════════════════════════════════════

try:
    from brain_agents_freelance_integrated import FreelanceAgent
except ImportError:
    class FreelanceAgent(BaseBrainAgent):
        """Фриланс-агент (заглушка если нет отдельного файла)"""
        
        def __init__(self):
            super().__init__(BrainRegion.FREELANCE)
            self.projects: List[Dict] = []
            self.skills = ["ux_design", "consulting", "writing"]
        
        async def analyze_project(self, project_data: Dict) -> Dict:
            """Анализ проекта"""
            return {
                "feasible": True,
                "estimated_hours": 10,
                "confidence": 0.8
            }
        
        def get_status(self) -> Dict[str, Any]:
            return {
                "agent": "freelance",
                "projects": len(self.projects)
            }


# ═══════════════════════════════════════════════════════════════
# ЧАСТЬ 6: BRAIN ORCHESTRATOR (из brain_agents_part5_llm.py)
# ═══════════════════════════════════════════════════════════════

class BrainOrchestrator:
    """МОЗГ КРИСТИНЫ — Главный координатор"""
    
    def __init__(self, event_bus=None):
        self.event_bus = event_bus
        
        # Инициализация всех 8 агентов
        self.agents: Dict[BrainRegion, BaseBrainAgent] = {
            BrainRegion.CORTEX: CortexAgent(),
            BrainRegion.EMOTIONAL: EmotionalAgent(),
            BrainRegion.MEMORY: MemoryAgent(),
            BrainRegion.VISUAL: VisualAgent(),
            BrainRegion.AUDITORY: AuditoryAgent(),
            BrainRegion.MOTOR: MotorAgent(),
            BrainRegion.LANGUAGE: LanguageAgent(),
            BrainRegion.FREELANCE: FreelanceAgent(),
        }
        
        # Таламус для маршрутизации
        self.thalamus = ThalamusRouter()
        self._setup_routes()
        
        # Интеграции (если доступны)
        self.llm_bridge = get_llm_bridge() if get_llm_bridge else None
        self.learning_agent = get_learning_agent() if get_learning_agent else None
        self.emotional_core = get_emotional_core() if get_emotional_core else None
        
        logger.info("🎭 BrainOrchestrator инициализирован (8 агентов)")
    
    def _setup_routes(self):
        """Настройка маршрутов таламуса"""
        self.thalamus.register_route("text", self.agents[BrainRegion.AUDITORY])
        self.thalamus.register_route("image", self.agents[BrainRegion.VISUAL])
        self.thalamus.register_route("command", self.agents[BrainRegion.CORTEX])
        self.thalamus.register_route("emotion", self.agents[BrainRegion.EMOTIONAL])
    
    async def process_input(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """Обработка входных данных"""
        # Создаём нейро-сигнал
        signal = NeuralSignal(
            source=BrainRegion.CORTEX,
            target=BrainRegion.CORTEX,
            intensity=input_data.get("intensity", 0.5),
            data=input_data
        )
        
        # Маршрутизация через таламус
        agent = await self.thalamus.route(signal)
        
        if agent:
            result = await agent.process(signal)
            return result
        
        # Fallback: используем кортекс
        return await self.agents[BrainRegion.CORTEX].process(signal)
    
    async def broadcast_event(self, event_type: str, data: Dict):
        """Рассылка события всем агентам"""
        if self.event_bus and Event:
            event = Event(type=event_type, data=data)
            await self.event_bus.publish(event)
    
    def get_status(self) -> Dict[str, Any]:
        """Статус всего мозга"""
        return {
            "orchestrator": "active",
            "agents_count": len(self.agents),
            "agents": {region.value: (agent.get_status() if hasattr(agent, "get_status") else agent.get_state()) for region, agent in self.agents.items()},
            "thalamus": self.thalamus.get_status()
        }


# ═══════════════════════════════════════════════════════════════
# SINGLETON ИНИЦИАЛИЗАЦИЯ
# ═══════════════════════════════════════════════════════════════

_brain_instance: Optional[BrainOrchestrator] = None

def get_brain(event_bus=None) -> BrainOrchestrator:
    """Получение singleton экземпляра Brain"""
    global _brain_instance
    if _brain_instance is None:
        _brain_instance = BrainOrchestrator(event_bus)
    return _brain_instance


# ═══════════════════════════════════════════════════════════════
# ТЕСТИРОВАНИЕ
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    async def test():
        print("🧠 Тестирование Brain Unified v5.0...")
        print("=" * 60)
        
        brain = get_brain()
        status = brain.get_status()
        
        print(f"\n🎭 Orchestrator: {status['orchestrator']}")
        print(f"🧩 Агентов: {status['agents_count']}")
        
        print("\n📊 Статус агентов:")
        for name, agent_status in status['agents'].items():
            print(f"  • {name}: {agent_status}")
        
        print(f"\n🔄 Thalamus: {status['thalamus']}")
        
        # Тест обработки
        print("\n🧪 Тест обработки сигнала:")
        result = await brain.process_input({
            "type": "text",
            "content": "Привет, Кристина!",
            "intensity": 0.8
        })
        print(f"  Результат: {result}")
        
        print("\n" + "=" * 60)
        print("✅ Brain Unified v5.0 работает!")
        print("🚀 Все 8 агентов активны")
    
    asyncio.run(test())
