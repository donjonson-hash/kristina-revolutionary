"""Legacy synchronous event bus compatibility adapter.

New runtime code must use event_bus_v2. This module remains because a few
older synchronous call sites still publish through event_bus. When an asyncio
loop is running, every legacy event is forwarded to EventBusV2 while preserving
the old synchronous callback behaviour.
"""

import logging
from typing import Dict, List, Callable, Any
from datetime import datetime, timezone

from event_bus_v2 import Event, EventTypes, get_event_bus_v2

logger = logging.getLogger(__name__)


class Events:
    """Legacy event names kept for import compatibility."""

    MOOD_CHANGED = "mood_changed"
    PROACTIVE_SENT = "proactive_sent"
    USER_ACTIVE = "user_active"
    AGENT_SWITCHED = "agent_switched"
    NIGHT_MODE = "night_mode"
    MESSAGE_RECEIVED = "message_received"


_CANONICAL_TYPES = {
    Events.MOOD_CHANGED: EventTypes.MOOD_CHANGED,
    Events.PROACTIVE_SENT: EventTypes.PROACTIVE_SENT,
    Events.USER_ACTIVE: EventTypes.USER_ACTIVE,
    Events.AGENT_SWITCHED: EventTypes.AGENT_SWITCHED,
    Events.NIGHT_MODE: EventTypes.NIGHT_MODE,
    Events.MESSAGE_RECEIVED: EventTypes.MESSAGE_RECEIVED,
}


class EventBus:
    """Compatibility facade for the pre-v2 synchronous bus.

    Synchronous subscribers keep their exact legacy contract. In the live async
    runtime, the same event is additionally mirrored to EventBusV2. Outside an
    asyncio loop the legacy callback still works and no background task is
    created.
    """

    def __init__(self, canonical_bus=None):
        self.subscribers: Dict[str, List[Callable]] = {}
        self.event_history: List[Dict] = []
        self.max_history = 50
        self._canonical_bus = canonical_bus

    def subscribe(self, event_type: str, callback: Callable):
        if event_type not in self.subscribers:
            self.subscribers[event_type] = []
        self.subscribers[event_type].append(callback)
        logger.info("Legacy event subscription: %s -> %s", event_type, callback.__name__)

    def unsubscribe(self, event_type: str, callback: Callable):
        if event_type in self.subscribers:
            self.subscribers[event_type] = [
                cb for cb in self.subscribers[event_type] if cb != callback
            ]

    def publish(self, event_type: str, data: Dict[str, Any] = None):
        payload = dict(data or {})
        event = {
            "type": event_type,
            "data": payload,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        self.event_history.append(event)
        if len(self.event_history) > self.max_history:
            self.event_history.pop(0)

        for callback in self.subscribers.get(event_type, []):
            try:
                callback(event)
            except Exception as exc:
                logger.error("Legacy event handler %s failed: %s", callback.__name__, exc)

        canonical_bus = self._canonical_bus or get_event_bus_v2()
        canonical_bus.publish_nowait(
            Event(
                type=_CANONICAL_TYPES.get(event_type, event_type),
                data=payload,
                source="legacy.broadcast",
            )
        )

    def get_recent_events(self, event_type: str = None, limit: int = 10) -> List[Dict]:
        events = self.event_history
        if event_type:
            events = [event for event in events if event["type"] == event_type]
        return events[-limit:]


# Global compatibility instance. New code should call get_event_bus_v2().
event_bus = EventBus()
