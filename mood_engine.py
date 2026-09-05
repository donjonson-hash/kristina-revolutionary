"""Mood and response rhythm derived from Kristina's shared emotional state."""

import random
from enum import Enum
from typing import Dict

from broadcast import event_bus, Events
from emotional_core import get_emotional_core


class MoodState(Enum):
    CALM = "спокойная"
    CURIOUS = "любопытная"
    TIRED = "усталая"


class MoodEngine:
    def __init__(self, emotional_core=None):
        self._core = emotional_core

    @property
    def core(self):
        return self._core if self._core is not None else get_emotional_core()

    @property
    def current_mood(self):
        return self.mood_for(self.core.get_emotional_state())

    def snapshot(self, user_message: bool = False) -> Dict:
        old_mood = self.current_mood
        snapshot = self.core.evolve({"user_message": True} if user_message else None)
        new_mood = self.mood_for(snapshot)
        if new_mood != old_mood:
            event_bus.publish(Events.MOOD_CHANGED, {
                "old_mood": old_mood.value,
                "new_mood": new_mood.value,
                "energy": snapshot["state"]["energy"],
            })
        return snapshot

    def update(self, user_message: bool = True) -> MoodState:
        return self.mood_for(self.snapshot(user_message))

    @staticmethod
    def mood_for(snapshot) -> MoodState:
        state = snapshot["state"]
        if snapshot["is_night"] or state["energy"] < 0.4:
            return MoodState.TIRED
        if state["curiosity"] > 0.7 and state["energy"] > 0.6:
            return MoodState.CURIOUS
        return MoodState.CALM

    def get_mood_prompt(self, snapshot=None) -> str:
        snapshot = snapshot if snapshot is not None else self.core.get_emotional_state()
        prompts = {
            MoodState.CALM: "Ты сейчас спокойная, размеренная. Отвечай тепло, без спешки.",
            MoodState.CURIOUS: "Ты сейчас любопытная, энергичная. Прояви интерес, можешь немного поддразнить. Встречный вопрос уместен, если тебе действительно хочется что-то выяснить.",
            MoodState.TIRED: "Ты сейчас немного устала. Отвечай короче, можешь сказать 'давай продолжим завтра' или 'сейчас не очень могу думать'.",
        }
        return prompts[self.mood_for(snapshot)]

    def get_delay(self, snapshot=None) -> int:
        """Keep noticeable pauses, with jitter inside the state-dependent range."""
        snapshot = snapshot if snapshot is not None else self.core.get_emotional_state()
        if snapshot["is_night"]:
            return random.randint(60, 120)
        delays = {
            MoodState.CALM: (30, 60),
            MoodState.CURIOUS: (15, 30),
            MoodState.TIRED: (45, 90),
        }
        return random.randint(*delays[self.mood_for(snapshot)])

    def get_status(self) -> Dict:
        snapshot = self.snapshot()
        return {
            "mood": self.mood_for(snapshot).value,
            "energy": round(snapshot["state"]["energy"], 2),
            "updated_at": snapshot["updated_at"],
        }


mood_engine = MoodEngine()
