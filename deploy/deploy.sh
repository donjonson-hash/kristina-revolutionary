#!/usr/bin/env bash
#
# Развёртывание Kristina AI на Ubuntu VPS (24.04/26.04) — P0 Hardened (AUD-03 fix).
# Код и venv принадлежат root:root (read-only для сервиса — защита от подмены кода при RCE),
# а демон бота и backup_state.py работают от непривилегированного системного пользователя kristina
# с правами записи только в рабочие БД, логи и backups/.

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

# --- 4. Код (обновляется от root, чтобы git в workflow и в deploy.sh не конфликтовал по владельцу) ---
if [ -d "$APP_DIR/.git" ]; then
    echo "--- Обновляю код ---"
    git -C "$APP_DIR" config --system --add safe.directory "$APP_DIR" 2>/dev/null || true
    git -C "$APP_DIR" pull --ff-only
else
    echo "--- Клонирую репозиторий ---"
    git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# Разрешаем kristina создавать SQLite WAL/SHM/journal файлы в рабочей директории,
# оставляя сам код и venv во владении root:root
chown "root:$APP_GROUP" "$APP_DIR"
chmod 775 "$APP_DIR"

# --- 5. Виртуальное окружение и зависимости (root:root, read-only для kristina) ---
if [ ! -d venv ]; then
    python3 -m venv venv
fi
venv/bin/pip install --upgrade pip -q
venv/bin/pip install -r requirements.txt -q

# --- 6. Конфигурация и права на БД/секреты ---
if [ ! -f .env ]; then
    cp .env.example .env
    chown "$APP_USER:$APP_GROUP" .env
    chmod 600 .env
    echo ""
    echo "!!! Создан $APP_DIR/.env из шаблона."
    echo "!!! Впишите KRISTINA_TELEGRAM_TOKEN и DEEPSEEK_API_KEY: nano $APP_DIR/.env"
    echo "!!! Затем: systemctl start kristina-bot"
    NEED_ENV=1
else
    chown "$APP_USER:$APP_GROUP" .env
    chmod 600 .env
    NEED_ENV=0
fi

# Гарантируем владение всеми SQLite-файлами и папкой backups пользователю kristina
mkdir -p "$APP_DIR/backups"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/backups"
chmod 700 "$APP_DIR/backups"
for db_file in "$APP_DIR"/*.db "$APP_DIR"/*.db-wal "$APP_DIR"/*.db-shm "$APP_DIR"/*.db-journal; do
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
    # Останавливаем возможный старый root-процесс перед снятием бэкапа и сменой владельца WAL-файлов
    systemctl stop kristina-bot || true
    for db_file in "$APP_DIR"/*.db "$APP_DIR"/*.db-wal "$APP_DIR"/*.db-shm "$APP_DIR"/*.db-journal; do
        if [ -e "$db_file" ]; then
            chown "$APP_USER:$APP_GROUP" "$db_file"
            chmod 600 "$db_file"
        fi
    done
    runuser -u "$APP_USER" -- venv/bin/python deploy/backup_state.py
    systemctl start kristina-bot
    sleep 3
    systemctl --no-pager --lines=5 status kristina-bot || true
fi

echo ""
echo "=== Готово ==="
echo "Статус:  systemctl status kristina-bot"
echo "Логи:    journalctl -u kristina-bot -f"
