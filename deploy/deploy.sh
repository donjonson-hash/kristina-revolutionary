#!/usr/bin/env bash
#
# Развёртывание Kristina AI на Ubuntu VPS (24.04/26.04) — P0 Hardened (AUD-03 fix).
# Создаёт системного пользователя kristina без shell-доступа и передаёт ему права
# только на рабочую директорию /opt/kristina-revolutionary и бэкапы.

set -euo pipefail

APP_DIR="/opt/kristina-revolutionary"
APP_USER="kristina"
APP_GROUP="kristina"
REPO_URL="https://github.com/donjonson-hash/kristina-revolutionary.git"

echo "=== Kristina AI deploy (hardened) ==="

# --- 1. Системные пакеты ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends python3 python3-venv python3-pip git

# --- 2. Выделенный системный пользователь без root-привилегий (AUD-03) ---
if ! getent group "$APP_GROUP" >/dev/null; then
    groupadd --system "$APP_GROUP"
fi
if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    echo "--- Создан системный пользователь $APP_USER ---"
fi

# --- 3. Swap (обязательно при 1 ГБ RAM) ---
if [ -z "$(swapon --show --noheadings)" ]; then
    echo "--- Создаю swap 2G (RAM 1 ГБ) ---"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 4. Код ---
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_GROUP" "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
    echo "--- Обновляю код ---"
    runuser -u "$APP_USER" -- git -C "$APP_DIR" pull --ff-only
else
    echo "--- Клонирую репозиторий ---"
    runuser -u "$APP_USER" -- git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- 5. Виртуальное окружение и зависимости ---
if [ ! -d venv ]; then
    runuser -u "$APP_USER" -- python3 -m venv venv
fi
runuser -u "$APP_USER" -- venv/bin/pip install --upgrade pip -q
runuser -u "$APP_USER" -- venv/bin/pip install -r requirements.txt -q

# --- 6. Конфигурация и права на БД/секреты ---
if [ ! -f .env ]; then
    cp .env.example .env
    chown "$APP_USER:$APP_GROUP" .env
    chmod 600 .env
    echo ""
    echo "!!! Создан $APP_DIR/.env из шаблона."
    echo "!!! Впишите KRISTINA_TELEGRAM_TOKEN и DEEPSEEK_API_KEY: nano $APP_DIR/.env"
    echo "!!! ВАЖНО: Если ранее использовался старый brain_llm_integration.py, перевыпустите DEEPSEEK_API_KEY!"
    echo "!!! Затем: systemctl start kristina-bot"
    NEED_ENV=1
else
    chown "$APP_USER:$APP_GROUP" .env
    chmod 600 .env
    NEED_ENV=0
fi

# Гарантируем владение SQLite-файлами и папкой backups пользователю kristina
mkdir -p "$APP_DIR/backups"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/backups"
chmod 700 "$APP_DIR/backups"
for db_file in "$APP_DIR"/*.db "$APP_DIR"/*.db-wal "$APP_DIR"/*.db-shm; do
    if [ -e "$db_file" ]; then
        chown "$APP_USER:$APP_GROUP" "$db_file"
        chmod 600 "$db_file"
    fi
done

# --- 7. systemd-сервис бота ---
cp deploy/kristina-bot.service /etc/systemd/system/
chmod 644 /etc/systemd/system/kristina-bot.service
systemctl daemon-reload
systemctl enable kristina-bot

if [ "$NEED_ENV" = "0" ]; then
    # Бэкап выполняется от имени kristina, чтобы снимки имели корректного владельца
    runuser -u "$APP_USER" -- venv/bin/python deploy/backup_state.py
    systemctl restart kristina-bot
    sleep 3
    systemctl --no-pager --lines=5 status kristina-bot || true
fi

echo ""
echo "=== Готово ==="
echo "Статус:  systemctl status kristina-bot"
echo "Логи:    journalctl -u kristina-bot -f"
