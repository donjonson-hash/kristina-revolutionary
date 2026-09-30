"""Durable Telegram preferences and known private-chat scheduling, not dialogue state."""

from datetime import datetime, timedelta, timezone

from conversation_context import conversation_session_id


AGENT_IDS = {"kristina", "advisor", "creative", "trendscout"}


def _id(value, *, private=False):
    if type(value) is not int or value == 0 or not -(2**63) < value < 2**63 or (private and value < 0):
        raise ValueError("Invalid Telegram identity")
    return value


def _time(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Telegram runtime requires an aware timestamp")
    return value.astimezone(timezone.utc)


def _stamp(value):
    return _time(value).isoformat(timespec="microseconds")


def init_tables(conn):
    # No backfill from messages: history does not grant proactive eligibility.
    conn.execute("""CREATE TABLE IF NOT EXISTS telegram_user_preferences (
        user_id INTEGER PRIMARY KEY CHECK (user_id > 0),
        tts_enabled INTEGER NOT NULL CHECK (tts_enabled IN (0, 1))
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS telegram_session_preferences (
        session_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL CHECK (agent_id IN ('kristina','advisor','creative','trendscout'))
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS telegram_private_chats (
        chat_id INTEGER PRIMARY KEY CHECK (chat_id > 0),
        last_user_at TEXT NOT NULL, next_opportunity_at TEXT NOT NULL
    )""")


class TelegramRuntimeStore:
    def __init__(self, memory):
        self.memory = memory

    def set_tts(self, user_id, enabled):
        _id(user_id, private=True)
        if type(enabled) is not bool:
            raise ValueError("TTS preference must be boolean")
        conn = self.memory._get_connection()
        with conn:
            conn.execute("""INSERT INTO telegram_user_preferences VALUES (?,?)
                ON CONFLICT(user_id) DO UPDATE SET tts_enabled=excluded.tts_enabled""",
                         (user_id, int(enabled)))

    def set_agent(self, user_id, chat_id, agent_id):
        _id(user_id, private=True)
        _id(chat_id)
        if not isinstance(agent_id, str) or agent_id not in AGENT_IDS:
            raise ValueError("Unknown Telegram agent")
        session_id = conversation_session_id({"channel": "telegram", "user_id": user_id, "chat_id": chat_id})
        conn = self.memory._get_connection()
        with conn:
            conn.execute("""INSERT INTO telegram_session_preferences VALUES (?,?,?,?)
                ON CONFLICT(session_id) DO UPDATE SET agent_id=excluded.agent_id""",
                         (session_id, user_id, chat_id, agent_id))

    def touch_private(self, chat_id, now, first_due):
        """Called only by the existing private /start and text-message handlers."""
        _id(chat_id, private=True)
        now, first_due = _time(now), _time(first_due)
        if first_due <= now:
            raise ValueError("First proactive opportunity must be in the future")
        conn = self.memory._get_connection()
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("""INSERT INTO telegram_private_chats VALUES (?,?,?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    last_user_at=MAX(telegram_private_chats.last_user_at, excluded.last_user_at)""",
                         (chat_id, _stamp(now), _stamp(first_due)))
            row = conn.execute("SELECT * FROM telegram_private_chats WHERE chat_id=?", (chat_id,)).fetchone()
        return self._chat(row)

    def schedule_private(self, chat_id, due):
        """Scheduling alone never registers a new recipient."""
        _id(chat_id, private=True)
        conn = self.memory._get_connection()
        with conn:
            conn.execute("UPDATE telegram_private_chats SET next_opportunity_at=? WHERE chat_id=?",
                         (_stamp(due), chat_id))

    @staticmethod
    def _chat(row):
        return {"chat_id": _id(row["chat_id"], private=True),
                "last_user_at": _time(datetime.fromisoformat(row["last_user_at"])),
                "next_opportunity_at": _time(datetime.fromisoformat(row["next_opportunity_at"]))}

    def restore(self, now, next_delay):
        """Load atomically; overdue schedules wait for fresh startup jitter, never catch up."""
        now = _time(now)
        conn = self.memory._get_connection()
        users, sessions, chats = {}, {}, []
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            for row in conn.execute("SELECT * FROM telegram_user_preferences"):
                user_id = _id(row["user_id"], private=True)
                if row["tts_enabled"] not in (0, 1):
                    raise ValueError("Invalid saved TTS preference")
                users[user_id] = bool(row["tts_enabled"])
            for row in conn.execute("SELECT * FROM telegram_session_preferences"):
                user_id, chat_id = _id(row["user_id"], private=True), _id(row["chat_id"])
                expected = conversation_session_id({"channel": "telegram", "user_id": user_id, "chat_id": chat_id})
                if row["session_id"] != expected or row["agent_id"] not in AGENT_IDS:
                    raise ValueError("Invalid saved Telegram session")
                sessions[expected] = row["agent_id"]
            for row in conn.execute("SELECT * FROM telegram_private_chats").fetchall():
                chat = self._chat(row)
                delay = next_delay()
                if type(delay) is not int or delay <= 0:
                    raise ValueError("Startup delay must be positive")
                due = max(chat["next_opportunity_at"], now + timedelta(seconds=delay))
                conn.execute("UPDATE telegram_private_chats SET next_opportunity_at=? WHERE chat_id=?",
                             (_stamp(due), chat["chat_id"]))
                chats.append({**chat, "next_opportunity_at": due})
        return {"users": users, "sessions": sessions, "chats": chats}
