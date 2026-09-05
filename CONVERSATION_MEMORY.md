# Conversation memory

The Telegram bot uses the existing `kristina_memory.db` SQLite database. No schema
migration or new service is required.

## Session boundaries

A session key is the JSON-encoded tuple `[channel, chat_id, user_id]`. Each member
of a group has a separate conversation, and the same person's private and group
conversations are separate. A web caller without a user identity receives no
persistent conversation context. This change does not add web authentication or
change the separate mobile API memory implementation.

Agent selection in Telegram is scoped to this session. Switching between Persona,
Advisor, Creative and TrendScout preserves the session's history; the shared agent
instances no longer collect user messages in their process-wide history lists.
Selected modes remain in memory and reset to Persona after a restart.

## Read and write path

`AgentRouter.process` loads the latest 20 messages for the session, passes that
history to the agent, and commits the user/assistant exchange atomically. Persona
uses a 12,000-character history budget, keeping recent messages instead of cutting
every message to 100 characters. Very long single messages have an explicit
truncation marker. BrainBridge uses the same supplied session/history.

Conversation history is recalled dialogue, not verified evidence that an action
occurred. The existing GitHub evidence path remains separate.

Proactive delivery reads the private conversation before generation. Once Telegram
accepts the outgoing message, it is saved as an assistant turn in the same session.
Failed deliveries are not recorded as conversation turns. The schedule and recent
opening cache remain in memory; restart recovery here applies to saved dialogue,
not automatic resubscription to proactive messaging.

Document follow-up context and manual mode selections also use the scoped session
key. Document responses, commercial proposals and explicit `/trends` reports are
recorded in that conversation. Document contents used for proposal generation
remain in memory; this PR does not make attachments durable.

## Clearing and concurrency

`/clear` deletes messages for the invoking user's current chat session, removes its
document follow-up context, and clears the private proactive opening cache. Other
users and other chats are untouched. It confirms success only after deletion.

Router turns, proactive delivery and clearing share a per-session async lock in
the bot process. Clearing waits for an in-flight turn, then removes its saved
reply. These locks do not coordinate multiple bot processes; run one polling bot
instance as in the supplied systemd service.

## Existing data

Older `user_<id>` rows used a hardcoded `web` channel even for Telegram and did not
record the original chat. They are retained unchanged, but are not automatically
injected into scoped sessions or deleted by scoped `/clear`. Importing them into
a private session requires first establishing which chat they came from; guessing
would risk carrying private or group context into the wrong conversation.

Existing shared in-memory agent histories are not migrated. New scoped dialogue
survives process restarts through SQLite.

## Verification

`tests/test_conversation_memory.py` exercises the real Persona prompt path with
temporary SQLite databases and mocked LLM/Telegram calls: restart recall, user and
group isolation, mode switches, anonymous callers, proactive follow-up, failed
delivery, scoped clearing and clearing during an in-flight reply.
