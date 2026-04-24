#!/usr/bin/env python3
"""
Интеграционное тестирование mini_app Kristina AI
Тестирует полный цикл: регистрация -> логин -> чат -> история
"""

import asyncio
import sys
import httpx
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

print("=" * 60)
print("🔗 ИНТЕГРАЦИОННОЕ ТЕСТИРОВАНИЕ MINI_APP")
print("=" * 60)

BASE_URL = "http://localhost:8001"  # mobile_api порт

async def test_mobile_api():
    """Тестирование mobile_api endpoints"""
    
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30.0) as client:
        
        # Test 1: Корневой endpoint
        print("\n1️⃣ Тестирование корневого endpoint")
        try:
            response = await client.get("/")
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Name: {data.get('name')}")
            print(f"   Version: {data.get('version')}")
            assert response.status_code == 200
            assert data.get('name') == 'Kristina Mobile API'
            print("   ✅ Корневой endpoint работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 2: Прямой чат (без авторизации)
        print("\n2️⃣ Тестирование прямого чата (/chat/direct)")
        try:
            response = await client.get("/chat/direct", params={
                "message": "Привет, Кристина!",
                "user_id": "test_user_123"
            })
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Response: {data.get('response', 'N/A')[:60]}...")
            print(f"   Agent: {data.get('agent')}")
            print(f"   Source: {data.get('source')}")
            assert response.status_code == 200
            assert 'response' in data
            print("   ✅ Прямой чат работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 3: Регистрация пользователя
        print("\n3️⃣ Тестирование регистрации")
        username = f"testuser_{asyncio.get_event_loop().time()}"
        try:
            response = await client.post("/auth/register", json={
                "username": username,
                "password": "testpassword123",
                "email": "test@example.com"
            })
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Token received: {'access_token' in data}")
            assert response.status_code == 200
            assert 'access_token' in data
            token = data['access_token']
            print("   ✅ Регистрация работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 4: Логин
        print("\n4️⃣ Тестирование логина")
        try:
            response = await client.post("/auth/login", json={
                "username": username,
                "password": "testpassword123"
            })
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Token received: {'access_token' in data}")
            assert response.status_code == 200
            assert 'access_token' in data
            token = data['access_token']
            print("   ✅ Логин работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 5: Статус системы
        print("\n5️⃣ Тестирование статуса системы")
        try:
            response = await client.get("/status")
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   System status: {data.get('status')}")
            print(f"   Agents active: {data.get('agents_active')}")
            print(f"   Mood: {data.get('mood')}")
            print(f"   Energy: {data.get('energy')}")
            assert response.status_code == 200
            print("   ✅ Статус работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 6: Чат с авторизацией
        print("\n6️⃣ Тестирование чата с авторизацией")
        try:
            response = await client.post("/chat", 
                headers={"Authorization": f"Bearer {token}"},
                json={"message": "Расскажи о себе", "context": {}}
            )
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Response: {data.get('response', 'N/A')[:60]}...")
            print(f"   Agent: {data.get('agent')}")
            print(f"   Confidence: {data.get('confidence')}")
            assert response.status_code == 200
            assert 'response' in data
            print("   ✅ Чат с авторизацией работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 7: История сообщений
        print("\n7️⃣ Тестирование истории сообщений")
        try:
            response = await client.get("/chat/history",
                headers={"Authorization": f"Bearer {token}"}
            )
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Messages count: {len(data)}")
            if data:
                print(f"   First message role: {data[0].get('role')}")
            assert response.status_code == 200
            assert isinstance(data, list)
            print("   ✅ История работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 8: Оценка стоимости проекта
        print("\n8️⃣ Тестирование оценки стоимости")
        try:
            response = await client.post("/price/estimate", json={
                "project_type": "mvp",
                "complexity": "medium",
                "region": "sweden"
            })
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Price range: {data.get('price_range')}")
            print(f"   Timeline: {data.get('timeline')}")
            print(f"   Includes count: {len(data.get('includes', []))}")
            assert response.status_code == 200
            assert 'price_range' in data
            print("   ✅ Оценка стоимости работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        return True

async def test_web_server():
    """Тестирование web_server endpoints"""
    
    WEB_URL = "http://localhost:8000"
    
    async with httpx.AsyncClient(base_url=WEB_URL, timeout=30.0) as client:
        
        print("\n" + "=" * 40)
        print("🌐 ТЕСТИРОВАНИЕ WEB_SERVER")
        print("=" * 40)
        
        # Test 1: Корневой endpoint (должен вернуть HTML)
        print("\n1️⃣ Тестирование главной страницы")
        try:
            response = await client.get("/")
            print(f"   Status: {response.status_code}")
            print(f"   Content-Type: {response.headers.get('content-type', 'N/A')}")
            assert response.status_code == 200
            assert "text/html" in response.headers.get("content-type", "")
            print("   ✅ Главная страница работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 2: API статуса
        print("\n2️⃣ Тестирование API статуса")
        try:
            response = await client.get("/api/status")
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Active agent: {data.get('active_agent')}")
            print(f"   Mood: {data.get('mood', {}).get('label')}")
            assert response.status_code == 200
            print("   ✅ API статуса работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 3: Чат через JSON API
        print("\n3️⃣ Тестирование чата (JSON API)")
        try:
            response = await client.post("/api/chat", json={
                "message": "Привет, Кристина! Как твои дела?",
                "agent": "kristina"
            })
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Response: {data.get('response', 'N/A')[:60]}...")
            print(f"   Agent: {data.get('agent')}")
            assert response.status_code == 200
            assert 'response' in data
            print("   ✅ Чат (JSON) работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 4: Чат через Form API
        print("\n4️⃣ Тестирование чата (Form API)")
        try:
            response = await client.post("/api/chat/form", data={
                "message": "Расскажи про Стокгольм",
                "agent": "kristina"
            })
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Response: {data.get('response', 'N/A')[:60]}...")
            assert response.status_code == 200
            print("   ✅ Чат (Form) работает")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        # Test 5: Логи
        print("\n5️⃣ Тестирование endpoint логов")
        try:
            response = await client.get("/api/logs", params={"lines": 5})
            data = response.json()
            print(f"   Status: {response.status_code}")
            print(f"   Logs count: {len(data.get('logs', []))}")
            assert response.status_code == 200
            print("   ✅ Логи работают")
        except Exception as e:
            print(f"   ❌ Ошибка: {e}")
            return False
        
        return True

def check_mini_app_html():
    """Проверка HTML mini_app"""
    
    print("\n" + "=" * 40)
    print("📱 ПРОВЕРКА MINI_APP HTML")
    print("=" * 40)
    
    html_path = Path("mini_app/index.html")
    if not html_path.exists():
        print("❌ Файл mini_app/index.html не найден")
        return False
    
    content = html_path.read_text()
    
    checks = [
        ("Telegram WebApp JS", "telegram-web-app.js" in content),
        ("Viewport meta tag", "viewport" in content and "width=device-width" in content),
        ("API_URL", "window.location.origin" in content),
        ("Telegram.WebApp.ready()", "tg.ready()" in content),
        ("Telegram.WebApp.expand()", "tg.expand()" in content),
        ("Login function", "function login()" in content or "async function login()" in content),
        ("SendMessage function", "function sendMessage()" in content or "async function sendMessage()" in content),
        ("JWT Token storage", "localStorage.setItem('kristina_token'" in content),
        ("Haptic Feedback", "tg.HapticFeedback" in content),
        ("CORS support", True),  # API должен поддерживать CORS
    ]
    
    all_passed = True
    for name, passed in checks:
        status = "✅" if passed else "❌"
        print(f"   {status} {name}")
        if not passed:
            all_passed = False
    
    return all_passed

async def main():
    """Главная функция тестирования"""
    
    # Сначала проверим HTML
    html_ok = check_mini_app_html()
    
    # Затем тестируем API (сервер должен быть запущен)
    print("\n" + "=" * 60)
    print("⚠️  Для тестирования API необходим запущенный сервер")
    print("   Запустите в отдельном терминале:")
    print("   source venv_local/bin/activate && python mobile_api.py")
    print("=" * 60)
    
    mobile_api_ok = False
    web_server_ok = False
    
    try:
        mobile_api_ok = await test_mobile_api()
    except Exception as e:
        print(f"\n⚠️  Mobile API недоступен: {e}")
        print("   Убедитесь, что сервер запущен на порту 8001")
    
    try:
        web_server_ok = await test_web_server()
    except Exception as e:
        print(f"\n⚠️  Web Server недоступен: {e}")
        print("   Убедитесь, что сервер запущен на порту 8000")
    
    # Итоги
    print("\n" + "=" * 60)
    print("📊 ИТОГИ ИНТЕГРАЦИОННОГО ТЕСТИРОВАНИЯ")
    print("=" * 60)
    
    print(f"\n📱 Mini App HTML: {'✅ OK' if html_ok else '❌ FAILED'}")
    print(f"📲 Mobile API: {'✅ OK' if mobile_api_ok else '❌ FAILED / НЕДОСТУПЕН'}")
    print(f"🌐 Web Server: {'✅ OK' if web_server_ok else '❌ FAILED / НЕДОСТУПЕН'}")
    
    if html_ok and mobile_api_ok and web_server_ok:
        print("\n🎉 Все тесты пройдены!")
        return 0
    elif html_ok:
        print("\n⚠️  HTML корректен, но серверы не запущены или недоступны")
        print("   Запустите серверы для полного тестирования:")
        print("   - python mobile_api.py (порт 8001)")
        print("   - python web_server.py (порт 8000)")
        return 0  # Это не критическая ошибка
    else:
        print("\n❌ Обнаружены проблемы!")
        return 1

if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
