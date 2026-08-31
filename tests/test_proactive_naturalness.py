import random

from proactive_naturalness import (
    format_recent_messages,
    is_opening_too_similar,
    next_opportunity_seconds,
    normalize_opening,
    opening_similarity,
)


def test_normalize_opening_ignores_case_and_punctuation():
    assert normalize_opening("Слушай, я тут смотрю на дождь!") == "слушай я тут смотрю на дождь"


def test_repeated_opening_is_detected_without_banning_words():
    recent = [
        "Слушай, я тут смотрела на дождь и внезапно задумалась.",
        "У меня сегодня странно спокойный вечер.",
    ]
    candidate = "Слушай, я тут смотрю на код и он кажется чужим."
    assert is_opening_too_similar(candidate, recent)


def test_different_opening_is_allowed():
    recent = ["Слушай, я тут смотрела на дождь и внезапно задумалась."]
    candidate = "Код недельной давности сегодня выглядит так, будто его писал другой человек."
    assert not is_opening_too_similar(candidate, recent)


def test_similarity_is_based_on_opening_not_exact_message():
    assert opening_similarity(
        "Слушай, я тут смотрю на дождь за окном.",
        "Слушай, я тут смотрю на код после релиза.",
    ) > 0.72


def test_recent_messages_are_bounded():
    messages = [f"message {i}" for i in range(8)]
    formatted = format_recent_messages(messages, limit=3)
    assert "message 4" not in formatted
    assert "message 5" in formatted
    assert "message 7" in formatted


def test_next_opportunity_delay_is_within_range_and_variable():
    rng = random.Random(42)
    values = [next_opportunity_seconds(17, 53, rng=rng) for _ in range(20)]
    assert all(17 * 60 <= value <= 53 * 60 for value in values)
    assert len(set(values)) > 1
