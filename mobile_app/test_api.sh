#!/bin/bash
# Тестирование подключения к API

echo "🧪 Тестирование Kristina API"
echo "============================="

API_URL="http://127.0.0.1:8001"

echo ""
echo "📡 Тест 1: Проверка статуса API"
echo "URL: $API_URL/status"
curl -s "$API_URL/status" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/status"

echo ""
echo ""
echo "💬 Тест 2: Отправка сообщения (chat_direct)"
echo "URL: $API_URL/chat/direct?message=Привет&user_id=test"
curl -s "$API_URL/chat/direct?message=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82&user_id=test" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/chat/direct?message=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82&user_id=test"

echo ""
echo ""
echo "✅ Тестирование завершено!"
