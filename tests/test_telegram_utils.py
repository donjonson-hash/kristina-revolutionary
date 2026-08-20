"""
Тесты разбивки длинных сообщений для Telegram
"""

import re

from telegram_utils import split_message, MESSAGE_LIMIT


def strip_ws(text: str) -> str:
    return re.sub(r"\s+", "", text)


def test_short_text_single_chunk():
    assert split_message("привет") == ["привет"]


def test_empty_text():
    assert split_message("") == []
    assert split_message("   \n  ") == []


def test_exact_limit_not_split():
    text = "x" * MESSAGE_LIMIT
    assert split_message(text) == [text]


def test_splits_on_paragraph_boundary():
    """Деление проходит по \\n\\n, а не посреди абзаца"""
    para_a = "A" * 3000
    para_b = "B" * 3000
    chunks = split_message(f"{para_a}\n\n{para_b}")
    assert chunks == [para_a, para_b]


def test_never_cuts_table_row():
    """Markdown-таблица длиннее лимита делится по строкам, а не посреди строки"""
    rows = [f"| Идея {i} | {'x' * 90} | {i} |" for i in range(60)]
    table = "\n".join(rows)  # один «абзац» длиннее лимита
    chunks = split_message(table)

    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= MESSAGE_LIMIT
        # Каждая часть начинается и заканчивается целой строкой таблицы
        for line in chunk.split("\n"):
            assert line.startswith("| Идея")
            assert line.endswith(" |")


def test_monster_line_hard_cut():
    """Строка без переносов длиннее лимита режется жёстко, но без потерь"""
    text = "z" * (MESSAGE_LIMIT * 2 + 100)
    chunks = split_message(text)
    assert all(len(c) <= MESSAGE_LIMIT for c in chunks)
    assert "".join(chunks) == text


def test_content_preserved():
    """Никакой текст не теряется при разбивке"""
    report = "\n\n".join(f"## Раздел {i}\n" + ("строка\n" * 200) for i in range(5))
    chunks = split_message(report)
    assert all(len(c) <= MESSAGE_LIMIT for c in chunks)
    assert all(c for c in chunks)  # нет пустых частей
    assert strip_ws("".join(chunks)) == strip_ws(report)


def test_realistic_trend_report():
    """Отчёт TrendScout с заголовками и таблицей не рвётся посреди слов"""
    report = (
        "## 🔥 Кластеры спроса\n\n"
        + "\n\n".join(f"**{i}. Кластер**\n{'Описание боли. ' * 100}" for i in range(8))
        + "\n\n## 📊 Скоринг\n\n"
        + "\n".join(f"| Идея {i} | 4 | 5 | 3 | 4 | 4 | 4 | 24 |" for i in range(10))
    )
    chunks = split_message(report)
    assert all(len(c) <= MESSAGE_LIMIT for c in chunks)
    # Слово «Альтернатива» из отчёта никогда не окажется разрезанным:
    # каждая часть заканчивается концом абзаца/строки, а не серединой слова
    for chunk in chunks[:-1]:
        assert not chunk.endswith(tuple("абвгдежзиклмнопрстуфхцчшщыэюя"))  # не обрыв слова
    assert strip_ws("".join(chunks)) == strip_ws(report)


# ---------- parse_admin_ids ----------

def test_parse_admin_ids():
    from telegram_utils import parse_admin_ids
    assert parse_admin_ids("123, 456,789") == [123, 456, 789]
    assert parse_admin_ids("-1001234567890") == [-1001234567890]
    assert parse_admin_ids("") == []
    assert parse_admin_ids(None) == []
    assert parse_admin_ids("your-id-here, 42") == [42]


# ---------- next_weekly_run ----------

def test_next_weekly_run():
    from datetime import datetime, timezone
    from telegram_utils import next_weekly_run

    # Среда 2026-08-19 10:00 UTC → ближайший понедельник 08:00
    now = datetime(2026, 8, 19, 10, 0, tzinfo=timezone.utc)
    run = next_weekly_run(now, weekday=0, hour=8)
    assert run == datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc)
    assert run.weekday() == 0

    # Понедельник до 08:00 → сегодня же
    now = datetime(2026, 8, 24, 6, 0, tzinfo=timezone.utc)
    assert next_weekly_run(now, weekday=0, hour=8) == datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc)

    # Понедельник после 08:00 → следующая неделя
    now = datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc)
    assert next_weekly_run(now, weekday=0, hour=8) == datetime(2026, 8, 31, 8, 0, tzinfo=timezone.utc)

    # Результат всегда в будущем
    assert next_weekly_run(now, weekday=3, hour=0) > now
