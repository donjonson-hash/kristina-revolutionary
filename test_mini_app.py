#!/usr/bin/env python3
"""
Тестирование mini_app и всего проекта Kristina AI
"""

import asyncio
import sys
import traceback
from pathlib import Path

# Добавляем путь к проекту
sys.path.insert(0, str(Path(__file__).parent))

print("=" * 60)
print("🧪 ТЕСТИРОВАНИЕ ПРОЕКТА KRISTINA AI")
print("=" * 60)

errors = []
warnings = []

# Тест 1: Проверка импортов
print("\n📦 Тест 1: Проверка импортов модулей")
print("-" * 40)

modules_to_test = [
    ("agents", "router"),
    ("agents.router", "router"),
    ("agents.base_agent", "BaseAgent"),
    ("agents.kristina_persona", "KristinaPersonaAgent"),
    ("agents.kristina_advisor", "KristinaAdvisorAgent"),
    ("agents.kristina_creative", "KristinaCreativeAgent"),
    ("ai_client", "ai"),
    ("mood_engine", "mood_engine"),
    ("night_mode", "night_mode"),
    ("memory_wrapper", "get_user_memory"),
    ("persistent_memory", "PersistentMemory"),
    ("broadcast", "event_bus"),
    ("document_processor", "DocumentProcessor"),
    ("pricing_config", "calculate_price"),
    ("intent_detector", "detect_proposal_intent"),
    ("shared_context", "user_context"),
]

for module_name, attr_name in modules_to_test:
    try:
        module = __import__(module_name, fromlist=[attr_name])
        getattr(module, attr_name)
        print(f"  ✅ {module_name}.{attr_name}")
    except Exception as e:
        print(f"  ❌ {module_name}.{attr_name}: {e}")
        errors.append(f"Import error: {module_name}.{attr_name}: {e}")

# Тест 2: Проверка файлов mini_app
print("\n📱 Тест 2: Проверка файлов mini_app")
print("-" * 40)

mini_app_files = [
    "mini_app/index.html",
]

for file_path in mini_app_files:
    path = Path(file_path)
    if path.exists():
        print(f"  ✅ {file_path}")
    else:
        print(f"  ❌ {file_path} - файл не найден")
        errors.append(f"Missing file: {file_path}")

# Тест 3: Проверка структуры HTML
print("\n🌐 Тест 3: Проверка HTML mini_app")
print("-" * 40)

try:
    html_content = Path("mini_app/index.html").read_text()
    
    required_elements = [
        ("Telegram WebApp JS", "telegram-web-app.js"),
        ("Viewport meta", "viewport"),
        ("API_URL", "window.location.origin"),
        ("Telegram.WebApp", "Telegram.WebApp"),
        ("login function", "function login"),
        ("sendMessage function", "function sendMessage"),
        ("localStorage token", "localStorage.getItem"),
    ]
    
    for name, pattern in required_elements:
        if pattern in html_content:
            print(f"  ✅ {name}")
        else:
            print(f"  ⚠️  {name} не найден")
            warnings.append(f"Missing in HTML: {name}")
except Exception as e:
    print(f"  ❌ Ошибка чтения HTML: {e}")
    errors.append(f"HTML read error: {e}")

# Тест 4: Проверка агентов
print("\n🎭 Тест 4: Проверка агентов")
print("-" * 40)

try:
    from agents import router, KristinaPersonaAgent, KristinaAdvisorAgent, KristinaCreativeAgent
    
    # Проверяем создание агентов
    persona = KristinaPersonaAgent()
    print(f"  ✅ KristinaPersonaAgent создан")
    
    advisor = KristinaAdvisorAgent()
    print(f"  ✅ KristinaAdvisorAgent создан")
    
    creative = KristinaCreativeAgent()
    print(f"  ✅ KristinaCreativeAgent создан")
    
    # Проверяем регистрацию в роутере
    if not router.agents:
        print("  ⚠️  Роутер пуст, регистрируем агентов...")
        router.register_agent(persona, is_default=True)
        router.register_agent(advisor)
        router.register_agent(creative)
    
    print(f"  ✅ Агентов в роутере: {len(router.agents)}")
    
except Exception as e:
    print(f"  ❌ Ошибка агентов: {e}")
    traceback.print_exc()
    errors.append(f"Agent error: {e}")

# Тест 5: Проверка mobile_api
print("\n📲 Тест 5: Проверка mobile_api")
print("-" * 40)

try:
    # Проверяем синтаксис файла
    with open("mobile_api.py", "r") as f:
        compile(f.read(), "mobile_api.py", "exec")
    print("  ✅ mobile_api.py - синтаксис OK")
    
    # Проверяем импорт
    from mobile_api import app, store
    print("  ✅ mobile_api импортирован")
    
except Exception as e:
    print(f"  ❌ mobile_api error: {e}")
    errors.append(f"mobile_api error: {e}")

# Тест 6: Проверка web_server
print("\n🖥️  Тест 6: Проверка web_server")
print("-" * 40)

try:
    with open("web_server.py", "r") as f:
        compile(f.read(), "web_server.py", "exec")
    print("  ✅ web_server.py - синтаксис OK")
    
    from web_server import app
    print("  ✅ web_server импортирован")
    
except Exception as e:
    print(f"  ❌ web_server error: {e}")
    errors.append(f"web_server error: {e}")

# Тест 7: Проверка bot.py
print("\n🤖 Тест 7: Проверка bot.py")
print("-" * 40)

try:
    with open("bot.py", "r") as f:
        compile(f.read(), "bot.py", "exec")
    print("  ✅ bot.py - синтаксис OK")
    
except Exception as e:
    print(f"  ❌ bot.py error: {e}")
    errors.append(f"bot.py error: {e}")

# Тест 8: Проверка .env и конфигурации
print("\n⚙️  Тест 8: Проверка конфигурации")
print("-" * 40)

try:
    from dotenv import load_dotenv
    import os
    
    load_dotenv()
    
    required_env = [
        "KRISTINA_TELEGRAM_TOKEN",
        "DEEPSEEK_API_KEY",
    ]
    
    for env_var in required_env:
        value = os.getenv(env_var)
        if value:
            masked = value[:10] + "..." if len(value) > 10 else "***"
            print(f"  ✅ {env_var}: {masked}")
        else:
            print(f"  ⚠️  {env_var}: не установлен")
            warnings.append(f"Missing env: {env_var}")
            
except Exception as e:
    print(f"  ❌ Config error: {e}")
    errors.append(f"Config error: {e}")

# Тест 9: Проверка базы данных
print("\n💾 Тест 9: Проверка базы данных")
print("-" * 40)

try:
    from persistent_memory import PersistentMemory
    
    # Проверяем существование БД
    db_path = Path("kristina_memory.db")
    if db_path.exists():
        size = db_path.stat().st_size / 1024
        print(f"  ✅ БД существует: {size:.1f} KB")
    else:
        print(f"  ⚠️  БД не существует, будет создана при запуске")
        warnings.append("DB not exists")
    
    # Тестируем создание и чтение
    memory = PersistentMemory()
    memory.save_message("test_session", "user", "Тестовое сообщение", channel="test")
    messages = memory.get_recent_messages("test_session", limit=1)
    
    if messages:
        print(f"  ✅ Запись/чтение БД работает")
    else:
        print(f"  ⚠️  БД не возвращает сообщения")
        warnings.append("DB read failed")
        
except Exception as e:
    print(f"  ❌ DB error: {e}")
    errors.append(f"DB error: {e}")

# Тест 10: Асинхронный тест агентов
print("\n🔄 Тест 10: Асинхронный тест обработки сообщений")
print("-" * 40)

async def test_agents_async():
    try:
        from agents import router
        
        # Проверяем обработку сообщения
        test_message = "Привет, Кристина!"
        context = {"user_id": "test_user", "source": "test"}
        
        if router.agents:
            response = await router.process(test_message, context)
            print(f"  ✅ Агенты отвечают")
            print(f"     Ответ: {str(response.content)[:50]}...")
        else:
            print(f"  ⚠️  Нет зарегистрированных агентов")
            warnings.append("No agents registered")
            
    except Exception as e:
        print(f"  ❌ Async test error: {e}")
        errors.append(f"Async test error: {e}")

try:
    asyncio.run(test_agents_async())
except Exception as e:
    print(f"  ❌ Async runtime error: {e}")
    errors.append(f"Async runtime error: {e}")

# Закрываем AI клиент
try:
    from ai_client import ai
    if ai._session:
        asyncio.run(ai.close())
except:
    pass

# Итоги
print("\n" + "=" * 60)
print("📊 ИТОГИ ТЕСТИРОВАНИЯ")
print("=" * 60)

if errors:
    print(f"\n❌ Найдено ошибок: {len(errors)}")
    for i, error in enumerate(errors[:5], 1):
        print(f"   {i}. {error}")
    if len(errors) > 5:
        print(f"   ... и ещё {len(errors) - 5}")
else:
    print("\n✅ Ошибок не найдено")

if warnings:
    print(f"\n⚠️  Предупреждений: {len(warnings)}")
    for i, warning in enumerate(warnings[:5], 1):
        print(f"   {i}. {warning}")
    if len(warnings) > 5:
        print(f"   ... и ещё {len(warnings) - 5}")
else:
    print("\n✅ Предупреждений нет")

print("\n" + "=" * 60)
print("🏁 Тестирование завершено")
print("=" * 60)

sys.exit(1 if errors else 0)
