"""Subprocess helper: production singleton wiring, fake external I/O only."""

import asyncio
from datetime import datetime, timezone
import json
import os
import socket
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock


DAY = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)


def no_network(*_args, **_kwargs):
    raise AssertionError("Restart probe cannot access the network")


socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network

import emotional_core
emotional_core.EmotionalCore._now = lambda self: DAY
import bot
from conversation_context import conversation_session_id


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return DAY.astimezone(tz) if tz else DAY.replace(tzinfo=None)


bot.datetime = Clock
bot._autonomy_delay_seconds = lambda: 600
bot.generate_autonomous_message = AsyncMock()
delivery = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
own = conversation_session_id({"channel": "telegram", "user_id": 42, "chat_id": 42})


def event(chat=42):
    return SimpleNamespace(
        effective_user=SimpleNamespace(id=42),
        effective_chat=SimpleNamespace(id=chat, type="private" if chat == 42 else "group"),
        message=SimpleNamespace(text="Привет", reply_text=AsyncMock()),
        callback_query=SimpleNamespace(data="agent_advisor", answer=AsyncMock(), edit_message_text=AsyncMock()),
    )


async def main():
    bot.init_agents()
    if sys.argv[1] == "write":
        await bot.start(event(), None)
        await bot.tts_command(event(), SimpleNamespace(args=["on"]))
        await bot.button_callback(event(), None)
        await bot.button_callback(event(-100), None)
        bot.router.memory.save_exchange(own, "REMEMBER-MERCURY", "Запомнила.", now=DAY, event_id="telegram:1")
        bot.emotional_core.evolve({"user_message": True})
    else:
        bot.restore_telegram_runtime()
        await bot.autonomous_proactive_tick(delivery)
    print("PROBE_JSON=" + json.dumps({
        "pid": os.getpid(),
        "history": bot.router.memory.get_context_for_llm(own),
        "emotions": bot.emotional_core.get_emotional_state(),
        "agents": bot.active_agents, "tts": bot.user_tts_enabled,
        "active_chats": sorted(bot.active_chat_ids),
        "all_due_future": all(due > DAY for due in bot.next_proactive_opportunity.values()),
        "generated": bot.generate_autonomous_message.await_count,
        "sent": delivery.bot.send_message.await_count,
    }, ensure_ascii=False), flush=True)
    # Skip graceful shutdown to ensure all writes are committed at handler boundaries.
    os._exit(0)


asyncio.run(main())
