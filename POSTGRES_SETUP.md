# 🐘 Миграция на PostgreSQL

## Быстрый старт

### 1. Установка PostgreSQL

```bash
# Для Ubuntu/Debian
sudo apt update
sudo apt install -y postgresql postgresql-contrib

# Для macOS
brew install postgresql
brew services start postgresql

# Для Docker
docker run --name kristina-postgres \
  -e POSTGRES_USER=kristina \
  -e POSTGRES_PASSWORD=your_secure_password \
  -e POSTGRES_DB=kristina_db \
  -p 5432:5432 \
  -d postgres:15
```

### 2. Создание базы и пользователя

```bash
# Если используете системный PostgreSQL
sudo -u postgres psql << EOF
CREATE USER kristina_user WITH PASSWORD 'your_secure_password';
CREATE DATABASE kristina_db OWNER kristina_user;
GRANT ALL PRIVILEGES ON DATABASE kristina_db TO kristina_user;
\c kristina_db
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- для fuzzy search
EOF
```

### 3. Настройка .env

Добавьте в `.env`:

```bash
# PostgreSQL
DATABASE_URL=postgresql://kristina_user:your_secure_password@localhost:5432/kristina_db
# Или отдельные параметры
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=kristina_db
POSTGRES_USER=kristina_user
POSTGRES_PASSWORD=your_secure_password

# Режим работы: sqlite | postgres
DATABASE_MODE=postgres
```

### 4. Установка зависимостей

```bash
source venv_local/bin/activate
pip install asyncpg
```

### 5. Миграция данных

```bash
python migrate_to_postgres.py
```

Это перенесёт все данные из SQLite в PostgreSQL.

### 6. Запуск

```bash
python bot.py  # или python mobile_api.py
```

---

## 📊 Сравнение до/после

| Параметр | SQLite | PostgreSQL |
|----------|--------|------------|
| Макс. размер | 281 TB | Неограничен |
| Concurrent writes | 1 | Множество |
| JSON поддержка | ✅ | ✅ (JSONB - лучше) |
| Full-text search | Ограниченно | ✅ Встроено |
| Репликация | ❌ | ✅ |
| Backups | Файловая копия | pg_dump, WAL |

---

## 🔧 Откат к SQLite

Если нужно вернуться:

```bash
# Изменить в .env
DATABASE_MODE=sqlite
```

Все данные останутся в `.db` файлах.
