"""Local Kristina reply generation for a real Runner harness, without iLands APIs."""

import asyncio
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


class BridgeError(ValueError):
    """A bounded, public error that contains no source text or credentials."""


def validate_request(agent_id, conversation_id=None, sender_id=None, message_id=None, text=None,
                     *, message_kind="conversation", sender_type=None):
    if message_kind not in ("conversation", "direct"):
        raise BridgeError("Invalid message_kind; only conversation or confirmed direct messages are supported.")
    if message_kind == "conversation" and sender_type is not None:
        raise BridgeError("sender_type is only supported for confirmed direct messages.")
    if message_kind == "direct" and sender_type not in ("user", "agent"):
        raise BridgeError("Direct messages require sender_type user or agent from the original event context.")
    identifiers = {
        "agent_id": agent_id, "conversation_id": conversation_id,
        "sender_id": sender_id, "message_id": message_id,
    }
    for name, value in identifiers.items():
        if name == "conversation_id" and message_kind == "direct" and value is None:
            continue
        if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
            raise BridgeError(f"Invalid {name}; use the exact identifier from the iLands event.")
    if not isinstance(text, str) or not text.strip() or len(text) > 12000:
        raise BridgeError("Message text must contain 1 to 12000 characters.")
    request = {**identifiers, "text": text}
    if message_kind == "direct":
        # Direct history belongs to a typed peer, whether or not the platform
        # happens to expose its own conversation ID on a particular read.
        request.update(conversation_id=None, message_kind="direct", sender_type=sender_type)
    return request


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


class ReplyBridge:
    """Durably deduplicate generation; never infer that a reply was delivered.

    An interrupted/failed generation is held for manual investigation. Retrying it
    automatically could duplicate memory writes or emotional changes in the core.
    """

    def __init__(self, journal_path, process):
        self.journal_path = Path(journal_path)
        if not self.journal_path.is_absolute() or not self.journal_path.parent.is_dir():
            raise BridgeError("Journal requires an absolute path in an existing directory.")
        self.process = process

    async def reply(self, agent_id, conversation_id=None, sender_id=None, message_id=None, text=None,
                    *, message_kind="conversation", sender_type=None):
        request = validate_request(agent_id, conversation_id, sender_id, message_id, text,
                                   message_kind=message_kind, sender_type=sender_type)
        direct = message_kind == "direct"
        if direct:
            conversation_scope = ["ilands-direct-v1", agent_id, sender_type, sender_id]
            key = _digest([*conversation_scope, message_id])
        else:
            conversation_scope = [agent_id, conversation_id]
            key = _digest([agent_id, conversation_id, message_id])
        fingerprint = _digest(request)
        event_key = _digest([agent_id, sender_id, message_id])
        peer_type = sender_type if direct else "unknown"
        scope_key = _digest(conversation_scope)
        # One local bridge request at a time, including across MCP subprocesses.
        # No SQLite transaction remains open during the model call.
        lock_path = self.journal_path.with_suffix(self.journal_path.suffix + ".lock")
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(descriptor, "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BridgeError("Kristina is processing another event; retry the same message ID later.") from None
            descriptor = os.open(self.journal_path, os.O_CREAT | os.O_RDWR, 0o600)
            os.close(descriptor)
            with closing(sqlite3.connect(self.journal_path, timeout=5)) as conn:
                with conn:
                    conn.execute("""CREATE TABLE IF NOT EXISTS ilands_replies (
                        request_key TEXT PRIMARY KEY,
                        fingerprint TEXT NOT NULL,
                        state TEXT NOT NULL CHECK(state IN ('pending', 'failed', 'generated')),
                        response TEXT
                    )""")
                    # Older journals cannot be reverse-mapped from their hashes.
                    # New events and valid legacy replays acquire this guard.
                    conn.execute("""CREATE TABLE IF NOT EXISTS ilands_event_scopes (
                        event_key TEXT NOT NULL,
                        peer_type TEXT NOT NULL CHECK(peer_type IN ('unknown', 'user', 'agent')),
                        scope_key TEXT NOT NULL,
                        PRIMARY KEY (event_key, peer_type)
                    )""")
                scopes = conn.execute(
                    "SELECT peer_type, scope_key FROM ilands_event_scopes WHERE event_key = ?",
                    (event_key,),
                ).fetchall()
                for recorded_type, recorded_scope in scopes:
                    if (peer_type == "unknown" or recorded_type in (peer_type, "unknown")) and recorded_scope != scope_key:
                        raise BridgeError("This event was already recorded in a different conversation scope; reuse its original mode and identifiers.")
                row = conn.execute(
                    "SELECT fingerprint, state, response FROM ilands_replies WHERE request_key = ?",
                    (key,),
                ).fetchone()
                if row:
                    if row[0] != fingerprint:
                        raise BridgeError("This message ID was already used with different content or sender.")
                    if row[1] != "generated":
                        raise BridgeError("Generation has an unresolved outcome; manual review is required before retry.")
                    with conn:
                        conn.execute("INSERT OR IGNORE INTO ilands_event_scopes VALUES (?, ?, ?)",
                                     (event_key, peer_type, scope_key))
                    return {**json.loads(row[2]), "replayed": True}
                with conn:
                    conn.execute("INSERT OR IGNORE INTO ilands_event_scopes VALUES (?, ?, ?)",
                                 (event_key, peer_type, scope_key))
                    conn.execute("INSERT INTO ilands_replies VALUES (?, ?, 'pending', NULL)", (key, fingerprint))
                context = {
                    "channel": "ilands", "agent_id": "kristina", "user_id": sender_id,
                    "chat_id": json.dumps(conversation_scope, separators=(",", ":")),
                }
                try:
                    response = await self.process(text, context)
                    content = getattr(response, "content", None)
                    if not isinstance(content, str) or not content.strip() or len(content) > 20000:
                        raise BridgeError("Kristina returned an invalid reply.")
                    result = {
                        "status": "generated", "reply_id": key, "text": content,
                        "origin": "kristina_python_pipeline", "replayed": False,
                        "delivery": "not_managed_by_bridge",
                    }
                    if direct:
                        result.update(
                            conversation_scope="local_direct_peer",
                            recipient={"type": sender_type, "id": sender_id},
                            source_message_id=message_id,
                        )
                    with conn:
                        conn.execute(
                            "UPDATE ilands_replies SET state = 'generated', response = ? WHERE request_key = ?",
                            (json.dumps(result, ensure_ascii=False), key),
                        )
                    return result
                except asyncio.CancelledError:
                    # Leave pending: no claim that any core side effects rolled back.
                    raise
                except Exception:
                    with conn:
                        conn.execute("UPDATE ilands_replies SET state = 'failed' WHERE request_key = ?", (key,))
                    raise BridgeError("Kristina generation failed; this event requires manual review before retry.") from None


def status(state_dir):
    """Inspect file presence only; never open memory, credentials, or a model."""
    directory = Path(state_dir)
    memory_exists = (directory / "kristina_memory.db").is_file()
    return {
        "bridge": "kristina-python", "transport": "stdio",
        "reply_contract": "conversation_or_direct_v1",
        "state_directory_exists": directory.is_absolute() and directory.is_dir(),
        "conversation_memory_present": memory_exists,
        "default_emotional_state_present": (directory / "kristina_state.db").is_file(),
        "core_initialization": "deferred_until_reply",
        "runtime_configuration": "not_checked",
        "ilands_delivery": "performed_by_runner_harness",
        "available": directory.is_absolute() and directory.is_dir() and memory_exists,
    }


class RuntimeProcessor:
    """Lazy adapter to the existing persona, memory and emotional core.

    Run in its own MCP process. Its working directory becomes the existing
    application's state directory; the source may live in a separate checkout.
    """

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)
        if not self.state_dir.is_absolute() or not self.state_dir.is_dir():
            raise BridgeError("State directory must be an existing absolute directory.")
        self._router = None

    def _initialize(self):
        if not (self.state_dir / "kristina_memory.db").is_file():
            raise BridgeError("Existing Kristina conversation memory was not found.")
        from dotenv import load_dotenv
        load_dotenv(self.state_dir / ".env", override=False)
        emotional_path = Path(os.getenv("KRISTINA_STATE_DB", "kristina_state.db"))
        if not emotional_path.is_absolute():
            emotional_path = self.state_dir / emotional_path
        if not emotional_path.is_file():
            raise BridgeError("Existing Kristina emotional state was not found.")
        if not os.getenv("DEEPSEEK_API_KEY"):
            raise BridgeError("The existing Kristina model provider is not configured.")
        os.chdir(self.state_dir)
        from agents.router import AgentRouter
        from agents.kristina_persona import KristinaPersonaAgent
        from persistent_memory import get_memory
        router = AgentRouter(memory=get_memory())
        router.register_agent(KristinaPersonaAgent(), is_default=True)
        self._router = router

    async def __call__(self, message, context):
        if self._router is None:
            self._initialize()
        return await self._router.process(message, context)

    async def close(self):
        if self._router is not None:
            from agents.ai_adapter import ai_adapter
            await ai_adapter.ai.close()
            self._router.memory.close()
