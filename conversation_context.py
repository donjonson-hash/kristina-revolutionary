"""Conversation identity and bounded prompt history shared by delivery and agents."""

import json
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

    Intro anchors (first exchange of each chat — who is who) are pinned at the
    top and survive the budget; only recent lines are dropped when it shrinks,
    oldest first. Empty shared context yields an empty string.
    """
    if not shared:
        return ""
    anchor_lines = []
    recent_lines = []
    for message in shared.get("messages", []):
        ts = (message.get("timestamp") or "")[:16]
        who = "Кристина" if message.get("role") == "assistant" else "собеседник"
        content = message.get("content", "")
        if message.get("anchor"):
            if len(content) > 240:
                content = content[:240] + "…"
            anchor_lines.append(
                f"[{ts}] (чат {_chat_label(message.get('session_id'))}, начало переписки) "
                f"{who}: {content}"
            )
        else:
            recent_lines.append(
                f"[{ts}] (чат {_chat_label(message.get('session_id'))}) "
                f"{who}: {content}"
            )
    for interest in shared.get("interests", []):
        ts = (interest.get("updated_at") or "")[:16]
        recent_lines.append(
            f"[{ts}] (интерес, чат {_chat_label(interest.get('session_id'))}) "
            f"{interest.get('topic')}: {interest.get('reflection')}"
        )
    total = sum(len(line) + 1 for line in anchor_lines + recent_lines)
    while recent_lines and total > max_chars:
        total -= len(recent_lines[0]) + 1
        recent_lines.pop(0)
    return "\n".join(anchor_lines + recent_lines)


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
