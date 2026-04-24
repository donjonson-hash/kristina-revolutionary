"""
Event Bus v2 — Расширенная шина событий для нейро-архитектуры Кристины

Возможности:
- Request/Response (синхронный вызов)
- Publish/Subscribe (асинхронные события)  
- Stream processing (потоки событий)
- Targeted delivery (адресная доставка)
"""

import asyncio
import logging
from typing import Dict, List, Callable, Any, Optional, Awaitable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

logger = logging.getLogger(__name__)


class EventPriority(Enum):
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4


@dataclass
class Event:
    """Структура события"""
    type: str
    data: Dict[str, Any] = field(default_factory=dict)
    source: str = "unknown"
    target: Optional[str] = None  # None = broadcast
    priority: EventPriority = EventPriority.NORMAL
    timestamp: datetime = field(default_factory=datetime.now)
    event_id: str = field(default_factory=lambda: f"evt_{datetime.now().timestamp()}")


@dataclass
class Request:
    """Структура запроса (Request/Response pattern)"""
    type: str
    data: Dict[str, Any] = field(default_factory=dict)
    source: str = "unknown"
    timeout: float = 5.0
    request_id: str = field(default_factory=lambda: f"req_{datetime.now().timestamp()}")


@dataclass
class Response:
    """Структура ответа"""
    success: bool
    data: Any = None
    error: Optional[str] = None
    request_id: str = ""


class EventBusV2:
    """
    Расширенная шина событий v2
    
    Поддерживает:
    - async/await события
    - Request/Response паттерн
    - Приоритеты обработки
    - Адресную доставку (target)
    """
    
    def __init__(self):
        # Подписчики на события: event_type -> [(callback, priority)]
        self._subscribers: Dict[str, List[tuple]] = {}
        
        # Обработчики запросов: request_type -> handler
        self._request_handlers: Dict[str, Callable] = {}
        
        # История событий
        self._history: List[Event] = []
        self._max_history = 100
        
        # Статистика
        self._stats = {
            'events_published': 0,
            'requests_processed': 0,
            'errors': 0
        }
        
        logger.info("🚌 Event Bus v2 initialized")
    
    # ========== PUBLISH / SUBSCRIBE ==========
    
    def subscribe(self, event_type: str, callback: Callable[[Event], Awaitable[None]], 
                  priority: EventPriority = EventPriority.NORMAL):
        """Подписка на событие с приоритетом"""
        if event_type not in self._subscribers:
            self._subscribers[event_type] = []
        
        self._subscribers[event_type].append((callback, priority))
        # Сортируем по приоритету (высокий первым)
        self._subscribers[event_type].sort(key=lambda x: x[1].value, reverse=True)
        
        logger.info(f"📡 Подписка: {event_type} -> {callback.__name__} (priority={priority.name})")
    
    def unsubscribe(self, event_type: str, callback: Callable):
        """Отписка от события"""
        if event_type in self._subscribers:
            self._subscribers[event_type] = [
                (cb, prio) for cb, prio in self._subscribers[event_type] if cb != callback
            ]
    
    async def publish(self, event: Event) -> None:
        """
        Публикация события
        
        Если event.target указан — доставляем только целевому агенту
        Если None — broadcast всем подписчикам
        """
        # Сохраняем в историю
        self._history.append(event)
        if len(self._history) > self._max_history:
            self._history.pop(0)
        
        self._stats['events_published'] += 1
        
        # Находим подписчиков
        handlers = self._subscribers.get(event.type, [])
        
        if not handlers:
            logger.debug(f"Нет подписчиков на {event.type}")
            return
        
        # Вызываем обработчиков
        tasks = []
        for callback, priority in handlers:
            # Если указан target — фильтруем
            if event.target and callback.__name__ != event.target:
                continue
            
            tasks.append(self._safe_call(callback, event))
        
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        
        logger.info(f"📢 Event: {event.type} (priority={event.priority.name})")
    
    async def _safe_call(self, callback: Callable, event: Event):
        """Безопасный вызов обработчика"""
        try:
            await callback(event)
        except Exception as e:
            self._stats['errors'] += 1
            logger.error(f"❌ Ошибка в {callback.__name__}: {e}")
    
    # ========== REQUEST / RESPONSE ==========
    
    def register_handler(self, request_type: str, handler: Callable[[Request], Awaitable[Response]]):
        """Регистрация обработчика запросов"""
        self._request_handlers[request_type] = handler
        logger.info(f"🎯 Handler registered: {request_type} -> {handler.__name__}")
    
    async def request(self, request: Request) -> Response:
        """
        Синхронный запрос-ответ
        
        Ждёт ответа от обработчика с таймаутом
        """
        handler = self._request_handlers.get(request.type)
        
        if not handler:
            return Response(
                success=False,
                error=f"No handler for {request.type}",
                request_id=request.request_id
            )
        
        try:
            # Таймаут на выполнение
            result = await asyncio.wait_for(
                handler(request),
                timeout=request.timeout
            )
            
            # Оборачиваем в Response если нужно
            if isinstance(result, dict):
                response = Response(
                    success=True,
                    data=result,
                    request_id=request.request_id
                )
            elif isinstance(result, Response):
                response = result
                response.request_id = request.request_id
            else:
                response = Response(
                    success=True,
                    data=result,
                    request_id=request.request_id
                )
            
            self._stats['requests_processed'] += 1
            return response
            
        except asyncio.TimeoutError:
            return Response(
                success=False,
                error=f"Timeout after {request.timeout}s",
                request_id=request.request_id
            )
        except Exception as e:
            self._stats['errors'] += 1
            return Response(
                success=False,
                error=str(e),
                request_id=request.request_id
            )
    
    # ========== UTILITIES ==========
    
    def get_history(self, event_type: str = None, limit: int = 20) -> List[Event]:
        """Получение истории событий"""
        events = self._history
        if event_type:
            events = [e for e in events if e.type == event_type]
        return events[-limit:]
    
    def get_stats(self) -> Dict:
        """Статистика шины"""
        return self._stats.copy()
    
    def clear_history(self):
        """Очистка истории"""
        self._history.clear()


# Глобальный инстанс
_event_bus_v2: Optional[EventBusV2] = None

def get_event_bus_v2() -> EventBusV2:
    """Получить глобальный Event Bus v2"""
    global _event_bus_v2
    if _event_bus_v2 is None:
        _event_bus_v2 = EventBusV2()
    return _event_bus_v2


# Константы для типов событий (расширенные)
class EventTypes:
    # Мышление
    THOUGHT_REQUEST = "thought:request"
    DECISION_NEEDED = "decision:needed"
    DECISION_MADE = "decision:made"
    
    # Эмоции
    EMOTION_UPDATE = "emotion:update"
    MOOD_CHANGED = "mood:changed"
    
    # Память
    MEMORY_STORE = "memory:store"
    MEMORY_RECALL = "memory:recall"
    
    # Взаимодействие
    MESSAGE_RECEIVED = "message:received"
    RESPONSE_READY = "response:ready"
    
    # Proactive
    PROACTIVE_TRIGGER = "proactive:trigger"
    PROACTIVE_SENT = "proactive:sent"
    
    # Системные
    AGENT_REGISTERED = "agent:registered"
    ERROR_OCCURRED = "error:occurred"


# Константы для запросов
class RequestTypes:
    DECISION_MAKE = "decision:make"
    EMOTION_GET = "emotion:get"
    MEMORY_GET = "memory:get"
    PERSONA_GET = "persona:get"
