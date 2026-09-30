"""Crash the real Telegram -> router -> Persona path after its emotional commit."""

import asyncio
from datetime import datetime, timezone
import importlib
import json
import os
import socket
import sqlite3
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock


DAY = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)
TEXT = "Спасибо за тепло."
mode = sys.argv[1]


def no_network(*_args, **_kwargs):
    raise AssertionError("Crash probe must not contact a provider")


socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network
import emotional_core
emotional_core.EmotionalCore._now = lambda self: DAY
import bot
import agents.kristina_persona as persona
import cognitive_appraisal
from cognitive_appraisal import Appraisal


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return DAY.astimezone(tz) if tz else DAY.replace(tzinfo=None)


bot.datetime = Clock
importlib.import_module("agents.router").datetime = Clock
persona.asyncio = SimpleNamespace(sleep=AsyncMock())
cognitive_appraisal.assess_event = AsyncMock(
    return_value=Appraisal("warmth", 0.5, "тепло", "keep", "", ""))
calls = 0


async def generate(**_kwargs):
    global calls
    calls += 1
    if mode == "crash":
        os._exit(72)  # No cleanup, no dialogue receipt, emotional transaction already committed.
    return "Рада нашему разговору."


persona.ai = SimpleNamespace(generate=generate)


async def main():
    bot.init_agents()
    if mode != "inspect":
        update = SimpleNamespace(
            effective_user=SimpleNamespace(id=42),
            effective_chat=SimpleNamespace(id=42, type="private"),
            message=SimpleNamespace(text=TEXT, message_id=41, reply_text=AsyncMock()),
        )
        await bot.handle_message(update, SimpleNamespace())
    with sqlite3.connect(bot.emotional_core.db_path) as conn:
        receipts = conn.execute("SELECT COUNT(*) FROM emotional_message_events").fetchone()[0]
    print("PROBE_JSON=" + json.dumps({
        "pid": os.getpid(), "state": bot.emotional_core.get_emotional_state()["state"],
        "messages": bot.router.memory.get_stats()["total_messages"],
        "user_events": sum(e["event"] == "user_message" for e in bot.emotional_core.recent_experiences),
        "receipts": receipts, "model_calls": calls,
    }), flush=True)
    bot.router.memory.close()


asyncio.run(main())
