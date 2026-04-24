"""
Broadcast System - центральная шина событий
"""

import logging
from typing import Dict, List, Callable, Any
from datetime import datetime

logger = logging.getLogger(__name__)

class EventBus:
    """Шина событий для компонентов Кристины"""
    
    def __init__(self):
        self.subscribers: Dict[str, List[Callable]] = {}
        self.event_history: List[Dict] = []
        self.max_history = 50
        
    def subscribe(self, event_type: str, callback: Callable):
        """Подписка на событие"""
        if event_type not in self.subscribers:
            self.subscribers[event_type] = []
        self.subscribers[event_type].append(callback)
        logger.info(f"📡 Подписка на {event_type}: {callback.__name__}")
    
    def unsubscribe(self, event_type: str, callback: Callable):
        """Отписка от события"""
        if event_type in self.subscribers:
            self.subscribers[event_type] = [
                cb for cb in self.subscribers[event_type] if cb != callback
            ]
    
    def publish(self, event_type: str, data: Dict[str, Any] = None):
        """Публикация события"""
        event = {
            "type": event_type,
            "data": data or {},
            "timestamp": datetime.now().isoformat()
        }
        
        # Сохраняем в историю
        self.event_history.append(event)
        if len(self.event_history) > self.max_history:
            self.event_history.pop(0)
        
        # Уведомляем подписчиков
        if event_type in self.subscribers:
            for callback in self.subscribers[event_type]:
                try:
                    callback(event)
                except Exception as e:
                    logger.error(f"❌ Ошибка в обработчике {callback.__name__}: {e}")
        
        logger.info(f"📢 Событие: {event_type}")
    
    def get_recent_events(self, event_type: str = None, limit: int = 10) -> List[Dict]:
        """Получение недавних событий"""
        events = self.event_history
        if event_type:
            events = [e for e in events if e["type"] == event_type]
        return events[-limit:]

# Глобальная шина событий
event_bus = EventBus()

# Типы событий
class Events:
    MOOD_CHANGED = "mood_changed"
    PROACTIVE_SENT = "proactive_sent"
    USER_ACTIVE = "user_active"
    AGENT_SWITCHED = "agent_switched"
    NIGHT_MODE = "night_mode"
    MESSAGE_RECEIVED = "message_received"
