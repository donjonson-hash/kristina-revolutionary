#!/bin/bash
# Скрипт тестирования Kristina AI на сервере
# Запуск: ./test_server.sh

echo "🧪 ТЕСТИРОВАНИЕ KRISTINA AI НА СЕРВЕРЕ"
echo "======================================"
echo "Дата: $(date)"
echo "Сервер: $(hostname)"
echo "IP: $(hostname -I | awk '{print $1}')"
echo ""

API_URL="http://127.0.0.1:8001"
EXTERNAL_IP=$(hostname -I | awk '{print $1}')
EXTERNAL_URL="http://${EXTERNAL_IP}:8001"

# Проверка процессов
echo "📊 Проверка процессов:"
echo "----------------------"
ps aux | grep -E "python.*mobile_api|flutter" | grep -v grep || echo "❌ API не запущен"
echo ""

# Проверка портов
echo "🌐 Проверка портов:"
echo "-------------------"
netstat -tlnp 2>/dev/null | grep -E ":8001|:8080" || ss -tlnp | grep -E ":8001|:8080" || echo "Порты не найдены"
echo ""

# Тест 1: API Status
echo "📡 Тест 1: API Status (localhost)"
echo "---------------------------------"
if curl -s --max-time 5 ${API_URL}/status > /dev/null; then
    echo "✅ API отвечает на localhost:8001"
    curl -s ${API_URL}/status | python3 -m json.tool 2>/dev/null || curl -s ${API_URL}/status
else
    echo "❌ API не отвечает на localhost:8001"
fi
echo ""

# Тест 2: API Status (external IP)
echo "📡 Тест 2: API Status (external IP: ${EXTERNAL_IP})"
echo "---------------------------------------------------"
if curl -s --max-time 5 ${EXTERNAL_URL}/status > /dev/null; then
    echo "✅ API доступен извне на ${EXTERNAL_IP}:8001"
else
    echo "⚠️  API НЕ доступен извне (возможно, firewall)"
fi
echo ""

# Тест 3: Chat Direct
echo "💬 Тест 3: Chat Direct"
echo "----------------------"
RESPONSE=$(curl -s --max-time 10 "${API_URL}/chat/direct?message=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82&user_id=server_test")
if [ -n "$RESPONSE" ]; then
    echo "✅ Chat API работает"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
else
    echo "❌ Chat API не отвечает"
fi
echo ""

# Тест 4: Auth
echo "🔐 Тест 4: Регистрация и Авторизация"
echo "------------------------------------"
# Пробуем зарегистрировать тестового пользователя
REGISTER=$(curl -s -X POST --max-time 5 \
    -H "Content-Type: application/json" \
    -d '{"username":"servertest","password":"test123"}' \
    ${API_URL}/auth/register)

if echo "$REGISTER" | grep -q "access_token"; then
    echo "✅ Регистрация работает"
    echo "Токен получен"
else
    echo "⚠️  Регистрация (возможно, пользователь уже существует)"
fi

# Пробуем логин
LOGIN=$(curl -s -X POST --max-time 5 \
    -H "Content-Type: application/json" \
    -d '{"username":"servertest","password":"test123"}' \
    ${API_URL}/auth/login)

if echo "$LOGIN" | grep -q "access_token"; then
    echo "✅ Логин работает"
else
    echo "❌ Логин не работает"
fi
echo ""

# Тест 5: Проверка файлов
echo "📁 Тест 5: Проверка файлов проекта"
echo "----------------------------------"
cd /root/kristina_revolutionary 2>/dev/null || cd ~/kristina_revolutionary 2>/dev/null
if [ $? -eq 0 ]; then
    echo "✅ Директория проекта найдена: $(pwd)"
    echo ""
    echo "Базы данных:"
    ls -lh *.db 2>/dev/null | awk '{print "  " $9 " (" $5 ")"}'
    echo ""
    echo "Ключевые файлы:"
    [ -f mobile_api.py ] && echo "  ✅ mobile_api.py"
    [ -f brain_unified.py ] && echo "  ✅ brain_unified.py"
    [ -f bot.py ] && echo "  ✅ bot.py"
    echo ""
    echo "APK файл:"
    find . -name "app-release.apk" 2>/dev/null | head -1 | xargs ls -lh 2>/dev/null || echo "  ⚠️  APK не найден"
else
    echo "❌ Директория проекта не найдена"
fi
echo ""

# Тест 6: Firewall/UFW
echo "🔥 Тест 6: Проверка Firewall"
echo "----------------------------"
if command -v ufw &> /dev/null; then
    ufw status | grep -E "8001|8000" || echo "⚠️  Правила для портов 8000-8001 не найдены"
    echo ""
    echo "Текущий статус UFW:"
    ufw status numbered | head -10
else
    echo "ℹ️  UFW не установлен"
fi
echo ""

# Тест 7: Диск и память
echo "💾 Тест 7: Системные ресурсы"
echo "----------------------------"
echo "Диск:"
df -h . | tail -1 | awk '{print "  Использовано: " $3 " / " $2 " (" $5 ")"}'
echo ""
echo "Память:"
free -h | grep Mem | awk '{print "  Использовано: " $3 " / " $2}'
echo ""

# Итог
echo "═══════════════════════════════════════════════════════════════"
echo "📝 ИТОГИ ТЕСТИРОВАНИЯ"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "API URL (internal): ${API_URL}"
echo "API URL (external): ${EXTERNAL_URL}"
echo ""
echo "Если API не доступен извне:"
echo "  1. Проверь firewall: ufw allow 8001"
echo "  2. Проверь запуск API: python mobile_api.py"
echo "  3. Проверь, что API слушает на 0.0.0.0:8001"
echo ""
echo "Для запуска API:"
echo "  cd /root/kristina_revolutionary"
echo "  python mobile_api.py"
echo ""
echo "═══════════════════════════════════════════════════════════════"
