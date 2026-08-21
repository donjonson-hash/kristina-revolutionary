# 🚀 Развёртывание на VPS (Timeweb, 1 ГБ RAM)

Инструкция «чистый Ubuntu VPS → работающий бот». Проверена логика под
Ubuntu 24.04/26.04, минимальная конфигурация: 1 vCPU, 1 ГБ RAM, NVMe.

Бот работает через **long polling** — публичный IP, домен, SSL и открытые
входящие порты для Telegram **не нужны**. Достаточно исходящего интернета.

## Быстрый старт (5 минут)

```bash
# 1. Подключиться к серверу
ssh root@<IP-вашего-VPS>

# 2. Клонировать и развернуть
git clone https://github.com/donjonson-hash/kristina-revolutionary.git /opt/kristina-revolutionary
cd /opt/kristina-revolutionary
bash deploy/deploy.sh

# 3. Вписать токены
nano /opt/kristina-revolutionary/.env
#   KRISTINA_TELEGRAM_TOKEN=...   (от @BotFather)
#   DEEPSEEK_API_KEY=...          (для LLM-ответов и TrendScout)

# 4. Запустить
systemctl start kristina-bot
```

Скрипт `deploy/deploy.sh` сам: ставит python3-venv/git, создаёт swap 2 ГБ
(критично при 1 ГБ RAM), клонирует/обновляет код, ставит зависимости в venv,
устанавливает systemd-сервис с автозапуском. Повторный запуск скрипта — это
обновление (git pull + перезапуск).

## Управление

```bash
systemctl status kristina-bot     # статус
journalctl -u kristina-bot -f     # логи в реальном времени
systemctl restart kristina-bot    # перезапуск
systemctl stop kristina-bot       # остановка
```

## Обновление до новой версии

```bash
cd /opt/kristina-revolutionary && bash deploy/deploy.sh
```

## Автоматический production deploy

После настройки GitHub Actions workflow `Deploy to Timeweb` каждый успешный
CI на ветке `main` автоматически обновляет `/opt/kristina-revolutionary` до
`origin/main`, запускает `deploy/deploy.sh` и проверяет, что `kristina-bot`
остался в состоянии `active`.

Для SSH-деплоя используются только GitHub Actions Secrets:
`TIMEWEB_HOST`, `TIMEWEB_USER`, `TIMEWEB_SSH_KEY`, `TIMEWEB_KNOWN_HOSTS`.
Секреты не должны храниться в репозитории.

## Проверка после запуска

1. `systemctl status kristina-bot` → `active (running)`;
2. в Telegram отправить боту `/start` — должно прийти приветствие;
3. `/trends ai` — агент TrendScout соберёт сигналы и вернёт отчёт
   (займёт 1–2 минуты; нужен `DEEPSEEK_API_KEY`).

## Веб-панель (опционально)

`web_server.py` — панель управления на порту 8000. На минимальном VPS
запускайте по необходимости:

```bash
cp deploy/kristina-web.service /etc/systemd/system/
systemctl enable --now kristina-web
# открыть порт, если нужен доступ извне:
ufw allow 8000/tcp
```

## Ресурсы и лимиты

- Бот в покое занимает ~150–250 МБ RAM; в юните стоит `MemoryMax=700M` —
  при утечке systemd перезапустит процесс, а не повесит сервер.
- Swap 2 ГБ страхует пики (pip install, LLM-запросы с большим контекстом).
- SQLite-базы (`kristina_memory.db` и др.) создаются в каталоге приложения;
  `backup.sh` в корне репозитория делает их резервные копии.

## Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `inactive (dead)` сразу после старта | не заполнен `.env` → `journalctl -u kristina-bot -n 20` покажет, какой токен не задан |
| Бот молчит в Telegram | неверный `KRISTINA_TELEGRAM_TOKEN`, или запущена вторая копия бота (Telegram разрешает один polling на токен) |
| Ответы «что-то с интернетом» | неверный/просроченный `DEEPSEEK_API_KEY` или нет исходящего HTTPS |
| TrendScout: мало сигналов | с IP дата-центров Reddit/suggest иногда отдают 403 — источники изолированы, отчёт строится по остальным |
| `MemoryError` / OOM при установке | убедитесь, что swap создан: `swapon --show` |

---

Историческая инструкция для старого сервера (API + мобильное приложение) —
в `SERVER-README.md`.
