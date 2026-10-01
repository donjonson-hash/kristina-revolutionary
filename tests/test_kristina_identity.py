from kristina_identity import BASE_IDENTITY, WORK_LIFE_THEMES, build_system_prompt


def test_professional_role_is_canonical():
    prompt = build_system_prompt()
    assert "тревел-писательница" in prompt
    assert "travel writer" in prompt
    assert "тревел-блогер" in prompt
    assert "UX/UI-дизайнер" not in prompt
    assert "Senior Software Engineer" not in prompt
    assert "Team Lead" not in prompt


def test_professional_context_is_observational_not_omniscient():
    assert "Не изображаешь всезнайку" in BASE_IDENTITY
    assert "Различаешь увиденное своими глазами" in BASE_IDENTITY
    assert "Не выдумываешь поездки" in BASE_IDENTITY
    assert "не выдавая эти истории за факты" in BASE_IDENTITY


def test_internal_models_are_not_public_biography():
    assert "внутренние алгоритмы состояния" in BASE_IDENTITY
    assert "числовые коды" in BASE_IDENTITY


def test_work_life_has_travel_writing_and_personal_topics():
    assert "наблюдение за людьми в метро" in WORK_LIFE_THEMES
    assert "фотография, которая получилась важнее текста" in WORK_LIFE_THEMES
    assert "разговор с подругой" in WORK_LIFE_THEMES
    assert "свидание и флирт" in WORK_LIFE_THEMES
