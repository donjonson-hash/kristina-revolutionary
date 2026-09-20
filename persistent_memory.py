import sqlite3
import json
from datetime import datetime, timezone
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
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS cognitive_interests (
                session_id TEXT PRIMARY KEY,
                topic TEXT NOT NULL,
                reflection TEXT NOT NULL,
                source_quote TEXT NOT NULL,
                source_message_id INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_session ON messages(session_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)")
        
        from intention_cycle import init_tables
        init_tables(conn)
        from dialogue_state import init_tables as init_dialogue_tables
        init_dialogue_tables(conn)
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
               ORDER BY id DESC
               LIMIT ?""",
            (session_id, limit)
        )
        
        rows = cursor.fetchall()
        return [dict(row) for row in reversed(rows)]

    def save_exchange(self, session_id: str, user_input: str, response: str,
                      channel: str = 'unknown', appraisal=None, event_id=None,
                      expected_revision=None, now=None, speaker=None):
        """Commit turn, dialogue receipt and source-linked interest atomically.

        Stable transport event IDs replay committed replies without new writes.
        The caller should also check get_exchange before invoking a model.
        """
        from dialogue_state import _get_exchange, _now, apply_exchange
        conn = self._get_connection()
        now = _now(now)
        timestamp = now.isoformat()
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            previous = _get_exchange(conn, session_id, event_id, user_input)
            if previous is not None:
                return previous
            if appraisal is not None:
                from dataclasses import asdict
                from cognitive_appraisal import Appraisal
                if not isinstance(appraisal, Appraisal):
                    raise ValueError("Interest update requires a validated appraisal")
                Appraisal.parse(json.dumps(asdict(appraisal), ensure_ascii=False), user_input)
            user_row = conn.execute(
                """INSERT INTO messages (session_id, role, content, channel, timestamp)
                   VALUES (?, 'user', ?, ?, ?)""",
                (session_id, user_input, channel, timestamp),
            )
            assistant_row = conn.execute(
                """INSERT INTO messages (session_id, role, content, channel, timestamp, speaker)
                   VALUES (?, 'assistant', ?, ?, ?, ?)""",
                (session_id, response, channel, timestamp, speaker),
            )
            receipt = apply_exchange(
                conn, session_id, user_input, response, user_row.lastrowid,
                assistant_row.lastrowid,
                update=getattr(appraisal, "dialogue", None), event_id=event_id,
                expected_revision=expected_revision, now=now,
            )
            receipt["agent_name"] = speaker or "Kristina"
            if appraisal is not None and appraisal.interest_action in ("clear", "replace"):
                conn.execute("""UPDATE agent_intentions SET status='cancelled', reason='source_changed',
                    updated_at=? WHERE session_id=? AND status IN ('planning','planned','running')""",
                    (datetime.now(timezone.utc).isoformat(), session_id))
            if appraisal is not None and appraisal.interest_action == "clear":
                conn.execute("DELETE FROM cognitive_interests WHERE session_id = ?", (session_id,))
            elif appraisal is not None and appraisal.interest_action == "replace":
                conn.execute(
                    """INSERT OR REPLACE INTO cognitive_interests
                       (session_id, topic, reflection, source_quote, source_message_id, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (session_id, appraisal.topic, appraisal.reflection, appraisal.source_quote,
                     user_row.lastrowid, datetime.now(timezone.utc).isoformat()),
                )
            return receipt

    def get_exchange(self, session_id, event_id, user_input):
        from dialogue_state import DialogueStore
        return DialogueStore(self).get_exchange(session_id, event_id, user_input)

    def get_interest(self, session_id: str) -> Optional[Dict]:
        """One interpretation per conversation, anchored to an actual user message."""
        row = self._get_connection().execute(
            """SELECT i.topic, i.reflection, i.source_quote, i.updated_at,
                      i.source_message_id, 'user_report' AS source_kind
               FROM cognitive_interests i JOIN messages m ON m.id = i.source_message_id
               WHERE i.session_id = ? AND m.session_id = i.session_id AND m.role = 'user'""",
            (session_id,),
        ).fetchone()
        return dict(row) if row else None

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
    
    def get_messages(self, session_id: str, limit: int = 10) -> List[tuple]:
        """Последние сообщения сессии как кортежи (role, content)"""
        messages = self.get_recent_messages(session_id, limit)
        return [(m["role"], m["content"]) for m in messages]

    def search_messages(self, keyword: str) -> List[Dict]:
        """Поиск по тексту среди всех сессий"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """SELECT session_id, role, content, timestamp FROM messages
               WHERE role LIKE ? OR content LIKE ?
               ORDER BY timestamp DESC""",
            (f"%{keyword}%", f"%{keyword}%")
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

    def clear_user(self, session_id: str) -> None:
        """Удалить все сообщения сессии"""
        conn = self._get_connection()
        with conn:
            from dialogue_state import clear_session
            clear_session(conn, session_id)
            conn.execute("DELETE FROM agent_intentions WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM cognitive_interests WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))

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
