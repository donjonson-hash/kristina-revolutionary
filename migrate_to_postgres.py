#!/usr/bin/env python3
"""
Миграция данных из SQLite в PostgreSQL
Сохраняет все существующие данные!
"""

import asyncio
import aiosqlite
import json
import logging
from pathlib import Path
from datetime import datetime

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)


async def migrate_sqlite_to_postgres():
    """
    Основная функция миграции
    """
    logger.info("=" * 60)
    logger.info("🚀 НАЧИНАЕМ МИГРАЦИЮ SQLite → PostgreSQL")
    logger.info("=" * 60)
    
    # Импортируем здесь чтобы не падать если asyncpg не установлен
    try:
        from database.postgres import PostgresManager
    except ImportError as e:
        logger.error(f"❌ Ошибка импорта: {e}")
        logger.error("Установите: pip install asyncpg")
        return False
    
    # Подключаемся к PostgreSQL
    logger.info("\n📡 Подключение к PostgreSQL...")
    pg = PostgresManager()
    try:
        await pg.connect()
        await pg.init_tables()
        logger.info("✅ PostgreSQL готов")
    except Exception as e:
        logger.error(f"❌ Не удалось подключиться к PostgreSQL: {e}")
        logger.error("Убедитесь что PostgreSQL запущен и настройки в .env корректны")
        return False
    
    # Мигрируем каждую базу SQLite
    results = {
        'kristina_memory.db': await migrate_memory_db(pg),
        'freelance.db': await migrate_freelance_db(pg),
        'kristina_knowledge.db': await migrate_knowledge_db(pg),
    }
    
    # Отключаемся
    await pg.disconnect()
    
    # Итоги
    logger.info("\n" + "=" * 60)
    logger.info("📊 ИТОГИ МИГРАЦИИ")
    logger.info("=" * 60)
    
    total_migrated = 0
    for db_name, count in results.items():
        if count >= 0:
            logger.info(f"   ✅ {db_name}: {count} записей")
            total_migrated += count
        else:
            logger.info(f"   ⚠️  {db_name}: пропущена (файл не найден)")
    
    logger.info(f"\n🎉 Всего мигрировано: {total_migrated} записей")
    logger.info("=" * 60)
    
    return True


async def migrate_memory_db(pg) -> int:
    """Миграция kristina_memory.db"""
    db_path = "kristina_memory.db"
    if not Path(db_path).exists():
        logger.warning(f"⚠️  {db_path} не найдена")
        return -1
    
    logger.info(f"\n📦 Миграция {db_path}...")
    count = 0
    
    async with aiosqlite.connect(db_path) as sqlite_db:
        sqlite_db.row_factory = aiosqlite.Row
        
        # Messages
        try:
            cursor = await sqlite_db.execute("SELECT * FROM messages")
            rows = await cursor.fetchall()
            for row in rows:
                await pg.save_message(
                    session_id=row['session_id'],
                    role=row['role'],
                    content=row['content'],
                    agent=row.get('agent'),
                    metadata=json.loads(row['metadata']) if row.get('metadata') else {}
                )
                count += 1
            logger.info(f"   ✅ Messages: {len(rows)}")
        except Exception as e:
            logger.warning(f"   ⚠️  Messages: {e}")
        
        # Sessions
        try:
            cursor = await sqlite_db.execute("SELECT * FROM sessions")
            rows = await cursor.fetchall()
            for row in rows:
                await pg.save_session(
                    session_id=row['id'],
                    user_id=row.get('user_id'),
                    agent=row.get('agent', 'kristina'),
                    context=json.loads(row['context']) if row.get('context') else {}
                )
                count += 1
            logger.info(f"   ✅ Sessions: {len(rows)}")
        except Exception as e:
            logger.warning(f"   ⚠️  Sessions: {e}")
        
        # Dialog history
        try:
            cursor = await sqlite_db.execute("SELECT * FROM dialog_history")
            rows = await cursor.fetchall()
            for row in rows:
                await pg.save_dialog(
                    user_id=row['user_id'],
                    message=row['message'],
                    response=row['response'],
                    agent=row.get('agent'),
                    sentiment=row.get('sentiment')
                )
                count += 1
            logger.info(f"   ✅ Dialog history: {len(rows)}")
        except Exception as e:
            logger.warning(f"   ⚠️  Dialog history: {e}")
    
    return count


async def migrate_freelance_db(pg) -> int:
    """Миграция freelance.db"""
    db_path = "freelance.db"
    if not Path(db_path).exists():
        logger.warning(f"⚠️  {db_path} не найдена")
        return -1
    
    logger.info(f"\n📦 Миграция {db_path}...")
    count = 0
    
    async with aiosqlite.connect(db_path) as sqlite_db:
        sqlite_db.row_factory = aiosqlite.Row
        
        try:
            # Пробуем разные имена таблиц
            tables = ['freelance_projects', 'projects']
            for table in tables:
                try:
                    cursor = await sqlite_db.execute(f"SELECT * FROM {table}")
                    rows = await cursor.fetchall()
                    
                    for row in rows:
                        project_data = {
                            'project_id': str(row.get('id', row.get('project_id'))),
                            'client_id': row.get('client_id', 0),
                            'title': row.get('title', 'Untitled'),
                            'description': row.get('description', ''),
                            'status': row.get('status', 'draft'),
                            'budget_range': row.get('budget'),
                            'timeline': row.get('timeline'),
                            'attachments': json.loads(row['attachments']) if row.get('attachments') else []
                        }
                        await pg.save_project(project_data)
                        count += 1
                    
                    logger.info(f"   ✅ Freelance projects: {len(rows)}")
                    break
                except aiosqlite.OperationalError:
                    continue
                    
        except Exception as e:
            logger.warning(f"   ⚠️  Freelance projects: {e}")
    
    return count


async def migrate_knowledge_db(pg) -> int:
    """Миграция kristina_knowledge.db"""
    db_path = "kristina_knowledge.db"
    if not Path(db_path).exists():
        logger.warning(f"⚠️  {db_path} не найдена")
        return -1
    
    logger.info(f"\n📦 Миграция {db_path}...")
    count = 0
    
    async with aiosqlite.connect(db_path) as sqlite_db:
        sqlite_db.row_factory = aiosqlite.Row
        
        try:
            cursor = await sqlite_db.execute("SELECT * FROM knowledge")
            rows = await cursor.fetchall()
            
            for row in rows:
                await pg.add_knowledge(
                    category=row.get('category', 'general'),
                    topic=row.get('topic', 'Unknown'),
                    content=row['content'],
                    source=row.get('source'),
                    confidence=row.get('confidence', 1.0)
                )
                count += 1
            
            logger.info(f"   ✅ Knowledge: {len(rows)}")
        except Exception as e:
            logger.warning(f"   ⚠️  Knowledge: {e}")
    
    return count


async def verify_migration():
    """Проверка что миграция успешна"""
    from database.postgres import PostgresManager
    
    pg = PostgresManager()
    await pg.connect()
    
    stats = await pg.get_stats()
    
    logger.info("\n📊 Проверка данных в PostgreSQL:")
    for table, count in stats.items():
        logger.info(f"   {table}: {count} записей")
    
    await pg.disconnect()
    
    return stats


if __name__ == "__main__":
    # Загружаем .env
    from dotenv import load_dotenv
    load_dotenv()
    
    # Запускаем миграцию
    success = asyncio.run(migrate_sqlite_to_postgres())
    
    if success:
        # Проверяем
        asyncio.run(verify_migration())
        
        logger.info("\n" + "=" * 60)
        logger.info("✅ МИГРАЦИЯ ЗАВЕРШЕНА УСПЕШНО!")
        logger.info("=" * 60)
        logger.info("\nСледующие шаги:")
        logger.info("1. Обновите .env: DATABASE_MODE=postgres")
        logger.info("2. Перезапустите бота: python bot.py")
        logger.info("3. Старые .db файлы можно архивировать")
    else:
        logger.error("\n❌ МИГРАЦИЯ НЕ УДАЛАСЬ")
        logger.error("Проверьте:")
        logger.error("1. Установлен ли PostgreSQL")
        logger.error("2. Корректны ли настройки в .env")
        logger.error("3. Установлен ли asyncpg: pip install asyncpg")
