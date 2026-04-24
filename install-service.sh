#!/bin/bash
# Установка Kristina AI как системный сервис (systemd)
# Запуск: sudo ./install-service.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Установка Kristina AI как системного сервиса${NC}"
echo "=============================================="

# Проверка root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Пожалуйста, запустите с sudo${NC}"
    echo "  sudo ./install-service.sh"
    exit 1
fi

PROJECT_DIR="/root/kristina_revolutionary"
if [ ! -d "$PROJECT_DIR" ]; then
    PROJECT_DIR="/home/$(logname 2>/dev/null || echo $SUDO_USER)/kristina_revolutionary"
fi

echo ""
echo "Директория проекта: $PROJECT_DIR"

# Определяем пользователя
SERVICE_USER="${SUDO_USER:-root}"
if [ "$SERVICE_USER" = "root" ] && [ -d "/home/avatar" ]; then
    SERVICE_USER="avatar"
fi

echo "Пользователь сервиса: $SERVICE_USER"

# Создаем сервис для API
cat > /etc/systemd/system/kristina-api.service << EOF
[Unit]
Description=Kristina AI API Server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
Environment=PYTHONUNBUFFERED=1
ExecStart=$PROJECT_DIR/venv_local/bin/python $PROJECT_DIR/mobile_api.py
Restart=always
RestartSec=5
StandardOutput=append:/var/log/kristina-api.log
StandardError=append:/var/log/kristina-api.log

[Install]
WantedBy=multi-user.target
EOF

# Создаем сервис для Web
cat > /etc/systemd/system/kristina-web.service << EOF
[Unit]
Description=Kristina AI Web Interface
After=network.target kristina-api.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=/root/kristina-web
ExecStart=/usr/bin/python3 -m http.server 8080
Restart=always
RestartSec=5
StandardOutput=append:/var/log/kristina-web.log
StandardError=append:/var/log/kristina-web.log

[Install]
WantedBy=multi-user.target
EOF

# Перезагружаем systemd
systemctl daemon-reload

echo ""
echo -e "${GREEN}✅ Сервисы созданы!${NC}"
echo ""
echo "Управление:"
echo "  sudo systemctl start kristina-api    # Запустить API"
echo "  sudo systemctl stop kristina-api     # Остановить API"
echo "  sudo systemctl restart kristina-api  # Перезапустить API"
echo "  sudo systemctl status kristina-api   # Статус API"
echo ""
echo "  sudo systemctl start kristina-web    # Запустить Web"
echo "  sudo systemctl stop kristina-web     # Остановить Web"
echo ""
echo "Автозапуск при загрузке:"
echo "  sudo systemctl enable kristina-api"
echo "  sudo systemctl enable kristina-web"
echo ""
echo "Логи:"
echo "  sudo journalctl -u kristina-api -f   # Смотреть логи API"
echo "  sudo tail -f /var/log/kristina-api.log"
echo ""

# Предлагаем запустить
read -p "Запустить сервисы сейчас? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    systemctl start kristina-api
    sleep 3
    systemctl start kristina-web
    
    echo ""
    echo -e "${GREEN}✅ Сервисы запущены!${NC}"
    echo ""
    systemctl status kristina-api --no-pager
fi

# Предлагаем включить автозапуск
read -p "Включить автозапуск при загрузке? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    systemctl enable kristina-api
    systemctl enable kristina-web
    echo -e "${GREEN}✅ Автозапуск включен!${NC}"
fi

echo ""
echo "Установка завершена!"
echo ""
echo "URL доступа:"
IP=$(hostname -I | awk '{print $1}')
echo "  API:  http://$IP:8001"
echo "  Web:  http://$IP:8080"
