#!/bin/bash
# Скрипт сборки Android APK для Kristina App

set -e

echo "🚀 Сборка Kristina App Android APK"

# Проверка Flutter
if ! command -v flutter &> /dev/null; then
    echo "❌ Flutter не установлен!"
    echo "Установите: https://flutter.dev/docs/get-started/install"
    exit 1
fi

# Переход в директорию
cd ~/kristina-project/kristina_revolutionary/mobile_app/kristina_app

# Очистка
echo "🧹 Очистка..."
flutter clean

# Установка зависимостей
echo "📦 Установка зависимостей..."
flutter pub get

# Анализ кода
echo "🔍 Анализ кода..."
flutter analyze

# Сборка APK
echo "🔨 Сборка release APK..."
flutter build apk --release

# Результат
echo ""
echo "✅ Сборка завершена!"
echo "📱 APK файл: build/app/outputs/flutter-apk/app-release.apk"
echo ""
echo "Установка на устройство:"
echo "  flutter install"
echo ""
echo "Или скопируйте файл на устройство вручную."
