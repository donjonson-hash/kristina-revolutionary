"""
Утилиты для отправки сообщений в Telegram
"""

from datetime import datetime, timedelta
from typing import List

# Лимит Telegram — 4096 символов; оставляем запас
MESSAGE_LIMIT = 4000


def split_message(text: str, limit: int = MESSAGE_LIMIT) -> List[str]:
    """
    Разбить длинный текст на части для Telegram по границам абзацев.

    Порядок деления: абзацы (\\n\\n) → строки (\\n) → жёсткий срез,
    чтобы не резать отчёты посреди слова или строки таблицы.
    """
    text = text.strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]

    chunks: List[str] = []
    current = ""

    def flush():
        nonlocal current
        if current:
            chunks.append(current)
            current = ""

    def add_piece(piece: str, sep: str):
        """Добавить фрагмент к текущей части или начать новую"""
        nonlocal current
        candidate = f"{current}{sep}{piece}" if current else piece
        if len(candidate) <= limit:
            current = candidate
        else:
            flush()
            current = piece

    for paragraph in text.split("\n\n"):
        if len(paragraph) <= limit:
            add_piece(paragraph, "\n\n")
            continue
        # Абзац длиннее лимита — делим по строкам
        for line in paragraph.split("\n"):
            if len(line) <= limit:
                add_piece(line, "\n")
                continue
            # Строка длиннее лимита — жёсткий срез
            flush()
            while len(line) > limit:
                chunks.append(line[:limit])
                line = line[limit:]
            current = line

    flush()
    return chunks


def parse_admin_ids(raw: str) -> List[int]:
    """
    Разобрать KRISTINA_ADMIN_IDS: список Telegram chat_id через запятую.
    Нечисловые значения (в т.ч. заглушка из .env.example) отбрасываются.
    """
    ids = []
    for part in (raw or "").replace(" ", "").split(","):
        if part.lstrip("-").isdigit():
            ids.append(int(part))
    return ids


def next_weekly_run(now: datetime, weekday: int = 0, hour: int = 8) -> datetime:
    """
    Ближайший момент еженедельного запуска: день недели (0=понедельник)
    и час в таймзоне переданного now. Если момент на этой неделе уже
    прошёл — следующая неделя.
    """
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    days_ahead = (weekday - now.weekday()) % 7
    target += timedelta(days=days_ahead)
    if target <= now:
        target += timedelta(weeks=1)
    return target
