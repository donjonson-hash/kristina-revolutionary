#!/bin/bash
# Быстрая сборка APK Kristina AI
# Использование: ./build_apk_fast.sh [arm64|all]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   СБОРКА APK KRISTINA AI${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Параметры сборки
PLATFORM="${1:-arm64}"
if [ "$PLATFORM" = "arm64" ]; then
    TARGET_FLAG="--target-platform android-arm64"
    TYPE="ARM64 (быстрая, меньше размер)"
else
    TARGET_FLAG=""
    TYPE="Универсальная (все архитектуры)"
fi

echo "📱 Тип сборки: $TYPE"
echo ""

# Проверка Flutter
if ! command -v flutter &> /dev/null; then
    echo -e "${RED}❌ Flutter не найден!${NC}"
    exit 1
fi

echo "✅ Flutter: $(flutter --version | head -1)"
echo ""

# Переход в директорию
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)/kristina_app"
cd "$PROJECT_DIR"

echo "📁 Директория: $(pwd)"
echo ""

# Проверка конфигурации
echo -e "${BLUE}Проверка конфигурации...${NC}"
API_CONFIG_FILE="lib/config/api_config.dart"
if [ -f "$API_CONFIG_FILE" ]; then
    CURRENT_CONFIG=$(grep "static const ApiConfig current" "$API_CONFIG_FILE" | sed 's/.*= //;s/;.*//')
    echo "   Текущая конфигурация: $CURRENT_CONFIG"
    
    # Извлекаем IP
    IP=$(grep -A 2 "static const localNetwork" "$API_CONFIG_FILE" | grep "baseUrl" | sed 's/.*http:\/\///;s/:.*//')
    echo "   IP сервера: $IP"
    echo ""
    
    # Проверяем доступность API
    echo "   Проверка API..."
    if curl -s --max-time 3 "http://$IP:8001/status" > /dev/null 2>&1; then
        echo -e "   ${GREEN}✅ API доступен${NC}"
    else
        echo -e "   ${YELLOW}⚠️  API не отвечает (возможно, не запущен)${NC}"
        read -p "Продолжить сборку? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
else
    echo -e "   ${YELLOW}⚠️  Файл конфигурации не найден${NC}"
fi

echo ""

# Очистка
echo -e "${BLUE}🧹 Очистка проекта...${NC}"
flutter clean > /dev/null 2>&1
echo -e "${GREEN}✅ Очистка завершена${NC}"
echo ""

# Установка зависимостей
echo -e "${BLUE}📦 Установка зависимостей...${NC}"
flutter pub get > /dev/null 2>&1
echo -e "${GREEN}✅ Зависимости установлены${NC}"
echo ""

# Сборка
echo -e "${BLUE}🔨 Сборка APK...${NC}"
echo "   Это может занять 3-10 минут..."
echo ""

START_TIME=$(date +%s)

if flutter build apk --release $TARGET_FLAG 2>&1 | tee /tmp/build_output.log; then
    END_TIME=$(date +%s)
    BUILD_TIME=$((END_TIME - START_TIME))
    
    echo ""
    echo -e "${GREEN}✅ Сборка завершена за ${BUILD_TIME} секунд!${NC}"
    echo ""
    
    # Копирование APK
    APK_SOURCE="build/app/outputs/flutter-apk/app-release.apk"
    APK_DEST="$HOME/KristinaAI.apk"
    
    if [ -f "$APK_SOURCE" ]; then
        cp "$APK_SOURCE" "$APK_DEST"
        
        echo -e "${BLUE}📊 Информация о APK:${NC}"
        ls -lh "$APK_DEST" | awk '{print "   Размер: " $5}'
        echo "   Путь: $APK_DEST"
        echo ""
        
        # Проверка подписи
        if command -v apksigner &> /dev/null || command -v jarsigner &> /dev/null; then
            echo -e "${BLUE}🔐 APK подписан${NC}"
        fi
        
        echo ""
        echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}   ✅ APK ГОТОВ К УСТАНОВКЕ!${NC}"
        echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
        echo ""
        echo "Установка на телефон:"
        echo "  adb install $APK_DEST"
        echo ""
        echo "Или скопируй файл на телефон через Telegram/Email/USB"
        echo ""
    else
        echo -e "${RED}❌ APK файл не найден${NC}"
        exit 1
    fi
else
    echo ""
    echo -e "${RED}❌ Ошибка сборки!${NC}"
    echo ""
    echo "Последние ошибки:"
    tail -30 /tmp/build_output.log
    exit 1
fi
