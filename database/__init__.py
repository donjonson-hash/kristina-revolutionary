"""
Database module - поддержка SQLite и PostgreSQL
"""

from .postgres import PostgresManager
from .sqlite import SQLiteManager
from .manager import DatabaseManager, db_manager

__all__ = ['PostgresManager', 'SQLiteManager', 'DatabaseManager', 'db_manager']
