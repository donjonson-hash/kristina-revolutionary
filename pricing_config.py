"""
Реальное ценообразование UX-дизайнера (Стокгольм/Европа)
Цены актуальны на 2026 год
"""

# Базовые ставки (евро/час)
HOURLY_RATES = {
    "research": 85,      # Исследования, интервью
    "ux_design": 95,     # Проектирование, прототипы
    "ui_design": 90,     # Визуальный дизайн
    "consulting": 110,   # Консультации, стратегия
}

# Фиксированные пакеты (евро)
PACKAGES = {
    "mvp": {
        "name": "MVP Design",
        "price_range": (3500, 5500),
        "hours": (40, 60),
        "includes": [
            "Базовое исследование (5 интервью)",
            "User Journey Map",
            "Прототип ключевых сценариев",
            "UI-кит (20+ компонентов)",
            "10-15 экранов",
        ],
        "timeline": "3-4 недели"
    },
    
    "standard": {
        "name": "Standard Project",
        "price_range": (8000, 12000),
        "hours": (80, 120),
        "includes": [
            "Глубокое исследование (10+ интервью)",
            "Полная информационная архитектура",
            "Интерактивный прототип",
            "Полный UI-кит (50+ компонентов)",
            "30-50 экранов",
            "Дизайн-система",
            "Спецификация для разработчиков",
        ],
        "timeline": "6-9 недель"
    },
    
    "premium": {
        "name": "Premium/Complex",
        "price_range": (15000, 25000),
        "hours": (150, 250),
        "includes": [
            "Всё из Standard +",
            "Многоплатформенный дизайн (iOS, Android, Web)",
            "Сложные интерактивные прототипы",
            "Анимации и микровзаимодействия",
            "Дизайн под брендинг",
            "Поддержка при разработке",
        ],
        "timeline": "10-16 недель"
    }
}

# Дополнительные опции (евро)
ADDONS = {
    "branding": (2000, 5000),      # Разработка фирменного стиля
    "illustrations": (500, 1500),   # Кастомные иллюстрации
    "animation": (1000, 3000),      # Сложные анимации
    "dev_support": (150, 250),      # Поддержка разработки (€/час)
    "workshops": (800, 1500),       # Дизайн-воркшопы
}

# Региональные коэффициенты
REGION_MULTIPLIERS = {
    "sweden": 1.0,        # База - Стокгольм
    "norway": 1.15,       # +15%
    "germany": 0.9,       # -10%
    "uk": 1.05,           # +5%
    "remote_cis": 0.6,    # -40% (удалёнка СНГ)
    "usa": 1.3,           # +30%
}

def calculate_price(project_type: str, complexity: str = "medium", region: str = "sweden") -> dict:
    """
    Расчёт реальной стоимости проекта
    
    Args:
        project_type: "mvp", "standard", "premium"
        complexity: "low", "medium", "high"
        region: ключ из REGION_MULTIPLIERS
    
    Returns:
        dict с ценой, сроками, составом работ
    """
    if project_type not in PACKAGES:
        project_type = "standard"
    
    package = PACKAGES[project_type]
    base_min, base_max = package["price_range"]
    
    # Коэффициент сложности
    complexity_mult = {
        "low": 0.85,
        "medium": 1.0,
        "high": 1.25
    }.get(complexity, 1.0)
    
    # Региональный коэффициент
    region_mult = REGION_MULTIPLIERS.get(region, 1.0)
    
    # Итоговая цена
    final_min = int(base_min * complexity_mult * region_mult)
    final_max = int(base_max * complexity_mult * region_mult)
    
    return {
        "price_range": (final_min, final_max),
        "timeline": package["timeline"],
        "includes": package["includes"],
        "hourly_estimate": package["hours"]
    }

def format_price_quote(project_analysis: dict) -> str:
    """
    Форматирование ценового предложения
    """
    # Определяем тип проекта по объёму текста/сложности
    text_length = len(project_analysis.get("text", ""))
    
    if text_length < 2000:
        project_type = "mvp"
        complexity = "low"
    elif text_length < 5000:
        project_type = "standard"
        complexity = "medium"
    else:
        project_type = "premium"
        complexity = "high"
    
    pricing = calculate_price(project_type, complexity)
    
    price_min, price_max = pricing["price_range"]
    
    quote = f"""💰 **Оценка проекта:**

**Стоимость:** {price_min:,} - {price_max:,} €
**Сроки:** {pricing["timeline"]}
**Ориентировочно:** {pricing["hourly_estimate"][0]}-{pricing["hourly_estimate"][1]} часов работы

**Что входит:**
"""
    for item in pricing["includes"]:
        quote += f"\n• {item}"
    
    quote += f"""

**Условия оплаты:**
• 40% — предоплата
• 30% — после утверждения прототипа  
• 30% — после финальной сдачи

Цена фиксирована, изменения по согласованию."""
    
    return quote
