"""
Test Suite: Emotional Core

Проверяет:
1. EmotionalCore — инициализация, traits, state
2. evolve() — циркадные ритмы, контекст, флуктуации
3. get_emotional_state() — доминантная эмоция, mood description
4. Normalization — границы [0.1, 1.0]
"""

import pytest
import random
from datetime import datetime
from unittest.mock import patch

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

    def test_morning_boost(self, emotional_core):
        """Утро (6-10): energy +0.15, curiosity +0.1"""
        start_energy = emotional_core.state["energy"]
        start_curiosity = emotional_core.state["curiosity"]

        emotional_core._apply_circadian_rhythm(8)

        assert emotional_core.state["energy"] == pytest.approx(start_energy + 0.15)
        assert emotional_core.state["curiosity"] == pytest.approx(start_curiosity + 0.1)

    def test_afternoon_slump(self, emotional_core):
        """Послеобед (14-17): energy -0.08"""
        start_energy = emotional_core.state["energy"]
        emotional_core._apply_circadian_rhythm(15)
        assert emotional_core.state["energy"] == pytest.approx(start_energy - 0.08)

    def test_evening_loneliness(self, emotional_core):
        """Вечер (17-22): loneliness +0.1"""
        start_loneliness = emotional_core.state["loneliness"]
        emotional_core._apply_circadian_rhythm(20)
        assert emotional_core.state["loneliness"] == pytest.approx(start_loneliness + 0.1)

    def test_night_decline(self, emotional_core):
        """Ночь (0-6, 22-24): energy -0.15"""
        start_energy = emotional_core.state["energy"]
        emotional_core._apply_circadian_rhythm(23)
        assert emotional_core.state["energy"] == pytest.approx(start_energy - 0.15)

    def test_no_change_between_periods(self, emotional_core):
        """10-14 и 17-17 (границы): нет специальных изменений кем-то, кроме флуктуаций"""
        state_before = emotional_core.state.copy()
        emotional_core._apply_circadian_rhythm(12)  # 12:00 — нет спец-правил
        state_after = emotional_core.state.copy()

        # При 12:00 ни один if не сработает, поэтому всё должно совпадать
        assert state_before == state_after


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


class TestRandomFluctuations:

    def test_random_fluctuations_all_emotions(self, emotional_core):
        """_apply_random_fluctuations меняет все 7 emotions"""
        state_before = emotional_core.state.copy()

        with patch("random.uniform", return_value=0.03):
            emotional_core._apply_random_fluctuations()

        for emotion in state_before:
            assert emotional_core.state[emotion] == pytest.approx(
                state_before[emotion] + 0.03
            )

    def test_fluctuation_range(self, emotional_core):
        """Изменение не выходит за [-0.05, +0.05] после нормализации"""
        emotional_core._apply_random_fluctuations()

        for emotion in emotional_core.state:
            assert -0.05 <= emotional_core.state[emotion] - 0.0 <= 0.05


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

    def test_evolve_twice_with_morning(self, emotional_core):
        """Ручная установка часа: утренний boost дважды"""
        with patch("emotional_core.datetime") as mock_dt:
            mock_dt.now.return_value.hour = 8
            result1 = emotional_core.evolve()
            result2 = emotional_core.evolve()
            # Энергия растёт (но не выходит за границу из-за нормализации)
            assert result2["state"]["energy"] >= result1["state"]["energy"] - 0.1
