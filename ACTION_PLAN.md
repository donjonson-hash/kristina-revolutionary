# 📋 План действий - Что нужно сделать

## 🔴 СРОЧНО (Сегодня/Завтра)

### 1. Исправить CORS (5 минут)
```python
# mobile_api.py
origins = [
    "https://t.me",
    "https://web.telegram.org", 
    "http://localhost:8000",
    "http://localhost:3000",
    "http://127.0.0.1:8000"
]
```

### 2. Сменить JWT Secret (2 минуты)
```bash
# Сгенерировать новый
openssl rand -hex 32

# Добавить в .env
JWT_SECRET_KEY=<сгенерированный_ключ>
```

### 3. Добавить Health Check (10 минут)
```python
# mobile_api.py
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "1.0.0"
    }
```

---

## 🟡 ВАЖНО (Эта неделя)

### 4. Rate Limiting (30 минут)
```bash
pip install slowapi
```

```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.post("/chat")
@limiter.limit("30/minute")
async def chat(...)...
```

### 5. Graceful Shutdown (15 минут)
```python
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down gracefully...")
    await db_manager.disconnect()
    # Закрыть все соединения
```

### 6. Логирование в файл (20 минут)
```python
import logging
from logging.handlers import RotatingFileHandler

# Создать директорию
os.makedirs("logs", exist_ok=True)

handler = RotatingFileHandler(
    "logs/kristina.log",
    maxBytes=10*1024*1024,  # 10MB
    backupCount=5
)
```

### 7. Backup скрипт (15 минут)
```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p backups
cp *.db backups/
tar -czf "backups/kristina_$DATE.tar.gz" backups/*.db
# Оставить только последние 7 бэкапов
ls -t backups/*.tar.gz | tail -n +8 | xargs -r rm
```

---

## 🟢 ЖЕЛАТЕЛЬНО (Следующие 2 недели)

### 8. Unit Tests (2-3 часа)
```bash
pip install pytest pytest-asyncio
mkdir tests/
```

### 9. Input Sanitization (30 минут)
```bash
pip install bleach
```

```python
def sanitize(text: str) -> str:
    return bleach.clean(text, tags=[], strip=True)
```

### 10. Admin Panel (2 часа)
Простая страница `/admin` с:
- Статистикой пользователей
- Просмотром логов
- Управлением knowledge base

### 11. Request ID (20 минут)
```python
@app.middleware("http")
async def add_request_id(request, call_next):
    request_id = str(uuid.uuid4())[:8]
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response
```

---

## 🔵 ОПЦИОНАЛЬНО (Месяц)

### 12. Redis Cache (2 часа)
```bash
pip install redis
```

### 13. Docker (3 часа)
```dockerfile
FROM python:3.12-slim
...
```

### 14. CI/CD (2 часа)
GitHub Actions для:
- Запуска тестов
- Линтинга
- Деплоя

### 15. Sentry (30 минут)
```bash
pip install sentry-sdk
```

---

## 📊 Сводка по времени

| Приоритет | Задачи | Время |
|-----------|--------|-------|
| 🔴 Срочно | 3 шт | ~20 минут |
| 🟡 Важно | 5 шт | ~2 часа |
| 🟢 Желательно | 4 шт | ~8 часов |
| 🔵 Опционально | 4 шт | ~8 часов |

**Итого:** 20 минут для критических, 2 часа для базовой безопасности

---

## 🎯 Минимальный viable production (MVP)

Для запуска в production достаточно:

1. ✅ **Сделано:** Работающий бот
2. ✅ **Сделано:** API endpoints
3. ✅ **Сделано:** База данных
4. 🔴 **Нужно:** Исправить CORS
5. 🔴 **Нужно:** Сменить JWT Secret
6. 🟡 **Желательно:** Rate Limiting
7. 🟡 **Желательно:** Health Check
8. 🟡 **Желательно:** Логи в файл
9. 🟡 **Желательно:** Бэкапы

---

## 🚀 Готовность к запуску

Текущая готовность: **75%**

После исправления 🔴: **85%**

После добавления 🟡: **95%**

