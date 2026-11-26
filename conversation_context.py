"""Conversation identity and bounded prompt history shared by delivery and agents."""

import json
import re
from typing import Dict, Optional


def conversation_session_id(context: Dict) -> Optional[str]:
    user_id = context.get("user_id")
    if user_id is None:
        # Anonymous callers have no reliable identity; never share their history.
        return None
    channel = context.get("channel") or context.get("source") or "web"
    chat_id = context.get("chat_id", user_id)
    return json.dumps([str(channel), str(chat_id), str(user_id)], separators=(",", ":"))


def telegram_conversation(update) -> Dict:
    context = {
        "channel": "telegram",
        "chat_id": update.effective_chat.id,
        "user_id": update.effective_user.id,
    }
    message_id = getattr(getattr(update, "message", None), "message_id", None)
    if type(message_id) is int and message_id > 0:
        context["event_id"] = f"telegram:{message_id}"
    return context


def _chat_label(session_id) -> str:
    """Human-readable chat label from a stored session id (never a full dump)."""
    if not session_id:
        return "?"
    try:
        parts = json.loads(session_id)
        if isinstance(parts, list) and len(parts) > 1:
            return str(parts[1])
    except (ValueError, TypeError):
        pass
    return str(session_id)


def format_shared_memory(shared: Optional[Dict], max_chars: int = 3500) -> str:
    """One person, one memory: bounded digest of OTHER conversations.

    Messages are GROUPED per chat under an identity header quoting the
    interlocutor's introduction — flat "(chat N)" tags did not read as one
    person (measured 2026-11-26: «Иван из Томска» and the same chat's food
    talk were treated as two different people). Intro headers are pinned and
    survive the budget; only recent lines are dropped, oldest first.
    """
    if not shared:
        return ""
    groups = {}
    order = []
    for message in shared.get("messages", []):
        sid = message.get("session_id")
        if sid not in groups:
            groups[sid] = {"intro": None, "lines": []}
            order.append(sid)
        group = groups[sid]
        who = "Кристина" if message.get("role") == "assistant" else "собеседник"
        ts = (message.get("timestamp") or "")[:16]
        content = message.get("content", "")
        if message.get("anchor") and message.get("role") != "assistant" and group["intro"] is None:
            intro = content.replace("\n", " ")
            if len(intro) > 100:
                intro = intro[:100] + "…"
            group["intro"] = ((message.get("timestamp") or "")[:10], intro)
        else:
            group["lines"].append(f"[{ts}] {who}: {content}")
    for interest in shared.get("interests", []):
        sid = interest.get("session_id")
        if sid in groups:
            groups[sid]["lines"].append(
                f"[{(interest.get('updated_at') or '')[:16]}] (интерес) "
                f"{interest.get('topic')}: {interest.get('reflection')}"
            )
    headers = []
    all_lines = []
    for sid in order:
        group = groups[sid]
        label = _chat_label(sid)
        if group["intro"] is not None:
            intro_at, intro_text = group["intro"]
            headers.append(
                f"— переписка {label} (собеседник представился {intro_at}: «{intro_text}») —"
            )
        else:
            headers.append(f"— переписка {label} —")
        all_lines.extend(group["lines"])
    total = sum(len(line) + 1 for line in headers + all_lines)
    while all_lines and total > max_chars:
        total -= len(all_lines[0]) + 1
        all_lines.pop(0)
    # headers first (identity layer), then remaining lines in original order
    return "\n".join(headers + all_lines)


def extract_name_candidates(text: str, limit: int = 3) -> list:
    """Capitalized word candidates (likely person names) from user input.

    Length >= 4 plus a stop-list of common sentence starters keeps the
    obvious non-names out; false positives only cost one search call.
    """
    stop = {
        "Привет", "Смотри", "Скажи", "Расскажи", "Помоги", "Давай", "Теперь",
        "Сегодня", "Вчера", "Завтра", "Спасибо", "Ладно", "Пожалуйста",
        "Здравствуй", "Добрый", "Добрая", "Доброе", "Спокойной", "Пока",
        "Кстати", "Может", "Конечно", "Точно", "Просто", "Ещё", "Вот",
        "Это", "Так", "Уже", "Даже", "Если", "Когда", "Потом", "Тогда",
    }
    words = re.findall(r"[А-ЯЁ][а-яё]{3,}", text or "")
    out = []
    for word in words:
        if word not in stop and word not in out:
            out.append(word)
    return out[:limit]


def format_memory_lookup(hits_by_name) -> str:
    """Deterministic memory lookup evidence block (name -> message records).

    Mirrors the GitHub-evidence pattern: raw records from the message log
    the model must treat as facts, not recall. Empty when nothing found.
    """
    lines = []
    for name, hits in hits_by_name:
        if not hits:
            continue
        lines.append(f"— «{name}»:")
        for hit in hits:
            who = "Кристина" if hit.get("role") == "assistant" else "собеседник"
            content = (hit.get("content") or "").replace("\n", " ")
            if len(content) > 140:
                content = content[:140] + "…"
            lines.append(
                f"  [{(hit.get('timestamp') or '')[:16]}] "
                f"(переписка {_chat_label(hit.get('session_id'))}) {who}: {content}"
            )
    if not lines:
        return ""
    return (
        "\n\nСПРАВКА ПАМЯТИ (автопоиск по записям переписок — доказанные факты, "
        "а не воспоминания):\n" + "\n".join(lines) +
        "\nЕсли запись показывает, что человек писал — так и отвечай: он писал. "
        "Даже если твои прошлые реплики говорили обратное: тогда ты ошибалась."
    )


def format_conversation_history(messages: list, max_chars: int = 12000) -> str:
    """Keep recent turns within a character budget, without 100-character excerpts."""
    selected = []
    remaining = max_chars
    for message in reversed(messages):
        if message.get("role") not in ("user", "assistant"):
            continue
        line = f"{message['role']}: {message['content']}\n"
        if len(line) > remaining:
            if not selected:
                prefix = f"{message['role']}: [начало длинного сообщения пропущено] "
                line = prefix + message['content'][-max(1, remaining - len(prefix) - 1):] + "\n"
                selected.append(line)
            break
        selected.append(line)
        remaining -= len(line)
    return "".join(reversed(selected))
