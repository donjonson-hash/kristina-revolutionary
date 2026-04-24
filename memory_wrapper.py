"""
Обёртка для PersistentMemory (синхронный доступ)
"""

from persistent_memory import PersistentMemory

# Глобальный экземпляр
memory = PersistentMemory()

def get_user_memory(user_id: str, limit: int = 10):
    """Получает историю пользователя"""
    try:
        messages = memory.get_recent_messages(f"user_{user_id}", limit=limit)
        return {
            "messages": messages,
            "topics": extract_topics(messages)
        }
    except Exception as e:
        print(f"Memory read error: {e}")
        return {"messages": [], "topics": []}

def save_interaction(user_id: str, user_input: str, response: str):
    """Сохраняет диалог"""
    try:
        session_id = f"user_{user_id}"
        memory.save_message(session_id, "user", user_input, channel="web")
        memory.save_message(session_id, "assistant", response, channel="web")
    except Exception as e:
        print(f"Memory write error: {e}")

def extract_topics(messages: list) -> list:
    """Извлекает темы из сообщений (простая версия)"""
    topics = []
    for msg in messages:
        content = msg.get("content", "")
        # Ищем ключевые слова
        if any(word in content.lower() for word in ["работа", "дизайн", "ux"]):
            topics.append("работа")
        if any(word in content.lower() for word in ["личное", "дом", "семья"]):
            topics.append("личное")
    return list(set(topics))[-3:]  # Последние 3 темы

# Инициализация при импорте
try:
    # PersistentMemory уже инициализирован в конструкторе
    print("✅ PersistentMemory initialized")
except Exception as e:
    print(f"Memory init error: {e}")
