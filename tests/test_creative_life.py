"""A thought comes from the live emotional state, lands in SQLite, and eases creativity."""

from datetime import datetime, timedelta, timezone

import pytest

from creative_life import (
    CreativeDiary,
    CreativeLife,
    creative_decision,
    creative_shadow_decision,
    thought_prompt,
    time_of_day,
    validate_thought,
)
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


# --- decision layer and heartbeat wiring -------------------------------------

from autonomy_decision import DecisionEngine, DesireEngine  # noqa: E402

NOON = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)   # 12:00 Stockholm, daytime


def baseline_state(**overrides):
    state = {"energy": 0.75, "happiness": 0.6, "curiosity": 0.8, "anxiety": 0.3,
             "loneliness": 0.4, "creativity": 0.6, "irritation": 0.1}
    state.update(overrides)
    return {"state": state, "is_night": False}


def decide(state, last, now=NOON):
    return creative_decision(state, last, now, DesireEngine(), DecisionEngine())


def test_creative_pressure_builds_with_silence_and_drops_after_writing():
    assert decide(baseline_state(), None).action == "message"                       # nothing written yet
    assert decide(baseline_state(), NOON - timedelta(hours=12)).action == "message"  # half a day of silence
    just_written = baseline_state(creativity=0.5)
    held = decide(just_written, NOON - timedelta(hours=3))
    assert held.action == "none" and held.reason == "impulse_too_weak"


def test_night_cooldown_and_wanting_space_hold_the_impulse():
    night = baseline_state()
    night["is_night"] = True
    assert decide(night, None).reason == "night"
    assert decide(baseline_state(), NOON - timedelta(minutes=30)).reason == "cooldown"
    exhausted = baseline_state(energy=0.15, irritation=0.9, anxiety=0.9)
    assert decide(exhausted, None).reason == "wants_space"


def test_mark_published_is_idempotent(tmp_path):
    diary = CreativeDiary(str(tmp_path / "d.db"))
    entry = diary.record(created_at=DAY, theme="музыка", thought=THOUGHT, emotional_state={"state": {}})
    assert diary.mark_published(entry, at=DAY, target="telegram_channel") is True
    assert diary.mark_published(entry, at=DAY, target="telegram_channel") is False
    row = diary.recent()[0]
    assert row["published_at"] == DAY.isoformat() and row["publish_target"] == "telegram_channel"


async def test_ai_generate_sends_system_and_user_messages():
    from unittest.mock import AsyncMock
    from creative_life import ai_generate
    client = type("C", (), {"chat": AsyncMock(return_value=THOUGHT)})()
    assert await ai_generate(client)("вопрос", "система") == THOUGHT
    messages = client.chat.await_args.args[0]
    assert [m["role"] for m in messages] == ["system", "user"] and messages[1]["content"] == "вопрос"


@pytest.fixture
def heartbeat(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot
    core = EmotionalCore(str(tmp_path / "state.db"), clock=lambda: NOON)
    monkeypatch.setattr(bot, "emotional_core", core)
    monkeypatch.setattr(bot, "active_chat_ids", set())
    monkeypatch.setattr(bot, "creative_life", None)
    monkeypatch.setattr(bot, "_creative_busy", False)
    monkeypatch.setattr(bot, "ai", type("C", (), {"chat": AsyncMock(return_value=THOUGHT)})())
    telegram = AsyncMock()
    return bot, core, telegram


async def test_heartbeat_writes_and_publishes_once_then_holds(heartbeat, monkeypatch):
    bot, core, telegram = heartbeat
    monkeypatch.setenv("KRISTINA_CHANNEL_ID", "-100123")
    state = core.evolve()
    await bot.creative_life_tick(telegram, NOON, state)
    telegram.send_message.assert_awaited_once_with(chat_id="-100123", text=THOUGHT)
    entry = bot.get_creative_life().diary.recent()[0]
    assert entry["publish_target"] == "telegram_channel" and entry["published_at"] is not None
    assert core.state["creativity"] == pytest.approx(0.5)

    # Same minute again: creativity dropped and cooldown holds — no second post.
    await bot.creative_life_tick(telegram, NOON + timedelta(minutes=1), core.evolve())
    telegram.send_message.assert_awaited_once()


async def test_heartbeat_keeps_diary_private_without_channel(heartbeat, monkeypatch):
    bot, core, telegram = heartbeat
    monkeypatch.delenv("KRISTINA_CHANNEL_ID", raising=False)
    await bot.creative_life_tick(telegram, NOON, core.evolve())
    telegram.send_message.assert_not_awaited()
    entry = bot.get_creative_life().diary.recent()[0]
    assert entry["thought"] == THOUGHT and entry["published_at"] is None


async def test_heartbeat_survives_provider_failure_without_trace(heartbeat, monkeypatch):
    from unittest.mock import AsyncMock
    bot, core, telegram = heartbeat
    monkeypatch.setenv("KRISTINA_CHANNEL_ID", "-100123")
    monkeypatch.setattr(bot, "ai", type("C", (), {"chat": AsyncMock(return_value="Ой, я тут задумалась... 💭")})())
    before = core.get_emotional_state()["state"]
    await bot.creative_life_tick(telegram, NOON, core.evolve())
    telegram.send_message.assert_not_awaited()
    assert bot.get_creative_life().diary.recent() == []
    assert core.get_emotional_state()["state"] == before
    assert bot._creative_busy is False


async def test_heartbeat_skips_in_memory_core(heartbeat, monkeypatch):
    bot, _, telegram = heartbeat
    monkeypatch.setattr(bot, "emotional_core", EmotionalCore(clock=lambda: NOON))
    await bot.creative_life_tick(telegram, NOON, bot.emotional_core.evolve())
    telegram.send_message.assert_not_awaited()



def test_creative_shadow_is_observational_only():
    from autonomy_decision import project_organism_modes
    from organism_modes import OrganismModes

    modes = OrganismModes(clock=lambda: NOON)
    modes.set_amplitude("aesthetic_drive", 1.0, at=NOON)
    modes.set_amplitude("creativity_357", 1.0, at=NOON)
    projection = project_organism_modes(modes)
    state = baseline_state(creativity=0.5)
    last = NOON - timedelta(hours=3)
    desires, decisions = DesireEngine(), DecisionEngine()

    baseline = creative_decision(
        state, last, NOON, desires, decisions, organism_projection=projection
    )
    report = creative_shadow_decision(
        state,
        last,
        NOON,
        desires,
        decisions,
        baseline,
        organism_projection=projection,
    )

    assert baseline.action == "none"
    assert baseline.reason == "impulse_too_weak"
    assert report.baseline == baseline
    assert report.shadow.score > baseline.score
    # The counterfactual is returned for telemetry only; the baseline object is unchanged.
    assert baseline.action == "none"


def test_creative_shadow_skips_night_without_counterfactual():
    from autonomy_decision import project_organism_modes
    from organism_modes import OrganismModes

    modes = OrganismModes(clock=lambda: NOON)
    projection = project_organism_modes(modes)
    night = baseline_state()
    night["is_night"] = True
    desires, decisions = DesireEngine(), DecisionEngine()
    baseline = creative_decision(
        night, None, NOON, desires, decisions, organism_projection=projection
    )

    report = creative_shadow_decision(
        night,
        None,
        NOON,
        desires,
        decisions,
        baseline,
        organism_projection=projection,
    )

    assert baseline.reason == "night"
    assert report is None
