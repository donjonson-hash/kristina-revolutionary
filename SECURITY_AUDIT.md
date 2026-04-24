# 🔒 Аудит безопасности - Что нужно исправить

## 1. ❌ Нет Rate Limiting

**Проблема:** Любой может DDoS'ить API

**Решение:**
```python
# pip install slowapi
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app = FastAPI()
app.state.limiter = limiter

@app.post("/chat")
@limiter.limit("10/minute")  # 10 запросов в минуту
async def chat(request: Request, ...):
    ...
```

## 2. ❌ Нет Health Check

**Проблема:** Не знаем, жив ли сервис

**Решение:**
```python
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow(),
        "version": "1.0.0",
        "services": {
            "database": await check_db(),
            "ai": await check_ai(),
            "memory": get_memory_usage()
        }
    }
```

## 3. ❌ Нет Graceful Shutdown

**Проблема:** Данные могут потеряться при перезапуске

**Решение:**
```python
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down...")
    await db_manager.disconnect()
    await ai_client.close()
```

## 4. ❌ Логи только в консоль

**Проблема:** Логи теряются при перезапуске

**Решение:**
```python
import logging
from logging.handlers import RotatingFileHandler

handler = RotatingFileHandler(
    'logs/kristina.log',
    maxBytes=10*1024*1024,  # 10MB
    backupCount=5
)
logging.basicConfig(
    level=logging.INFO,
    handlers=[handler, logging.StreamHandler()]
)
```

## 5. ❌ Нет Input Sanitization

**Проблема:** XSS через чат возможен

**Решение:**
```python
from markupsafe import escape
import bleach

def sanitize_input(text: str) -> str:
    # Удаляем HTML теги
    clean = bleach.clean(text, tags=[], strip=True)
    return clean
```

## 6. ❌ CORS слишком широкий

**Проблема:** `allow_origins=["*"]` - любой сайт может делать запросы

**Решение:**
```python
# Только нужные origins
origins = [
    "https://t.me",
    "https://web.telegram.org",
    "http://localhost:8000",
    "http://localhost:3000"
]
```

## 7. ❌ Нет Backup стратегии

**Проблема:** Данные не бэкапятся

**Решение:**
```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
cp kristina_memory.db backups/kristina_memory_$DATE.db
find backups/ -name "*.db" -mtime +7 -delete  # удалять старше 7 дней
```

## 8. ❌ JWT Secret слишком простой

**Проблема:** `kristina-mobile-secret-key-2024` - предсказуемый

**Решение:**
```bash
# Генерируем случайный ключ
openssl rand -hex 32
```

## 9. ❌ Нет Request ID

**Проблема:** Невозможно отследить цепочку запросов

**Решение:**
```python
import uuid

@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response
```

## 10. ❌ SQL запросы без параметризации

**Проверка:** Все ли запросы безопасны?
```python
# Безопасно ✅
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))

# Опасно ❌
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
```
