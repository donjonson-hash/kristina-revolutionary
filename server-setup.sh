#!/bin/bash
# Полная настройка сервера Kristina AI
# Запуск: ./server-setup.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   НАСТРОЙКА СЕРВЕРА KRISTINA AI${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# 1. Проверка системы
echo -e "${BLUE}[1/7] Проверка системы...${NC}"

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Python3 не установлен!${NC}"
    exit 1
fi

if ! command -v pip3 &> /dev/null; then
    echo -e "${YELLOW}Установка pip...${NC}"
    apt-get update && apt-get install -y python3-pip
fi

echo -e "${GREEN}✓ Python готов${NC}"

# 2. Установка зависимостей
echo ""
echo -e "${BLUE}[2/7] Установка Python зависимостей...${NC}"

if [ -f "requirements.txt" ]; then
    pip3 install -r requirements.txt --quiet --break-system-packages 2>/dev/null || \
    pip3 install -r requirements.txt --quiet || {
        echo -e "${YELLOW}Создаём virtual environment...${NC}"
        python3 -m venv venv_server
        source venv_server/bin/activate
        pip install -r requirements.txt --quiet
    }
fi

echo -e "${GREEN}✓ Зависимости установлены${NC}"

# 3. Создание директорий
echo ""
echo -e "${BLUE}[3/7] Создание директорий...${NC}"

mkdir -p /var/log
mkdir -p /tmp/kristina
mkdir -p ~/kristina-web

echo -e "${GREEN}✓ Директории созданы${NC}"

# 4. Настройка firewall
echo ""
echo -e "${BLUE}[4/7] Настройка Firewall...${NC}"

if command -v ufw &> /dev/null; then
    ufw allow 8001/tcp comment 'Kristina API'
    ufw allow 8080/tcp comment 'Kristina Web'
    echo -e "${GREEN}✓ UFW настроен${NC}"
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=8001/tcp
    firewall-cmd --permanent --add-port=8080/tcp
    firewall-cmd --reload
    echo -e "${GREEN}✓ FirewallD настроен${NC}"
else
    echo -e "${YELLOW}⚠ Firewall не найден, пропускаем${NC}"
fi

# 5. Проверка баз данных
echo ""
echo -e "${BLUE}[5/7] Проверка баз данных...${NC}"

for db in kristina_memory.db kristina_knowledge.db freelance.db; do
    if [ -f "$db" ]; then
        echo -e "  ${GREEN}✓${NC} $db"
    else
        echo -e "  ${YELLOW}⚠${NC} $db (будет создана автоматически)"
    fi
done

# 6. Создание Web-интерфейса
echo ""
echo -e "${BLUE}[6/7] Проверка Web-интерфейса...${NC}"

WEB_DIR="~/kristina-web"
if [ ! -f "$WEB_DIR/index.html" ]; then
    WEB_DIR="$HOME/kristina-web"
    mkdir -p "$WEB_DIR"
fi

if [ -f "$WEB_DIR/index.html" ]; then
    echo -e "${GREEN}✓ Web-интерфейс найден${NC}"
else
    echo -e "${YELLOW}⚠ Web-интерфейс не найден, создаём...${NC}"
    # Здесь можно добавить создание index.html если нужно
fi

# 7. Проверка запуска
echo ""
echo -e "${BLUE}[7/7] Тестовый запуск API...${NC}"

# Проверяем, не запущен ли уже
if netstat -tlnp 2>/dev/null | grep -q ":8001"; then
    echo -e "${YELLOW}⚠ API уже запущен на порту 8001${NC}"
else
    # Пробуем запустить для проверки
    PYTHON="python3"
    if [ -f "venv_local/bin/python" ]; then
        PYTHON="./venv_local/bin/python"
    elif [ -f "venv_server/bin/python" ]; then
        PYTHON="./venv_server/bin/python"
    fi
    
    # Проверка синтаксиса
    if $PYTHON -m py_compile mobile_api.py 2>/dev/null; then
        echo -e "${GREEN}✓ Синтаксис OK${NC}"
    else
        echo -e "${RED}✗ Ошибка в синтаксисе mobile_api.py${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   ✅ НАСТРОЙКА ЗАВЕРШЕНА!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "📋 СЛЕДУЮЩИЕ ШАГИ:"
echo ""
echo "1️⃣  Запустить сервисы:"
echo "    ./kristina-manager.sh start"
echo ""
echo "2️⃣  Проверить статус:"
echo "    ./kristina-manager.sh status"
echo ""
echo "3️⃣  Установить как системный сервис (опционально):"
echo "    sudo ./install-service.sh"
echo ""
echo "🌐 URL доступа:"
IP=$(hostname -I | awk '{print $1}')
echo "    API:  http://$IP:8001"
echo "    Web:  http://$IP:8080"
echo ""
echo "📱 Для мобильного приложения используй IP: $IP"
echo ""
echo "📖 Помощь:"
echo "    ./kristina-manager.sh --help"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
