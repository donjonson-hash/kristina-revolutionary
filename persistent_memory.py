import sqlite3
import json
from datetime import datetime
from typing import List, Dict, Optional
import threading

DB_PATH = "kristina_memory.db"

class PersistentMemory:
    """SQLite-хранилище диалогов (синхронная версия)"""
    
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._local = threading.local()
        self._init_db()
    
    def _get_connection(self):
        """Получить соединение с БД (потокобезопасно)"""
        if not hasattr(self._local, 'connection'):
            self._local.connection = sqlite3.connect(self.db_path, check_same_thread=False)
            self._local.connection.row_factory = sqlite3.Row
        return self._local.connection
    
    def _init_db(self):
        """Инициализация базы данных"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Основная таблица сообщений
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                speaker TEXT,
                channel TEXT DEFAULT 'unknown',
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Таблица сессий
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                user_name TEXT,
                channel TEXT,
                voice_preference TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_session ON messages(session_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)")
        
        conn.commit()
        conn.close()
        print(f"✅ База данных готова: {self.db_path}")
    
    def save_message(self, session_id: str, role: str, content: str, 
                     speaker: str = None, channel: str = 'unknown'):
        """Сохранить сообщение"""
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            """INSERT INTO messages (session_id, role, content, speaker, channel, timestamp)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session_id, role, content, speaker, channel, datetime.now().isoformat())
        )
        conn.commit()
    
    def get_recent_messages(self, session_id: str, limit: int = 10) -> List[Dict]:
        """Получить последние сообщения сессии"""
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            """SELECT role, content, speaker, timestamp 
               FROM messages 
               WHERE session_id = ? 
               ORDER BY timestamp DESC 
               LIMIT ?""",
            (session_id, limit)
        )
        
        rows = cursor.fetchall()
        return [dict(row) for row in reversed(rows)]
    
    def get_session_history(self, session_id: str) -> List[Dict]:
        """Получить всю историю сессии"""
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            """SELECT role, content, speaker, timestamp, channel 
               FROM messages 
               WHERE session_id = ? 
               ORDER BY timestamp ASC""",
            (session_id,)
        )
        
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    
    def get_context_for_llm(self, session_id: str, limit: int = 5) -> List[Dict]:
        """Получить контекст для LLM"""
        messages = self.get_recent_messages(session_id, limit)
        return [{"role": m["role"], "content": m["content"]} for m in messages]
    
    def get_all_sessions(self) -> List[str]:
        """Получить список всех сессий"""
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute("SELECT DISTINCT session_id FROM messages ORDER BY timestamp DESC")
        rows = cursor.fetchall()
        return [row[0] for row in rows]
    
    def get_stats(self) -> Dict:
        """Статистика базы данных"""
        conn = self._get_connection()
        cursor = conn.cursor()
        
        cursor.execute("SELECT COUNT(*) FROM messages")
        total_messages = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(DISTINCT session_id) FROM messages")
        total_sessions = cursor.fetchone()[0]
        
        return {
            "total_messages": total_messages,
            "total_sessions": total_sessions
        }
    
    def close(self):
        """Закрыть соединение"""
        if hasattr(self._local, 'connection'):
            self._local.connection.close()
            del self._local.connection


# Глобальный инстанс
_memory_instance = None

def get_memory() -> PersistentMemory:
    """Получить глобальный инстанс PersistentMemory"""
    global _memory_instance
    if _memory_instance is None:
        _memory_instance = PersistentMemory()
    return _memory_instance

    # Alias methods for test compatibility
    def get_messages(self, session_id: str, limit: int = 10) -> List[Dict]:
        return self.get_recent_messages(session_id, limit)
    
    def search_messages(self, session_id: str, keyword: str) -> List[Dict]:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND content LIKE ? ORDER BY timestamp DESC",
            (session_id, f"%{keyword}%")
        )
        rows = cursor.fetchall()
        conn.close()
        return [{"role": r[0], "content": r[1], "timestamp": r[2]} for r in rows]
    
    def clear_user(self, session_id: str) -> None:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        conn.commit()
        conn.close()
