#!/bin/bash
# Запуск всей системы Kristina (API + Mobile App)

set -e

KRISTINA_DIR="$HOME/kristina-project/kristina_revolutionary"
MOBILE_DIR="$KRISTINA_DIR/mobile_app"

echo "🚀 Запуск системы Kristina AI"
echo "=============================="

# Проверка API
echo ""
echo "📡 Проверка API..."
if ! curl -s http://127.0.0.1:8001/status > /dev/null; then
    echo "⚠️  API не запущен. Запускаю..."
    
    # Проверка virtual environment
    if [ -f "$KRISTINA_DIR/venv_local/bin/python" ]; then
        PYTHON="$KRISTINA_DIR/venv_local/bin/python"
    elif [ -f "$KRISTINA_DIR/venv/bin/python" ]; then
        PYTHON="$KRISTINA_DIR/venv/bin/python"
    else
        PYTHON="python3"
    fi
    
    # Запуск API в фоне
    cd "$KRISTINA_DIR"
    nohup $PYTHON mobile_api.py > /tmp/kristina_api.log 2>&1 &
    
    # Ждём запуска
    echo "⏳ Ожидание запуска API..."
    for i in {1..10}; do
        if curl -s http://127.0.0.1:8001/status > /dev/null; then
            echo "✅ API запущен!"
            break
        fi
        sleep 1
    done
else
    echo "✅ API уже запущен"
fi

# Показываем статус
echo ""
curl -s http://127.0.0.1:8001/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"📊 Статус: {d['status']}, Агентов: {d['agents_active']}, Настроение: {d['mood']}\")" 2>/dev/null || echo "Статус API получен"

# Запуск мобильного приложения
echo ""
echo "📱 Запуск мобильного приложения..."
cd "$MOBILE_DIR/kristina_app"

echo ""
echo "Доступные устройства:"
flutter devices

echo ""
echo "Установка зависимостей..."
flutter pub get

echo ""
echo "🎯 Запускаю приложение..."
flutter run --debug
