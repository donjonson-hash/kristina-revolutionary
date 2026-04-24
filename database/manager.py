"""
Unified Database Manager
Автоматически выбирает между SQLite и PostgreSQL
"""

import os
import logging
from typing import Optional, Union

from .sqlite import SQLiteManager
from .postgres import PostgresManager

logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    Унифицированный менеджер баз данных.
    Выбирает между SQLite и PostgreSQL на основе .env
    """
    
    def __init__(self):
        self.mode = os.getenv('DATABASE_MODE', 'sqlite').lower()
        self._db: Optional[Union[SQLiteManager, PostgresManager]] = None
        
    async def connect(self):
        """Подключение к базе данных"""
        if self.mode == 'postgres':
            try:
                self._db = PostgresManager()
                await self._db.connect()
                await self._db.init_tables()
                logger.info("✅ Using PostgreSQL")
            except Exception as e:
                logger.error(f"❌ PostgreSQL failed: {e}")
                logger.warning("⚠️  Falling back to SQLite")
                self.mode = 'sqlite'
                self._db = SQLiteManager()
                await self._db.connect()
        else:
            self._db = SQLiteManager()
            await self._db.connect()
            logger.info("✅ Using SQLite")
    
    async def disconnect(self):
        """Отключение"""
        if self._db:
            await self._db.disconnect()
    
    @property
    def db(self):
        """Получить текущее подключение"""
        return self._db
    
    # ═══════════════════════════════════════════════════════════════
    # Прокси-методы
    # ═══════════════════════════════════════════════════════════════
    
    async def save_message(self, *args, **kwargs):
        return await self._db.save_message(*args, **kwargs)
    
    async def get_messages(self, *args, **kwargs):
        return await self._db.get_messages(*args, **kwargs)
    
    async def save_session(self, *args, **kwargs):
        return await self._db.save_session(*args, **kwargs)
    
    async def get_session(self, *args, **kwargs):
        return await self._db.get_session(*args, **kwargs)
    
    async def save_project(self, *args, **kwargs):
        return await self._db.save_project(*args, **kwargs)
    
    async def get_projects(self, *args, **kwargs):
        return await self._db.get_projects(*args, **kwargs)
    
    async def save_dialog(self, *args, **kwargs):
        return await self._db.save_dialog(*args, **kwargs)
    
    async def get_dialog_history(self, *args, **kwargs):
        return await self._db.get_dialog_history(*args, **kwargs)
    
    async def add_knowledge(self, *args, **kwargs):
        return await self._db.add_knowledge(*args, **kwargs)
    
    async def search_knowledge(self, *args, **kwargs):
        return await self._db.search_knowledge(*args, **kwargs)
    
    async def get_stats(self):
        return await self._db.get_stats()


# Глобальный инстанс
db_manager = DatabaseManager()
