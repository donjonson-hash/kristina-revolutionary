from kristina_identity import BASE_IDENTITY, WORK_LIFE_THEMES, build_system_prompt


def test_professional_role_is_canonical():
    prompt = build_system_prompt()
    assert "Senior Software Engineer" in prompt
    assert "Team Lead" in prompt
    assert "UX-дизайнер" not in prompt


def test_professional_context_is_practical_not_omniscient():
    assert "Не изображаешь всезнайку" in BASE_IDENTITY
    assert "Не выдумывай API" in BASE_IDENTITY
    assert "production-код" in BASE_IDENTITY


def test_work_life_has_engineering_and_personal_topics():
    assert "production-инцидент и его разбор" in WORK_LIFE_THEMES
    assert "сложный code review" in WORK_LIFE_THEMES
    assert "разговор с подругой" in WORK_LIFE_THEMES
    assert "свидание и флирт" in WORK_LIFE_THEMES
