import asyncio
from datetime import timezone

from broadcast import EventBus as LegacyEventBus, Events
from event_bus_v2 import Event, EventBusV2, EventTypes


async def test_legacy_publish_keeps_sync_callback_and_forwards_to_v2():
    canonical = EventBusV2()
    seen_legacy = []
    seen_canonical = []
    forwarded = asyncio.Event()

    def legacy_handler(event):
        seen_legacy.append(event)

    async def canonical_handler(event):
        seen_canonical.append(event)
        forwarded.set()

    canonical.subscribe(EventTypes.MOOD_CHANGED, canonical_handler)
    legacy = LegacyEventBus(canonical_bus=canonical)
    legacy.subscribe(Events.MOOD_CHANGED, legacy_handler)

    legacy.publish(Events.MOOD_CHANGED, {"old_mood": "спокойная", "new_mood": "любопытная"})
    await asyncio.wait_for(forwarded.wait(), timeout=0.5)

    assert len(seen_legacy) == 1
    assert seen_legacy[0]["type"] == Events.MOOD_CHANGED
    assert seen_legacy[0]["data"]["new_mood"] == "любопытная"

    assert len(seen_canonical) == 1
    forwarded = seen_canonical[0]
    assert forwarded.type == EventTypes.MOOD_CHANGED
    assert forwarded.source == "legacy.broadcast"
    assert forwarded.data["new_mood"] == "любопытная"
    assert forwarded.timestamp.tzinfo is not None
    assert forwarded.timestamp.utcoffset() == timezone.utc.utcoffset(forwarded.timestamp)


def test_publish_nowait_does_not_create_a_loop_for_sync_callers():
    bus = EventBusV2()
    accepted = bus.publish_nowait(Event(type=EventTypes.USER_ACTIVE))
    assert accepted is False
    assert bus.get_history() == []


def test_event_ids_are_unique_and_utc_aware():
    first = Event(type=EventTypes.MESSAGE_RECEIVED)
    second = Event(type=EventTypes.MESSAGE_RECEIVED)

    assert first.event_id.startswith("evt_")
    assert second.event_id.startswith("evt_")
    assert first.event_id != second.event_id
    assert first.timestamp.tzinfo is not None
    assert first.timestamp.utcoffset() == timezone.utc.utcoffset(first.timestamp)
