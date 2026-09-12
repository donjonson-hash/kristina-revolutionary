"""Boundaries around model interpretations: source, effects, cost and failures."""

import asyncio
import json
from dataclasses import asdict, replace
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cognitive_appraisal import Appraisal, assess_event, cognitive_context


SOURCE = "Хочу уехать примерно 12.10.2026 и сменить обстановку."
INTEREST = Appraisal("curiosity", 0.5, "сменить обстановку", "replace",
                    "Перемены", "Мне тоже интересно найти время для смены обстановки.")


@pytest.mark.parametrize("change", [
    {"source_quote": "Я уже забронировал отель"},
    {"source_quote": ""},
    {"source_quote": " "},
    {"reaction": "love"},
    {"reaction": ["curiosity"]},
    {"intensity": True},
    {"intensity": float("nan")},
    {"intensity": float("inf")},
    {"intensity": 100},
    {"interest_action": "execute"},
    {"topic": ""},
    {"reflection": "x" * 401},
    {"reaction": "neutral", "intensity": 0.5},
    {"interest_action": "keep"},
    {"verified_booking": True},
])
def test_invalid_or_unsupported_interpretation_is_rejected(change):
    payload = asdict(INTEREST) | change
    with pytest.raises(ValueError):
        Appraisal.parse(json.dumps(payload), SOURCE)


def test_assistant_claim_is_not_accepted_as_current_user_evidence():
    with pytest.raises(ValueError):
        Appraisal.parse(json.dumps(asdict(replace(INTEREST, source_quote="Бронь оплачена"))),
                        "Вот ссылка на жильё")


@pytest.mark.parametrize("reaction", ["curiosity", "warmth", "concern", "frustration", "neutral"])
def test_emotional_effects_are_small_even_at_maximum_intensity(reaction):
    appraisal = replace(INTEREST, reaction=reaction, intensity=0 if reaction == "neutral" else 1)
    assert all(abs(change) <= 0.08 for change in appraisal.effects().values())


@pytest.mark.parametrize("result", [json.dumps(asdict(INTEREST)), "provider error", "```json\n{}\n```", "{}"]) 
async def test_one_call_no_retry_and_client_closed(monkeypatch, result):
    import cognitive_appraisal as module
    client = SimpleNamespace(chat=AsyncMock(return_value=result), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    received = await assess_event(SOURCE, [], None)
    assert received == (INTEREST if result.startswith('{"reaction"') else None)
    client.chat.assert_awaited_once()
    client.close.assert_awaited_once()
    assert client.chat.call_args.kwargs["max_tokens"] == 600


async def test_timeout_is_bounded_and_does_not_retry(monkeypatch):
    import cognitive_appraisal as module
    client = SimpleNamespace(chat=AsyncMock(), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    timeouts = []
    async def timeout(coro, *, timeout):
        timeouts.append(timeout)
        coro.close()
        raise TimeoutError
    monkeypatch.setattr(module, "asyncio", SimpleNamespace(wait_for=timeout))
    assert await assess_event(SOURCE, [], None) is None
    assert timeouts == [20]
    assert client.chat.call_count == 1
    client.close.assert_awaited_once()


async def test_external_cancellation_is_not_swallowed(monkeypatch):
    import cognitive_appraisal as module
    client = SimpleNamespace(chat=AsyncMock(side_effect=asyncio.CancelledError), close=AsyncMock())
    monkeypatch.setattr(module, "get_ai_client", lambda: client)
    with pytest.raises(asyncio.CancelledError):
        await assess_event(SOURCE, [], None)
    client.close.assert_awaited_once()


def test_context_labels_interpretations_questions_and_actual_date():
    now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
    context = cognitive_context(INTEREST.interest(None, now), [
        {"role": "assistant", "content": "Когда летишь?"},
        {"role": "user", "content": "12 октября"},
    ], now)
    assert "2026-09-12T14:00:00+02:00" in context
    assert "Когда летишь?" in context
    assert "user_report" in context
    assert "интерпретация" in context
    assert "не подтверждает бронь" in context
    assert "Мне тоже интересно" in context
