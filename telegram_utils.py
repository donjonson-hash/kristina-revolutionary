"""
Утилиты для отправки сообщений в Telegram
"""

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
