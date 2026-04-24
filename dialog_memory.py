"""
DialogMemory v4.3 — Память диалогов Кристины
Хранит историю разговоров для контекста
"""

import json
import sqlite3
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict


@dataclass
class Message:
    role: str  # 'user' или 'assistant'
    content: str
    timestamp: datetime
    agent_type: Optional[str] = None  # какой агент отвечал
    mood_energy: Optional[str] = None  # энергия настроения


class DialogMemory:
    """Управление памятью диалогов"""
    
    def __init__(self, db_path: str = "kristina_memory.db"):
        self.db_path = db_path
        self._init_db()
    
    def _init_db(self):
        """Создание таблицы для диалогов"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS dialog_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                agent_type TEXT,
                mood_energy TEXT,
                session_id TEXT
            )
        ''')
        
        # Индексы для быстрого поиска
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_user ON dialog_history(user_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_time ON dialog_history(timestamp)')
        
        conn.commit()
        conn.close()
    
    async def add_message(self, user_id: str, role: str, content: str, 
                         agent_type: str = None, mood_energy: str = None):
        """Добавить сообщение в историю"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        session_id = self._get_session_id(user_id)
        
        cursor.execute('''
            INSERT INTO dialog_history 
            (user_id, role, content, timestamp, agent_type, mood_energy, session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            user_id, 
            role, 
            content, 
            datetime.now().isoformat(),
            agent_type,
            mood_energy,
            session_id
        ))
        
        conn.commit()
        conn.close()
    
    def _get_session_id(self, user_id: str) -> str:
        """Получить ID текущей сессии (или создать новую)"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Ищем последнее сообщение от пользователя
        cursor.execute('''
            SELECT session_id, timestamp FROM dialog_history 
            WHERE user_id = ? 
            ORDER BY timestamp DESC LIMIT 1
        ''', (user_id,))
        
        result = cursor.fetchone()
        conn.close()
        
        if result:
            last_time = datetime.fromisoformat(result[1])
            # Если последнее сообщение было < 30 мин назад — та же сессия
            if datetime.now() - last_time < timedelta(minutes=30):
                return result[0]
        
        # Новая сессия
        return f"session_{user_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    async def get_context(self, user_id: str, limit: int = 10) -> List[Dict]:
        """Получить последние сообщения для контекста"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT role, content, agent_type, mood_energy, timestamp
            FROM dialog_history
            WHERE user_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        ''', (user_id, limit))
        
        rows = cursor.fetchall()
        conn.close()
        
        # Преобразуем в список словарей (в хронологическом порядке)
        context = []
        for row in reversed(rows):
            context.append({
                'role': row[0],
                'content': row[1],
                'agent_type': row[2],
                'mood_energy': row[3],
                'time': row[4]
            })
        
        return context
    
    async def get_summary(self, user_id: str) -> str:
        """Получить краткое резюме разговора (для длинного контекста)"""
        context = await self.get_context(user_id, limit=20)
        
        if not context:
            return "Новый разговор"
        
        # Формируем краткое описание
        topics = []
        user_msgs = [m for m in context if m['role'] == 'user']
        
        if len(user_msgs) > 5:
            return f"Длинный разговор ({len(user_msgs)} сообщений). Последняя тема: {user_msgs[-1]['content'][:50]}..."
        
        return "Продолжаем разговор"
    
    async def clear_old_history(self, days: int = 30):
        """Очистить старую историю"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        
        cursor.execute('''
            DELETE FROM dialog_history WHERE timestamp < ?
        ''', (cutoff,))
        
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
        
        return deleted


# Тест
if __name__ == "__main__":
    import asyncio
    
    async def test():
        memory = DialogMemory()
        
        # Добавляем тестовые сообщения
        await memory.add_message("user_123", "user", "Привет! Как дела?", None, None)
        await memory.add_message("user_123", "assistant", "Привет! Отлично, а у тебя?", "persona", "CREATIVITY")
        await memory.add_message("user_123", "user", "Расскажи про Стокгольм", None, None)
        
        # Получаем контекст
        context = await memory.get_context("user_123")
        print(f"Контекст ({len(context)} сообщений):")
        for msg in context:
            print(f"  {msg['role']}: {msg['content'][:40]}...")
        
        # Резюме
        summary = await memory.get_summary("user_123")
        print(f"\\nРезюме: {summary}")
    
    asyncio.run(test())
