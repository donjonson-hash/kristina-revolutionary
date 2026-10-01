from kristina_identity import BASE_IDENTITY, WORK_LIFE_THEMES, build_system_prompt


def test_professional_role_is_canonical():
    prompt = build_system_prompt()
    assert "UX/UI-дизайнер" in prompt
    assert "product designer" in prompt
    assert "Senior Software Engineer" not in prompt
    assert "Team Lead" not in prompt


def test_professional_context_is_practical_not_omniscient():
    assert "Не изображаешь всезнайку" in BASE_IDENTITY
    assert "не выдаёшь себя за software engineer" in BASE_IDENTITY
    assert "Не выдумывай API" in BASE_IDENTITY
    assert "доступности" in BASE_IDENTITY


def test_internal_models_are_not_public_biography():
    assert "внутренние алгоритмы состояния" in BASE_IDENTITY
    assert "числовые коды" in BASE_IDENTITY


def test_work_life_has_design_and_personal_topics():
    assert "сложный design review" in WORK_LIFE_THEMES
    assert "прототип, который пришлось упростить" in WORK_LIFE_THEMES
    assert "разговор с подругой" in WORK_LIFE_THEMES
    assert "свидание и флирт" in WORK_LIFE_THEMES
