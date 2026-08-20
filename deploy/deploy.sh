#!/usr/bin/env bash
#
# Развёртывание Kristina AI на чистом Ubuntu VPS (проверено под 24.04/26.04).
# Рассчитан на минимальный хост: 1 vCPU / 1 ГБ RAM (Timeweb и аналоги).
#
# Использование (от root):
#   git clone https://github.com/donjonson-hash/kristina-revolutionary.git /opt/kristina-revolutionary
#   cd /opt/kristina-revolutionary && bash deploy/deploy.sh
#
# Повторный запуск безопасен: обновляет код и зависимости, перезапускает сервис.

set -euo pipefail

APP_DIR="/opt/kristina-revolutionary"
REPO_URL="https://github.com/donjonson-hash/kristina-revolutionary.git"

echo "=== Kristina AI deploy ==="

# --- 1. Системные пакеты ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends python3 python3-venv python3-pip git

# --- 2. Swap (обязательно при 1 ГБ RAM) ---
if [ -z "$(swapon --show --noheadings)" ]; then
    echo "--- Создаю swap 2G (RAM 1 ГБ) ---"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 3. Код ---
if [ -d "$APP_DIR/.git" ]; then
    echo "--- Обновляю код ---"
    git -C "$APP_DIR" pull --ff-only
else
    echo "--- Клонирую репозиторий ---"
    git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- 4. Виртуальное окружение и зависимости ---
[ -d venv ] || python3 -m venv venv
venv/bin/pip install --upgrade pip -q
venv/bin/pip install -r requirements.txt -q

# --- 5. Конфигурация ---
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    echo ""
    echo "!!! Создан $APP_DIR/.env из шаблона."
    echo "!!! Впишите KRISTINA_TELEGRAM_TOKEN и DEEPSEEK_API_KEY: nano $APP_DIR/.env"
    echo "!!! Затем: systemctl start kristina-bot"
    NEED_ENV=1
else
    NEED_ENV=0
fi

# --- 6. systemd-сервис бота ---
cp deploy/kristina-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable kristina-bot

if [ "$NEED_ENV" = "0" ]; then
    systemctl restart kristina-bot
    sleep 3
    systemctl --no-pager --lines=5 status kristina-bot || true
fi

echo ""
echo "=== Готово ==="
echo "Статус:  systemctl status kristina-bot"
echo "Логи:    journalctl -u kristina-bot -f"
echo "Веб-панель (опционально): cp deploy/kristina-web.service /etc/systemd/system/ && systemctl enable --now kristina-web"
