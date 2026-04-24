#!/bin/bash
# Скрипт отладки Kristina Mobile App

set -e

echo "🚀 Kristina Mobile App - Debug Mode"
echo "===================================="

# Проверка запущенного API
echo ""
echo "📡 Проверка API сервера..."
if curl -s http://127.0.0.1:8001/status > /dev/null; then
    echo "✅ API сервер запущен на http://127.0.0.1:8001"
else
    echo "❌ API сервер НЕ запущен!"
    echo ""
    echo "Запусти API в другой вкладке:"
    echo "  cd ~/kristina-project/kristina_revolutionary"
    echo "  python mobile_api.py"
    echo ""
    exit 1
fi

# Проверка Flutter
echo ""
echo "🔧 Проверка Flutter..."
if ! command -v flutter &> /dev/null; then
    echo "❌ Flutter не установлен!"
    exit 1
fi
flutter --version | head -1

# Установка зависимостей
echo ""
echo "📦 Установка зависимостей..."
cd ~/kristina-project/kristina_revolutionary/mobile_app/kristina_app
flutter pub get

# Проверка кода
echo ""
echo "🔍 Анализ кода..."
flutter analyze || true

# Запуск на эмуляторе/устройстве
echo ""
echo "🎯 Запуск приложения..."
echo ""
echo "Доступные устройства:"lutter devices

echo ""
echo "Запускаю на первом доступном устройстве..."
flutter run --debug
