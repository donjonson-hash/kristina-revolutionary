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
 AgentRouter
   │
 KristinaPersonaAgent
   │
 BrainBridge
   ├── cognitive_appraisal.py
   ├── emotional_core.py
   └── persistent_memory.py
             │
      autonomy_decision.py
       ├── proactive message / silence
       └── creative_life.py → diary / channel
```

Новый runtime-код использует `event_bus_v2.py` как единственную событийную
шину. `broadcast.py` оставлен временным compatibility-адаптером. Старые
`autonomous_life.py` и `proactive_messaging.py` не подключаются к production.

Подробная карта живого runtime и legacy-границы:
[RUNTIME_ARCHITECTURE.md](RUNTIME_ARCHITECTURE.md).

Ключевые модули:

| Модуль | Назначение |
|---|---|
| `brain_unified.py` | Мозг: 8 агентов + оркестратор |
| `cognitive_appraisal.py` | Оценка событий → эмоциональная реакция |
| `organism_modes.py` | Persistent-поле из 12 медленных внутренних мод; обучается от валидированных событий |
| `shadow_telemetry.py` | Долговечная SQLite-телеметрия baseline vs shadow решений без текста переписки |
| `dialogue_state.py` | Диалоговая модель: эпизоды, вопросы, паузы |
| `persistent_memory.py` | Долговременная память (SQLite/Postgres) |
| `autonomy_decision.py` + `creative_life.py` | Решение действовать/молчать и творческий жизненный цикл |
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
