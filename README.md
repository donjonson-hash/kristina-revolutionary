# Kristina AI Agent

Автономный ИИ-агент с эмоциональным ядром, постоянной памятью и проактивной
инициативой. Основной приоритет: мозг и личность Кристины в Telegram-боте
[@krististigai_bot](https://t.me/krististigai_bot).

Сверка документов является отдельным проектом; её код и проверки в этом
репозитории сохраняются независимо от Telegram-бота. Scout также сохраняется.
Старые Mobile API, Flutter-приложение, mini-app и веб-панель выведены из
эксплуатации на уровне исходного кода; границы и ограничения описаны в
[LEGACY_RETIREMENT.md](LEGACY_RETIREMENT.md).

## Архитектура

```
Telegram
        │
   bot.py
        │
   ┌────┴─────────────────────────────────────┐
   │              Brain v5.0                  │
   │  8 агентов: Cortex · Emotional · Memory  │
   │  Visual · Auditory · Motor · Language ·  │
   │  Freelance, маршрутизация — ThalamusRouter
   └────┬──────────────┬──────────────────────┘
        │              │
  emotional_core.py  persistent_memory.py
  mood_engine.py     (SQLite / PostgreSQL)
  cognitive_appraisal.py
        │
  autonomous_life.py — жизненный цикл 24/7:
  эмоции → обучение (Perplexity) → мысль →
  пост с фото (Kling) → дневник
```

Ключевые модули:

| Модуль | Назначение |
|---|---|
| `brain_unified.py` | Мозг: 8 агентов + оркестратор |
| `cognitive_appraisal.py` | Оценка событий → эмоциональная реакция |
| `dialogue_state.py` | Диалоговая модель: эпизоды, вопросы, паузы |
| `persistent_memory.py` | Долговременная память (SQLite/Postgres) |
| `autonomous_life.py` | Автономный жизненный цикл агента |
| `self_learning.py` | Самообучение через Perplexity API |
| `avatar_platform/` | Фабрика цифровых двойников (Big Five, профессии) |
| `trend_collector.py` + `agents/trend_scout.py` | Разведка трендов с отчётами |
| `reconcile_lists.py` + `extension/` | Сверка документов (CSV/PDF/XLSX) |

## Быстрый старт

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # заполнить ключи
python bot.py          # Telegram-бот
```

См. `DEPLOY.md` (systemd, Timeweb). Удаление старых интерфейсов из Git само
по себе не останавливает ранее установленные серверные процессы.

## Тесты

```bash
python -m pytest tests/ -q
```

Документация по поведению: `DIALOGUE_MODEL.md`, `EMOTIONAL_RHYTHM.md`,
`INTENTION_CYCLE.md`, `COGNITIVE_APPRAISAL.md`.

## Требования

- Python 3.11+
- Ключи: `DEEPSEEK_API_KEY`, `KRISTINA_TELEGRAM_TOKEN` (обязательные),
  `KIMI_API_KEY` / `OPENAI_API_KEY` / `PERPLEXITY_API_KEY` / `ELEVENLABS_API_KEY`
  (опционально по функциям)
- PostgreSQL (опционально; по умолчанию SQLite)

## Лицензия

Apache-2.0 (см. LICENSE)
