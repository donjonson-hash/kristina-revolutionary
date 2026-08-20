# 📈 TrendScout — агент разведки рынка

[![CI](https://github.com/donjonson-hash/kristina-revolutionary/actions/workflows/ci.yml/badge.svg)](https://github.com/donjonson-hash/kristina-revolutionary/actions/workflows/ci.yml)

Агент собирает информацию об **актуальных запросах пользователей** из открытых
источников и на её основе предлагает **идеи монетизируемых стартапов**.

## Как это работает

```
Открытые источники          Анализ                  Результат
┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────────┐
│ Hacker News       │   │                  │   │ 🔥 Топ запросов         │
│ (топ + Ask HN)    │──▶│  DeepSeek LLM    │──▶│ 💡 Идеи стартапов       │
│ Reddit            │   │  кластеризация   │   │    + модель монетизации │
│ (r/SomebodyMake…) │   │  спроса и боли   │   │    + план MVP           │
│ GitHub            │   │                  │   │ 📊 Вывод                │
│ (растущие репо)   │   └──────────────────┘   └─────────────────────────┘
└──────────────────┘
```

1. **Сбор** (`trend_collector.py`) — параллельный опрос источников без API-ключей:
   - Hacker News (Algolia API): популярные истории и Ask HN за неделю;
   - Reddit (публичный JSON): топ недели из r/SomebodyMakeThis, r/startups,
     r/Entrepreneur, r/SaaS, r/sidehustle — там пользователи прямо формулируют
     запросы и боли;
   - GitHub (Search API): репозитории, созданные за последний месяц и быстро
     набирающие звёзды — индикатор спроса разработчиков.
2. **Анализ** (`trend_analyzer.py`) — LLM (DeepSeek) кластеризует сигналы в
   запросы/боли и генерирует 3–5 идей стартапов с моделью монетизации,
   планом MVP и рисками. Без `DEEPSEEK_API_KEY` возвращается сырой дайджест.
3. **Отчёт** — Markdown + JSON с сырыми сигналами в `data/trend_reports/`.

## Использование

### Standalone (CLI)

```bash
python run_trend_scout.py                        # общий обзор трендов
python run_trend_scout.py --topic "ai agents"    # фокус на теме
python run_trend_scout.py --raw                  # без LLM, только дайджест
python run_trend_scout.py --limit 25 --no-save   # больше сигналов, без записи
```

### В Telegram-боте

- `/trends` — общий обзор запросов и идей;
- `/trends нейросети для юристов` — исследование по теме;
- `/agent` → 📈 TrendScout — переключиться на агента: любое сообщение
  с ключевыми словами («стартап», «ниша», «монетизация», «спрос»…)
  запустит исследование.

### Из кода

```python
from agents.trend_scout import TrendScoutAgent

scout = TrendScoutAgent()
result = await scout.run_research(topic="ai agents")
print(result["report"])          # Markdown-отчёт
print(result["signals_count"])   # сколько сигналов собрано
print(result["report_path"])     # путь к сохранённому отчёту
```

## Настройка

- `DEEPSEEK_API_KEY` в `.env` — для LLM-анализа (иначе — режим сырого дайджеста);
- список сабреддитов: `DEFAULT_SUBREDDITS` в `trend_collector.py`
  или `TrendCollector(subreddits=[...])`;
- формат отчёта: `ANALYSIS_SYSTEM_PROMPT` в `trend_analyzer.py`.

## Устойчивость

- падение любого источника (403 от Reddit из дата-центра, rate-limit GitHub)
  не ломает сбор — остальные источники продолжают работать;
- при недоступности LLM агент возвращает дайджест сильнейших сигналов;
- таймаут каждого запроса — 15 секунд.

## Тесты

```bash
pytest tests/test_trend_scout.py -v
```

Тесты офлайновые: сеть и LLM подменяются фейками.
