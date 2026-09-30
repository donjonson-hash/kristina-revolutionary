"""A thought comes from the live emotional state, lands in SQLite, and eases creativity."""

from datetime import datetime, timedelta, timezone

import pytest

from creative_life import CreativeDiary, CreativeLife, thought_prompt, time_of_day, validate_thought
from emotional_core import EmotionalCore

DAY = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)
THOUGHT = ("Утро началось с кофе и code review, который я откладывала два дня. "
           "Оказалось, что коллега уже переписал половину модуля, и мои замечания устарели. "
           "Смешно и немного стыдно. Зато теперь понимаю, почему тесты падали только по вторникам ☕")


async def fixed_generate(prompt, system_prompt):
    return THOUGHT


def make(tmp_path, generate=fixed_generate, clock=None):
    core = EmotionalCore(str(tmp_path / "state.db"), clock=clock or (lambda: DAY))
    diary = CreativeDiary(str(tmp_path / "state.db"))
    return core, diary, CreativeLife(core, diary, generate, clock=clock or (lambda: DAY),
                                     choose_theme=lambda: "утро и кофе")


async def test_thought_is_recorded_and_creativity_drops(tmp_path):
    core, diary, life = make(tmp_path)
    before = core.get_emotional_state()["state"]
    result = await life.express()

    assert result["thought"] == THOUGHT
    assert result["state"]["creativity"] == pytest.approx(before["creativity"] - 0.10)
    assert result["state"]["happiness"] == pytest.approx(before["happiness"] + 0.04)
    assert result["state"]["loneliness"] == pytest.approx(before["loneliness"] - 0.03)
    assert core.recent_experiences[-1]["event"] == "creative_expression"

    entries = diary.recent()
    assert len(entries) == 1 and entries[0]["theme"] == "утро и кофе" and entries[0]["thought"] == THOUGHT
    assert entries[0]["published_at"] is None
    assert '"creativity": 0.6' in entries[0]["state_json"]  # state at writing time, before the effect
    assert diary.last_created_at() == DAY


async def test_effect_is_persisted_and_diary_survives_restart(tmp_path):
    core, _, life = make(tmp_path)
    await life.express()
    restarted = EmotionalCore(str(tmp_path / "state.db"), clock=lambda: DAY)
    assert restarted.state["creativity"] == pytest.approx(core.state["creativity"])
    assert len(CreativeDiary(str(tmp_path / "state.db")).recent()) == 1


async def test_provider_fallback_is_never_written_to_the_diary(tmp_path):
    async def apology(prompt, system_prompt):
        return "Блин, что-то с интернетом... Попробуй позже? 😅"

    core, diary, life = make(tmp_path, generate=apology)
    before = core.get_emotional_state()["state"]
    with pytest.raises(ValueError):
        await life.express()
    assert diary.recent() == []
    assert core.get_emotional_state()["state"] == before


async def test_generation_error_leaves_no_trace(tmp_path):
    async def broken(prompt, system_prompt):
        raise RuntimeError("provider down")

    core, diary, life = make(tmp_path, generate=broken)
    before = core.get_emotional_state()["state"]
    with pytest.raises(RuntimeError):
        await life.express()
    assert diary.recent() == [] and core.get_emotional_state()["state"] == before


def test_validate_thought_rejects_short_and_trims_long():
    with pytest.raises(ValueError):
        validate_thought("Коротко.")
    with pytest.raises(ValueError):
        validate_thought(None)
    assert len(validate_thought("х" * 2000)) == 900


def test_prompt_uses_live_state_and_stockholm_time():
    state = {"mood_description": "задумчивая", "state": {"energy": 0.42, "curiosity": 0.8}}
    prompt = thought_prompt("музыка", state, DAY)
    assert "ТЕМА СЕГОДНЯ: музыка" in prompt and "задумчивая" in prompt and "энергия 42%" in prompt
    assert time_of_day(DAY) == "день"                                  # 10:00 UTC = 12:00 Stockholm (CEST)
    assert time_of_day(DAY - timedelta(hours=4)) == "утро"            # 08:00 Stockholm
    assert time_of_day(DAY + timedelta(hours=12)) == "ночь"           # 00:00 Stockholm


async def test_repeated_expression_keeps_lowering_creativity_until_floor(tmp_path):
    core, _, life = make(tmp_path)
    for _ in range(8):
        await life.express()
    assert core.state["creativity"] == pytest.approx(0.1)  # normalized floor, never below
