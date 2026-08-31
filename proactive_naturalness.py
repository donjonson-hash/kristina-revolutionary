"""Utilities that keep Kristina's proactive messages varied and unscheduled-looking."""

from __future__ import annotations

from difflib import SequenceMatcher
import random
import re
from typing import Iterable, Optional


def normalize_opening(text: str, words: int = 8) -> str:
    """Return a normalized opening fragment suitable for repetition checks."""
    cleaned = re.sub(r"[^\w\s]+", " ", text.lower(), flags=re.UNICODE)
    tokens = [token for token in cleaned.split() if token]
    return " ".join(tokens[:words])


def opening_similarity(left: str, right: str) -> float:
    """Compare message openings without banning any particular phrase."""
    left_opening = normalize_opening(left)
    right_opening = normalize_opening(right)
    if not left_opening or not right_opening:
        return 0.0
    return SequenceMatcher(None, left_opening, right_opening).ratio()


def is_opening_too_similar(candidate: str, recent_messages: Iterable[str], threshold: float = 0.72) -> bool:
    """Detect a repeated syntactic opening across recent proactive messages."""
    return any(opening_similarity(candidate, previous) >= threshold for previous in recent_messages)


def format_recent_messages(recent_messages: Iterable[str], limit: int = 5) -> str:
    recent = list(recent_messages)[-limit:]
    if not recent:
        return "нет предыдущих сообщений"
    return "\n".join(f"- {message}" for message in recent)


def next_opportunity_seconds(
    minimum_minutes: int = 17,
    maximum_minutes: int = 53,
    rng: Optional[random.Random] = None,
) -> int:
    """Return a genuinely variable delay between autonomous decision opportunities."""
    if minimum_minutes < 1 or maximum_minutes < minimum_minutes:
        raise ValueError("invalid autonomy opportunity range")
    source = rng or random
    return source.randint(minimum_minutes * 60, maximum_minutes * 60)
