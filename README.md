# Kristina AI Agent

Автономный ИИ-агент с эмоциональным ядром, постоянной памятью и проактивной
инициативой. Основной приоритет: мозг и личность Кристины в Telegram-боте
[@krististigai_bot](https://t.me/krististigai_bot).

Репозиторий содержит несколько независимых продуктов. Для разработки и аудита
Compare These Texts используйте каталог `ctt/`.

| Компонент | Исходники и документация | Статус |
|---|---|---|
| Кристина | `bot.py`, `agents/`, [RUNTIME_ARCHITECTURE.md](RUNTIME_ARCHITECTURE.md) | Telegram-бот; развёртывается на Timeweb |
| Compare These Texts (CTT) | `ctt/src/`, [ctt/README.md](ctt/README.md) | Актуальная линия сайта и расширения, восстановленная из исходников 0.33.6; `ctt/dist/` создаётся сборкой |
| Историческая сверка документов | `extension/`, `static/reconciliation/`, `reconciliation_web.py`, `reconcile_lists.py`, [extension/README.md](extension/README.md) | Сохранённая версия расширения 0.18.1 и локальный Python-интерфейс; отдельные проверки |
| Scout | `scout/`, [scout/README.md](scout/README.md) | Локальный прототип 0.4.1: расширение и Express backend |

Общая ссылка на Git-репозиторий включает все эти компоненты. При проверке релиза
CTT фиксируйте также коммит, версию и контрольную сумму собранного ZIP:
исторический сборщик `scripts/build_reconciliation_extension.py` выпускает 0.18.1.

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

Административная read-only сводка shadow telemetry доступна в Telegram:
`/shadow 24h`, `/shadow 7d` или `/shadow all`. Команда доступна только
пользователям из `KRISTINA_ADMIN_IDS` и не влияет на решения агента.

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
| `ctt/src/` | Compare These Texts: сайт и расширение |
| `reconcile_lists.py` + `extension/` | Историческая сверка документов (CSV/PDF/XLSX) |

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

Сборка и проверки актуального CTT:

```bash
cd ctt
npm ci --ignore-scripts
npm run build
npm test
npm run check
```

Для Scout и исторического расширения команды приведены в их README выше.

Документация по поведению: `DIALOGUE_MODEL.md`, `EMOTIONAL_RHYTHM.md`,
`INTENTION_CYCLE.md`, `COGNITIVE_APPRAISAL.md`.

## Требования

- Python 3.11+
- Ключи: `DEEPSEEK_API_KEY`, `KRISTINA_TELEGRAM_TOKEN` (обязательные),
  `KIMI_API_KEY` / `OPENAI_API_KEY` / `PERPLEXITY_API_KEY` / `ELEVENLABS_API_KEY`
  (опционально по функциям)
- PostgreSQL (опционально; по умолчанию SQLite)

## Лицензия

Ранее здесь была указана Apache-2.0, но корневой файл `LICENSE` отсутствует.
Условия лицензирования собственного кода требуют подтверждения владельца.
Лицензии встроенных сторонних библиотек сохранены рядом с их исходниками.
