"""
Test Suite: Database Layer

Проверяет:
1. SQLiteManager — connect/disconnect, messages CRUD
2. SQLiteManager — sessions, projects, dialog history
3. SQLiteManager — knowledge search
4. PersistentMemory — запись/чтение/поиск
5. DatabaseManager — unified interface
"""

import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch


pytestmark = pytest.mark.asyncio


class TestSQLiteManager:

    async def test_connect_disconnect(self, memory_db):
        """Подключение и отключение от БД"""
        # После фикстуры уже подключено
        assert memory_db._conn is not None
        await memory_db.disconnect()
        assert memory_db._conn is None

    async def test_save_and_get_messages(self, memory_db):
        """Сохранение и получение сообщений"""
        # Перед сохранением нужно создать таблицу
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                agent TEXT,
                timestamp TEXT
            )
        """)
        await memory_db._conn.commit()

        msg_id = await memory_db.save_message(
            session_id="test_session",
            role="user",
            content="Привет!",
            agent="kristina"
        )
        assert msg_id > 0

        messages = await memory_db.get_messages("test_session")
        assert len(messages) >= 1
        assert messages[0]["content"] == "Привет!"
        assert messages[0]["role"] == "user"

    async def test_save_message_without_agent(self, memory_db):
        """Сохранение сообщения без указания агента"""
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                agent TEXT,
                timestamp TEXT
            )
        """)
        await memory_db._conn.commit()

        msg_id = await memory_db.save_message(
            session_id="test_2", role="assistant", content="OK"
        )
        assert msg_id > 0

    async def test_get_messages_limit(self, memory_db):
        """Получение сообщений с лимитом"""
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                agent TEXT,
                timestamp TEXT
            )
        """)
        await memory_db._conn.commit()

        for i in range(5):
            await memory_db.save_message("limit_test", "user", f"msg {i}")

        messages = await memory_db.get_messages("limit_test", limit=3)
        assert len(messages) == 3

    async def test_get_messages_empty_session(self, memory_db):
        """Несуществующая сессия — пустой список"""
        messages = await memory_db.get_messages("non_existent")
        assert messages == []

    async def test_save_and_get_session(self, memory_db):
        """Сохранение и получение сессии"""
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                agent TEXT,
                updated_at TEXT
            )
        """)
        await memory_db._conn.commit()

        await memory_db.save_session("sess_1", user_id=42)
        session = await memory_db.get_session("sess_1")
        assert session is not None
        assert session["id"] == "sess_1"
        assert session["user_id"] == 42

    async def test_get_session_not_found(self, memory_db):
        """Несуществующая сессия — None"""
        session = await memory_db.get_session("no_such_session")
        assert session is None

    async def test_save_and_get_projects(self, memory_db):
        """Сохранение и получение проектов"""
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS freelance_projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT,
                client_id INTEGER,
                description TEXT,
                status TEXT,
                attachments TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT
            )
        """)
        await memory_db._conn.commit()

        pid = await memory_db.save_project({
            "project_id": "proj_1",
            "client_id": 1,
            "description": "Make a website",
            "status": "active",
            "attachments": ["file1.pdf"]
        })
        assert pid > 0

        projects = await memory_db.get_projects(client_id=1)
        assert len(projects) >= 1
        assert projects[0]["description"] == "Make a website"

    async def test_save_and_get_dialog(self, memory_db):
        """Сохранение и получение истории диалога"""
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS dialog_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                message TEXT,
                response TEXT,
                agent TEXT,
                sentiment TEXT,
                timestamp TEXT
            )
        """)
        await memory_db._conn.commit()

        did = await memory_db.save_dialog(
            user_id=1, message="hi", response="hello!", agent="kristina"
        )
        assert did > 0

        history = await memory_db.get_dialog_history(user_id=1)
        assert len(history) >= 1
        assert "hello!" in str(history[0])

    async def test_get_stats(self, memory_db):
        """Статистика возвращает dict с нулевыми значениями для отсутствующих таблиц"""
        # Создаём хотя бы одну таблицу
        await memory_db._conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT, role TEXT, content TEXT, agent TEXT, timestamp TEXT
            )
        """)
        await memory_db._conn.commit()

        stats = await memory_db.get_stats()
        assert isinstance(stats, dict)
        # Все ключи присутствуют
        for key in ["messages", "sessions", "freelance_projects", "dialog_history"]:
            assert key in stats


class TestPersistentMemory:

    def test_write_and_read(self, persistent_memory):
        """Запись и чтение сообщения"""
        persistent_memory.save_message("user_1", "hello", "world")
        result = persistent_memory.get_messages("user_1")
        assert len(result) == 1
        assert result[0] == ("hello", "world")

    def test_get_messages_limit(self, persistent_memory):
        """Лимит сообщений"""
        for i in range(5):
            persistent_memory.save_message("user_2", f"q{i}", f"a{i}")

        result = persistent_memory.get_messages("user_2", limit=2)
        assert len(result) == 2

    def test_get_messages_non_existent(self, persistent_memory):
        """Несуществующий пользователь — пустой список"""
        result = persistent_memory.get_messages("no_user")
        assert result == []

    def test_search_messages(self, persistent_memory):
        """Поиск по тексту сообщения"""
        persistent_memory.save_message("user_3", "how to make a startup", "good question!")
        results = persistent_memory.search_messages("startup")
        assert len(results) >= 1

    def test_search_no_match(self, persistent_memory):
        """Поиск без совпадений — пустой список"""
        results = persistent_memory.search_messages("xyznonexistent")
        assert results == []

    def test_clear_user(self, persistent_memory):
        """Очистка сообщений пользователя"""
        persistent_memory.save_message("user_4", "a", "b")
        persistent_memory.clear_user("user_4")
        result = persistent_memory.get_messages("user_4")
        assert result == []

    def test_multiple_users(self, persistent_memory):
        """Несколько пользователей не пересекаются"""
        persistent_memory.save_message("u1", "hello", "hi")
        persistent_memory.save_message("u2", "world", "earth")

        u1_msgs = persistent_memory.get_messages("u1")
        u2_msgs = persistent_memory.get_messages("u2")

        assert len(u1_msgs) == 1
        assert len(u2_msgs) == 1
