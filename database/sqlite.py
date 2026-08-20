"""
SQLite async wrapper для совместимости с PostgreSQL интерфейсом
"""

import aiosqlite
import json
import logging
from typing import List, Dict, Optional, Any
from pathlib import Path

logger = logging.getLogger(__name__)


class SQLiteManager:
    """
    Async SQLite manager с интерфейсом как у PostgreSQL
    """
    
    def __init__(self, db_path: str = "kristina_memory.db"):
        self.db_path = db_path
        self._conn: Optional[aiosqlite.Connection] = None
    
    async def connect(self):
        """Connect to database"""
        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row
        logger.info(f"✅ SQLite connected: {self.db_path}")
    
    async def disconnect(self):
        """Close connection"""
        if self._conn:
            await self._conn.close()
            self._conn = None
            logger.info("🔌 SQLite disconnected")

    async def init_tables(self):
        """Создать таблицы, которые использует менеджер"""
        await self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                agent TEXT,
                timestamp TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                agent TEXT,
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS freelance_projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT,
                client_id INTEGER,
                description TEXT,
                status TEXT,
                attachments TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS dialog_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                message TEXT,
                response TEXT,
                agent TEXT,
                sentiment TEXT,
                timestamp TEXT
            );
        """)
        await self._conn.commit()
    
    async def save_message(self, session_id: str, role: str, content: str, 
                          agent: str = None, metadata: dict = None) -> int:
        """Save message"""
        cursor = await self._conn.execute(
            """
            INSERT INTO messages (session_id, role, content, agent, timestamp)
            VALUES (?, ?, ?, ?, datetime('now'))
            """,
            (session_id, role, content, agent)
        )
        await self._conn.commit()
        return cursor.lastrowid
    
    async def get_messages(self, session_id: str, limit: int = 50) -> List[Dict]:
        """Get messages"""
        cursor = await self._conn.execute(
            """
            SELECT id, role, content, agent, timestamp
            FROM messages
            WHERE session_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (session_id, limit)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    
    async def save_session(self, session_id: str, user_id: int = None, 
                          agent: str = 'kristina', context: dict = None):
        """Save session"""
        await self._conn.execute(
            """
            INSERT OR REPLACE INTO sessions (id, user_id, agent, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            """,
            (session_id, user_id, agent)
        )
        await self._conn.commit()
    
    async def get_session(self, session_id: str) -> Optional[Dict]:
        """Get session"""
        cursor = await self._conn.execute(
            "SELECT * FROM sessions WHERE id = ?",
            (session_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    
    async def save_project(self, project_data: Dict) -> int:
        """Save freelance project"""
        cursor = await self._conn.execute(
            """
            INSERT OR REPLACE INTO freelance_projects 
            (project_id, client_id, description, status, attachments, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                project_data.get('project_id'),
                project_data.get('client_id'),
                project_data.get('description'),
                project_data.get('status', 'draft'),
                json.dumps(project_data.get('attachments', []))
            )
        )
        await self._conn.commit()
        return cursor.lastrowid
    
    async def get_projects(self, client_id: int = None) -> List[Dict]:
        """Get projects"""
        if client_id:
            cursor = await self._conn.execute(
                "SELECT * FROM freelance_projects WHERE client_id = ? ORDER BY created_at DESC",
                (client_id,)
            )
        else:
            cursor = await self._conn.execute("SELECT * FROM freelance_projects ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    
    async def save_dialog(self, user_id: int, message: str, response: str, 
                         agent: str = None, sentiment: str = None) -> int:
        """Save dialog"""
        cursor = await self._conn.execute(
            """
            INSERT INTO dialog_history (user_id, message, response, agent, timestamp)
            VALUES (?, ?, ?, ?, datetime('now'))
            """,
            (user_id, message, response, agent)
        )
        await self._conn.commit()
        return cursor.lastrowid
    
    async def get_dialog_history(self, user_id: int, limit: int = 100) -> List[Dict]:
        """Get dialog history"""
        cursor = await self._conn.execute(
            """
            SELECT * FROM dialog_history
            WHERE user_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (user_id, limit)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    
    async def add_knowledge(self, category: str, topic: str, content: str, 
                           source: str = None, confidence: float = 1.0) -> int:
        """Add knowledge"""
        # SQLite версия kristina_knowledge.db
        async with aiosqlite.connect("kristina_knowledge.db") as db:
            cursor = await db.execute(
                """
                INSERT INTO knowledge (category, topic, content, source, confidence)
                VALUES (?, ?, ?, ?, ?)
                """,
                (category, topic, content, source, confidence)
            )
            await db.commit()
            return cursor.lastrowid
    
    async def search_knowledge(self, query: str, category: str = None, limit: int = 10) -> List[Dict]:
        """Search knowledge"""
        async with aiosqlite.connect("kristina_knowledge.db") as db:
            db.row_factory = aiosqlite.Row
            if category:
                cursor = await db.execute(
                    """
                    SELECT * FROM knowledge
                    WHERE category = ? AND (content LIKE ? OR topic LIKE ?)
                    ORDER BY confidence DESC
                    LIMIT ?
                    """,
                    (category, f"%{query}%", f"%{query}%", limit)
                )
            else:
                cursor = await db.execute(
                    """
                    SELECT * FROM knowledge
                    WHERE content LIKE ? OR topic LIKE ?
                    ORDER BY confidence DESC
                    LIMIT ?
                    """,
                    (f"%{query}%", f"%{query}%", limit)
                )
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get stats"""
        stats = {}
        for table in ['messages', 'sessions', 'freelance_projects', 'dialog_history']:
            cursor = await self._conn.execute(f"SELECT COUNT(*) FROM {table}")
            row = await cursor.fetchone()
            stats[table] = row[0] if row else 0
        return stats
Database = SQLiteManager  # Alias for backward compatibility
