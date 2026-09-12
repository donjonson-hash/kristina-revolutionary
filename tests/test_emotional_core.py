"""
Test Suite: Emotional Core

Проверяет:
1. EmotionalCore — инициализация, traits, state
2. evolve() — циркадные ритмы, контекст, постепенное восстановление
3. get_emotional_state() — доминантная эмоция, mood description
4. Normalization — границы [0.1, 1.0]
"""

import pytest
from datetime import datetime, timedelta, timezone

from emotional_core import EmotionalCore


class TestEmotionalCoreInit:

    def test_construction(self, emotional_core):
        """EmotionalCore создаётся с 5 traits и 7 state-эмоциями"""
        assert len(emotional_core.traits) == 5
        assert len(emotional_core.state) == 7
        assert emotional_core.last_update is not None

    def test_traits_keys(self, emotional_core):
        """Правильные ключи Big Five"""
        expected = {"extraversion", "neuroticism", "openness",
                     "agreeableness", "conscientiousness"}
        assert set(emotional_core.traits.keys()) == expected

    def test_state_keys(self, emotional_core):
        """Правильные ключи эмоционального состояния"""
        expected = {"energy", "happiness", "curiosity", "anxiety",
                     "loneliness", "creativity", "irritation"}
        assert set(emotional_core.state.keys()) == expected

    def test_traits_values_in_range(self, emotional_core):
        """Все traits в диапазоне [0, 1]"""
        for trait, value in emotional_core.traits.items():
            assert 0 <= value <= 1, f"{trait}={value} вне [0,1]"

    def test_state_values_in_range(self, emotional_core):
        """Все state значения в диапазоне [0, 1]"""
        for emotion, value in emotional_core.state.items():
            assert 0 <= value <= 1, f"{emotion}={value} вне [0,1]"

    def test_recent_experiences_empty(self, emotional_core):
        """Изначально нет опыта"""
        assert emotional_core.recent_experiences == []


class TestCircadianRhythm:

    @pytest.mark.parametrize("hour, direction", [(8, 1), (15, -1), (23, -1)])
    def test_energy_moves_gradually(self, emotional_core, hour, direction):
        start = emotional_core.state["energy"]
        emotional_core._apply_circadian_rhythm(hour, elapsed_hours=1)
        change = emotional_core.state["energy"] - start
        assert change * direction > 0
        assert abs(change) < 0.15

    def test_rest_eases_irritation(self, emotional_core):
        emotional_core.evolve({"negative_tone": True})
        start = emotional_core.state["irritation"]
        emotional_core._apply_circadian_rhythm(12, elapsed_hours=1)
        assert 0.1 < emotional_core.state["irritation"] < start


class TestContextEffects:

    def test_negative_tone_increases_irritation(self, emotional_core):
        """negative_tone=True → irritation +0.2"""
        assert emotional_core.state["irritation"] == 0.1

        emotional_core._apply_context_effects({"negative_tone": True})

        assert emotional_core.state["irritation"] == pytest.approx(0.3)

    def test_positive_tone_no_change(self, emotional_core):
        """positive_tone не влияет"""
        state_before = emotional_core.state.copy()
        emotional_core._apply_context_effects({"positive_tone": True})
        assert emotional_core.state == state_before

    def test_empty_context_no_change(self, emotional_core):
        """Пустой контекст не меняет состояние"""
        state_before = emotional_core.state.copy()
        emotional_core._apply_context_effects({})
        assert emotional_core.state == state_before


class TestTimeBasedEvolution:

    def test_repeated_ticks_without_elapsed_time_do_not_change_emotions(self, emotional_core):
        before = emotional_core.get_emotional_state()
        for _ in range(100):
            assert emotional_core.evolve() == before

    @pytest.mark.parametrize("start", [
        datetime(2026, 9, 5, 18, 17, tzinfo=timezone.utc),
        datetime(2026, 3, 29, 0, 17, tzinfo=timezone.utc),  # Stockholm DST starts
        datetime(2026, 10, 25, 0, 17, tzinfo=timezone.utc),  # Stockholm DST ends
    ])
    def test_tick_frequency_does_not_change_result(self, start):
        now = start
        frequent = EmotionalCore(clock=lambda: now)
        sparse = EmotionalCore(clock=lambda: now)
        for _ in range(24 * 60):
            now += timedelta(minutes=1)
            frequent.evolve()
        assert frequent.state == pytest.approx(sparse.evolve()["state"], abs=1e-12)

    def test_backwards_clock_does_not_repeat_elapsed_time(self):
        now = datetime(2026, 9, 5, 10, tzinfo=timezone.utc)
        core = EmotionalCore(clock=lambda: now)
        before = core.evolve()
        now -= timedelta(hours=1)
        assert core.evolve() == before
        now += timedelta(hours=1)
        assert core.evolve() == before


class TestNormalizeState:

    def test_normalize_clamps_low(self, emotional_core):
        """Значения < 0.1 поднимаются до 0.1"""
        emotional_core.state["energy"] = -0.5
        emotional_core._normalize_state()
        assert emotional_core.state["energy"] == 0.1

    def test_normalize_clamps_high(self, emotional_core):
        """Значения > 1.0 опускаются до 1.0"""
        emotional_core.state["happiness"] = 1.5
        emotional_core._normalize_state()
        assert emotional_core.state["happiness"] == 1.0

    def test_normalize_preserves_middle(self, emotional_core):
        """Значения в [0.1, 1.0] не меняются"""
        emotional_core.state["energy"] = 0.5
        emotional_core._normalize_state()
        assert emotional_core.state["energy"] == 0.5


class TestEvolve:

    def test_evolve_returns_state(self, emotional_core):
        """evolve возвращает dict с state"""
        result = emotional_core.evolve()
        assert "state" in result
        assert "traits" in result
        assert "dominant_emotion" in result

    def test_evolve_updates_last_update(self, emotional_core):
        """evolve обновляет last_update"""
        old_time = emotional_core.last_update
        result = emotional_core.evolve()
        assert emotional_core.last_update >= old_time

    def test_evolve_with_context(self, emotional_core):
        """evolve с negative_tone повышает irritation"""
        irritation_before = emotional_core.state["irritation"]
        emotional_core.evolve({"negative_tone": True})
        assert emotional_core.state["irritation"] >= irritation_before


class TestGetEmotionalState:

    def test_get_emotional_state_structure(self, emotional_core):
        """get_emotional_state возвращает правильную структуру"""
        state = emotional_core.get_emotional_state()
        assert "state" in state
        assert "traits" in state
        assert "dominant_emotion" in state
        assert "dominant_value" in state
        assert "mood_description" in state
        assert "for_llm" in state

    def test_dominant_emotion_is_max(self, emotional_core):
        """dominant_emotion — ключ с максимальным значением"""
        state = emotional_core.get_emotional_state()
        max_emotion = max(emotional_core.state, key=emotional_core.state.get)
        assert state["dominant_emotion"] == max_emotion

    def test_mood_description_high_energy(self, emotional_core):
        """Высокая energy + happiness → энергичная"""
        emotional_core.state["energy"] = 0.9
        emotional_core.state["happiness"] = 0.8
        desc = emotional_core._describe_mood()
        assert "Энергичная" in desc

    def test_mood_description_low_energy(self, emotional_core):
        """Низкая energy → уставшая"""
        emotional_core.state["energy"] = 0.2
        desc = emotional_core._describe_mood()
        assert "Уставшая" in desc

    def test_mood_description_curious(self, emotional_core):
        """Высокая curiosity → любопытная"""
        emotional_core.state["curiosity"] = 0.9
        emotional_core.state["energy"] = 0.6  # чтобы не попасть под другие
        desc = emotional_core._describe_mood()
        assert "Любопытная" in desc

    def test_for_llm_high_energy(self, emotional_core):
        """for_llm включает 'энергичная' при energy > 0.8"""
        emotional_core.state["energy"] = 0.9
        prompt = emotional_core._craft_emotional_prompt()
        assert "энергичная" in prompt
        assert "эмодзи" in prompt

    def test_for_llm_low_energy(self, emotional_core):
        """for_llm включает 'уставшая' при energy < 0.4"""
        emotional_core.state["energy"] = 0.2
        prompt = emotional_core._craft_emotional_prompt()
        assert "уставшая" in prompt
        assert "короткие" in prompt

    def test_for_llm_moderate_energy(self, emotional_core):
        """for_llm — 'естественный тон' при 0.4 <= energy <= 0.8"""
        emotional_core.state["energy"] = 0.6
        prompt = emotional_core._craft_emotional_prompt()
        assert "естественный тон" in prompt


class TestGlobalInstance:

    def test_get_emotional_core_singleton(self):
        """get_emotional_core всегда возвращает один и тот же экземпляр"""
        from emotional_core import get_emotional_core
        core1 = get_emotional_core()
        core2 = get_emotional_core()
        assert core1 is core2


class TestEvolveFullCycle:

    def test_evolve_repeatedly(self, emotional_core):
        """Многократный вызов evolve не падает"""
        for _ in range(10):
            result = emotional_core.evolve({"negative_tone": _ % 2 == 0})
            assert 0.0 <= result["dominant_value"] <= 1.0

    def test_conversation_accumulates_fatigue_and_rest_recovers_it(self):
        now = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)
        core = EmotionalCore(clock=lambda: now)
        for _ in range(15):
            core.evolve({"user_message": True})
        tired = core.state["energy"]
        assert tired < 0.4
        now += timedelta(hours=2)
        rested = core.evolve()["state"]["energy"]
        assert tired < rested < 0.75
