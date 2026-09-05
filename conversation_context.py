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
    return {
        "channel": "telegram",
        "chat_id": update.effective_chat.id,
        "user_id": update.effective_user.id,
    }


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
