#!/bin/bash
# Kristina AI - Manager Script
# Управление всей системой на сервере
# Использование: ./kristina-manager.sh [start|stop|restart|status|logs]

set -e

# Конфигурация
PROJECT_DIR="/root/kristina_revolutionary"
WEB_DIR="/root/kristina-web"
API_LOG="/var/log/kristina-api.log"
WEB_LOG="/var/log/kristina-web.log"
API_PID_FILE="/tmp/kristina-api.pid"
WEB_PID_FILE="/tmp/kristina-web.pid"
API_PORT=8001
WEB_PORT=8080

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Проверка директории
if [ ! -d "$PROJECT_DIR" ]; then
    PROJECT_DIR="$HOME/kristina_revolutionary"
    WEB_DIR="$HOME/kristina-web"
fi

# Функции
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_api_running() {
    if [ -f "$API_PID_FILE" ]; then
        PID=$(cat "$API_PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            # Проверим, действительно ли это наш процесс
            if ps -p "$PID" -o cmd= | grep -q "mobile_api"; then
                return 0
            fi
        fi
    fi
    # Дополнительная проверка по порту
    if netstat -tlnp 2>/dev/null | grep -q ":$API_PORT"; then
        return 0
    fi
    if ss -tlnp 2>/dev/null | grep -q ":$API_PORT"; then
        return 0
    fi
    return 1
}

check_web_running() {
    if [ -f "$WEB_PID_FILE" ]; then
        PID=$(cat "$WEB_PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            if ps -p "$PID" -o cmd= | grep -q "http.server"; then
                return 0
            fi
        fi
    fi
    if netstat -tlnp 2>/dev/null | grep -q ":$WEB_PORT"; then
        return 0
    fi
    if ss -tlnp 2>/dev/null | grep -q ":$WEB_PORT"; then
        return 0
    fi
    return 1
}

start_api() {
    log_info "Запуск API сервера..."
    
    if check_api_running; then
        log_warning "API уже запущен"
        return 0
    fi
    
    cd "$PROJECT_DIR"
    
    # Определяем Python
    if [ -f "venv_local/bin/python" ]; then
        PYTHON="$PROJECT_DIR/venv_local/bin/python"
    elif [ -f "venv/bin/python" ]; then
        PYTHON="$PROJECT_DIR/venv/bin/python"
    else
        PYTHON="python3"
    fi
    
    # Проверка зависимостей
    if ! $PYTHON -c "import fastapi" 2>/dev/null; then
        log_warning "Устанавливаю зависимости..."
        $PYTHON -m pip install -r requirements.txt --quiet
    fi
    
    # Запускаем API
    nohup $PYTHON mobile_api.py > "$API_LOG" 2>&1 &
    PID=$!
    echo $PID > "$API_PID_FILE"
    
    # Ждём запуска
    log_info "Ожидание инициализации API..."
    for i in {1..15}; do
        if curl -s http://127.0.0.1:$API_PORT/status > /dev/null 2>&1; then
            log_success "API сервер запущен (PID: $PID)"
            log_info "URL: http://$(hostname -I | awk '{print $1}'):$API_PORT"
            return 0
        fi
        sleep 1
    done
    
    log_error "API не удалось запустить"
    return 1
}

stop_api() {
    log_info "Остановка API сервера..."
    
    if [ -f "$API_PID_FILE" ]; then
        PID=$(cat "$API_PID_FILE")
        if kill "$PID" 2>/dev/null; then
            log_success "API остановлен (PID: $PID)"
        fi
        rm -f "$API_PID_FILE"
    fi
    
    # Убиваем все процессы mobile_api
    pkill -f "mobile_api.py" 2>/dev/null || true
    
    log_success "API сервер остановлен"
}

start_web() {
    log_info "Запуск Web-интерфейса..."
    
    if check_web_running; then
        log_warning "Web-интерфейс уже запущен"
        return 0
    fi
    
    if [ ! -d "$WEB_DIR" ]; then
        log_error "Директория Web-интерфейса не найдена: $WEB_DIR"
        return 1
    fi
    
    cd "$WEB_DIR"
    
    # Проверяем, есть ли index.html
    if [ ! -f "index.html" ]; then
        log_error "index.html не найден в $WEB_DIR"
        return 1
    fi
    
    # Запускаем HTTP сервер
    nohup python3 -m http.server $WEB_PORT > "$WEB_LOG" 2>&1 &
    PID=$!
    echo $PID > "$WEB_PID_FILE"
    
    sleep 2
    
    if check_web_running; then
        log_success "Web-интерфейс запущен (PID: $PID)"
        log_info "URL: http://$(hostname -I | awk '{print $1}'):$WEB_PORT"
    else
        log_error "Web-интерфейс не удалось запустить"
        return 1
    fi
}

stop_web() {
    log_info "Остановка Web-интерфейса..."
    
    if [ -f "$WEB_PID_FILE" ]; then
        PID=$(cat "$WEB_PID_FILE")
        kill "$PID" 2>/dev/null || true
        rm -f "$WEB_PID_FILE"
    fi
    
    pkill -f "http.server $WEB_PORT" 2>/dev/null || true
    
    log_success "Web-интерфейс остановлен"
}

show_status() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║           KRISTINA AI - СТАТУС СИСТЕМЫ                       ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    # API Status
    echo -n "🔹 API Сервер:        "
    if check_api_running; then
        echo -e "${GREEN}● РАБОТАЕТ${NC}"
        IP=$(hostname -I | awk '{print $1}')
        echo "                      http://$IP:$API_PORT"
        
        # Пробуем получить статус
        STATUS=$(curl -s http://127.0.0.1:$API_PORT/status 2>/dev/null)
        if [ -n "$STATUS" ]; then
            echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"                      Агентов: {d['agents_active']}, Настроение: {d['mood']}\")" 2>/dev/null
        fi
    else
        echo -e "${RED}● ОСТАНОВЛЕН${NC}"
    fi
    
    # Web Status
    echo -n "🔹 Web-интерфейс:     "
    if check_web_running; then
        echo -e "${GREEN}● РАБОТАЕТ${NC}"
        IP=$(hostname -I | awk '{print $1}')
        echo "                      http://$IP:$WEB_PORT"
    else
        echo -e "${RED}● ОСТАНОВЛЕН${NC}"
    fi
    
    echo ""
    echo "📊 Системные ресурсы:"
    echo "   Диск: $(df -h $PROJECT_DIR | tail -1 | awk '{print $5 " использовано"}')"
    echo "   Память: $(free -h | grep Mem | awk '{print $3 "/" $2}')"
    
    echo ""
    echo "📁 Проект: $PROJECT_DIR"
    echo "📝 Логи:"
    echo "   API:  tail -f $API_LOG"
    echo "   Web:  tail -f $WEB_LOG"
    echo ""
}

show_logs() {
    echo "Последние 50 строк логов:"
    echo ""
    
    if [ -f "$API_LOG" ]; then
        echo "=== API Log ==="
        tail -50 "$API_LOG"
    fi
    
    echo ""
    
    if [ -f "$WEB_LOG" ]; then
        echo "=== Web Log ==="
        tail -20 "$WEB_LOG"
    fi
}

test_system() {
    log_info "Тестирование системы..."
    echo ""
    
    # Тест API
    echo -n "API Status: "
    if curl -s http://127.0.0.1:$API_PORT/status > /dev/null 2>&1; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}FAIL${NC}"
    fi
    
    echo -n "Chat Direct: "
    RESPONSE=$(curl -s "http://127.0.0.1:$API_PORT/chat/direct?message=Test&user_id=health_check" 2>/dev/null)
    if [ -n "$RESPONSE" ]; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}FAIL${NC}"
    fi
    
    echo -n "Auth: "
    AUTH=$(curl -s -X POST http://127.0.0.1:$API_PORT/auth/login \
        -H "Content-Type: application/json" \
        -d '{"username":"test","password":"test"}' 2>/dev/null)
    if [ -n "$AUTH" ]; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}FAIL${NC}"
    fi
    
    echo -n "Web Interface: "
    if curl -s http://127.0.0.1:$WEB_PORT/ > /dev/null 2>&1; then
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "${RED}FAIL${NC}"
    fi
    
    echo ""
}

# Firewall setup
setup_firewall() {
    log_info "Настройка Firewall..."
    
    if command -v ufw &> /dev/null; then
        ufw allow $API_PORT/tcp comment 'Kristina API'
        ufw allow $WEB_PORT/tcp comment 'Kristina Web'
        ufw reload
        log_success "UFW настроен (порты $API_PORT и $WEB_PORT открыты)"
    elif command -v firewall-cmd &> /dev/null; then
        firewall-cmd --permanent --add-port=$API_PORT/tcp
        firewall-cmd --permanent --add-port=$WEB_PORT/tcp
        firewall-cmd --reload
        log_success "FirewallD настроен (порты $API_PORT и $WEB_PORT открыты)"
    else
        log_warning "Firewall не найден. Убедитесь, что порты $API_PORT и $WEB_PORT открыты вручную."
    fi
}

# Main command handler
case "${1:-status}" in
    start)
        echo "🚀 Запуск Kristina AI..."
        echo ""
        start_api
        start_web
        echo ""
        show_status
        ;;
    
    stop)
        echo "🛑 Остановка Kristina AI..."
        echo ""
        stop_web
        stop_api
        log_success "Все сервисы остановлены"
        ;;
    
    restart)
        echo "🔄 Перезапуск Kristina AI..."
        echo ""
        stop_web
        stop_api
        sleep 2
        start_api
        start_web
        echo ""
        show_status
        ;;
    
    status)
        show_status
        ;;
    
    logs)
        show_logs
        ;;
    
    test)
        test_system
        ;;
    
    setup)
        setup_firewall
        ;;
    
    *)
        echo "Kristina AI Manager"
        echo ""
        echo "Использование: $0 [команда]"
        echo ""
        echo "Команды:"
        echo "  start    - Запустить все сервисы"
        echo "  stop     - Остановить все сервисы"
        echo "  restart  - Перезапустить все сервисы"
        echo "  status   - Показать статус"
        echo "  logs     - Показать логи"
        echo "  test     - Тестировать систему"
        echo "  setup    - Настроить firewall"
        echo ""
        echo "Примеры:"
        echo "  $0 start      # Запустить всё"
        echo "  $0 status     # Проверить статус"
        echo "  $0 logs       # Смотреть логи"
        ;;
esac
