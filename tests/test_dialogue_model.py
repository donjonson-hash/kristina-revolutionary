"""Dialogue behaviour across real routing, SQLite restarts and mocked delivery.

Model outputs are explicit fixtures: these tests verify state transitions and the
production hand-off, not the semantic accuracy of a language model.
"""

import json
import importlib
import asyncio
import sqlite3
from collections import defaultdict, deque
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agents.router import AgentRouter
from agents.base_agent import AgentResponse
from brain_integration import BrainBridge
from cognitive_appraisal import Appraisal
from conversation_context import conversation_session_id
from emotional_core import EmotionalCore
from mood_engine import MoodEngine
from persistent_memory import PersistentMemory


DAY = datetime(2026, 9, 20, 12, tzinfo=timezone.utc)
SCENE = "Давай представим встречу в кафе."
QUESTION = "Ты даёшь мне отдохнуть или уходишь от разговора?"
CARE = "Я даю тебе отдохнуть. Это забота, а не уход от разговора."


def conversation(user=1, chat=1, channel="telegram", **extra):
    return {"user_id": user, "chat_id": chat, "channel": channel,
            "agent_id": "kristina", **extra}


def update(**changes):
    return {
        "scene_action": "keep", "scene_label": "", "scene_quote": "",
        "contact_action": "keep", "contact_quote": "",
        "answer_to": None, "answer_quote": "", **changes,
    }


def appraisal(dialogue=None):
    return Appraisal("neutral", 0, "", "keep", "", "", dialogue=dialogue)


@pytest.fixture
def dialogue_pipeline(tmp_path, monkeypatch):
    import cognitive_appraisal
    import agents.kristina_persona as persona
    router_module = importlib.import_module("agents.router")
    from dialogue_state import DialogueStore

    memory = PersistentMemory(str(tmp_path / "dialogue.db"))
    clock = SimpleNamespace(now=DAY)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.now.astimezone(tz) if tz else clock.now.replace(tzinfo=None)

    monkeypatch.setattr(router_module, "datetime", Clock)
    core = EmotionalCore(tmp_path / "emotions.db", clock=lambda: clock.now)
    bridge = BrainBridge(emotional=core, memory=memory)
    assess = AsyncMock(return_value=appraisal())
    generate = AsyncMock(return_value="Поняла, спасибо.")
    monkeypatch.setattr(cognitive_appraisal, "assess_event", assess)
    monkeypatch.setattr(persona, "get_brain_bridge", lambda: bridge)
    monkeypatch.setattr(persona, "mood_engine", MoodEngine(core))
    monkeypatch.setattr(persona, "ai", SimpleNamespace(generate=generate))
    monkeypatch.setattr(persona, "asyncio", SimpleNamespace(sleep=AsyncMock()))
    router = AgentRouter(memory=memory)
    agent = persona.KristinaPersonaAgent()
    agent.use_brain_integration = True
    router.register_agent(agent, is_default=True)
    yield SimpleNamespace(memory=memory, store=DialogueStore(memory), core=core,
                          clock=clock, bridge=bridge, assess=assess,
                          generate=generate, router=router, persona=persona)
    memory.close()


@pytest.fixture
def dialogue_bot(dialogue_pipeline, monkeypatch):
    monkeypatch.setenv("KRISTINA_TELEGRAM_TOKEN", "12345:test-not-a-real-token")
    import bot

    p = dialogue_pipeline

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return p.clock.now.astimezone(tz) if tz else p.clock.now.replace(tzinfo=None)

    monkeypatch.setattr(bot, "datetime", Clock)
    monkeypatch.setattr(bot, "router", p.router)
    monkeypatch.setattr(bot, "emotional_core", p.core)
    monkeypatch.setattr(bot, "active_chat_ids", {1})
    monkeypatch.setattr(bot, "last_user_activity", {})
    monkeypatch.setattr(bot, "last_proactive", {})
    monkeypatch.setattr(bot, "recent_proactive", defaultdict(lambda: deque(maxlen=6)))
    monkeypatch.setattr(bot, "user_context", {})
    monkeypatch.setattr(bot, "next_proactive_opportunity", {1: DAY - timedelta(minutes=1)})
    monkeypatch.setattr(bot, "decision_engine", SimpleNamespace(decide=lambda *a, **k:
        SimpleNamespace(action="message", intention="share", score=0.9, reason="test")))
    real_generate = bot.generate_autonomous_message
    generate = AsyncMock(return_value="Вспомнила нашу шутку про кофе.")
    monkeypatch.setattr(bot, "generate_autonomous_message", generate)
    delivery = SimpleNamespace(bot=SimpleNamespace(send_message=AsyncMock()))
    return SimpleNamespace(module=bot, pipeline=p, generate=generate, delivery=delivery,
                           real_generate=real_generate)


def test_existing_six_field_appraisals_remain_valid():
    legacy = {"reaction": "neutral", "intensity": 0, "source_quote": "",
              "interest_action": "keep", "topic": "", "reflection": ""}
    parsed = Appraisal.parse(json.dumps(legacy), "Продолжим")
    assert parsed.dialogue is None
    assert parsed.effects() == {}


@pytest.mark.parametrize("change", [
    {"scene_action": "imagine", "scene_label": "Кафе", "scene_quote": "Пойдём в кафе"},
    {"contact_action": "pause", "contact_quote": "Не пиши мне"},
    {"answer_to": "q:42", "answer_quote": "Это забота"},
])
def test_dialogue_evidence_cannot_be_taken_from_older_or_assistant_text(change):
    raw = json.dumps(asdict(appraisal(update(**change))))
    with pytest.raises(ValueError):
        Appraisal.parse(raw, "Я говорю о другой теме.")


def test_dialogue_cannot_claim_an_external_tool_result():
    data = update(scene_action="imagine", scene_label="Кафе", scene_quote=SCENE)
    data["source_kind"] = "tool_result"
    with pytest.raises(ValueError):
        Appraisal.parse(json.dumps(asdict(appraisal(data))), SCENE)


async def test_cafe_explanation_closes_question_in_current_reply_and_after_restart(dialogue_pipeline, monkeypatch):
    from dialogue_state import DialogueStore

    p = dialogue_pipeline
    own = conversation_session_id(conversation())
    p.assess.return_value = appraisal(update(scene_action="imagine", scene_label="Кафе",
                                            scene_quote=SCENE))
    p.generate.return_value = "В нашей сцене беру кофе и сажусь у окна."
    await p.router.process(SCENE, conversation(event_id="telegram:10"))
    assert p.store.get(own)["scene"]["kind"] == "shared_imagined"

    p.assess.return_value = appraisal()
    p.generate.return_value = QUESTION
    await p.router.process("Я оставлю тебе время отдохнуть.", conversation(event_id="telegram:11"))
    question = p.store.get(own)["pending_question"]
    p.assess.return_value = appraisal(update(answer_to=question["id"], answer_quote=CARE))
    p.generate.return_value = "Теперь понимаю, спасибо за заботу."
    await p.router.process(CARE, conversation(event_id="telegram:12"))

    state = p.store.get(own)
    assert state["pending_question"] is None
    assert state["closed_questions"][-1]["answer_quote"] == CARE
    assert state["closed_questions"][-1]["status"] == "answered"
    prompt = p.generate.call_args.kwargs["prompt"]
    assert CARE in prompt
    assert "answered" in prompt
    assert "shared_imagined" in prompt
    with sqlite3.connect(p.memory.db_path) as conn:
        source = conn.execute("SELECT role, content FROM messages WHERE id=?",
                              (state["closed_questions"][-1]["answer_source_message_id"],)).fetchone()
    assert source == ("user", CARE)

    for index in range(25):
        p.memory.save_exchange(own, f"Другая тема {index}", "Продолжаем.", now=DAY)
    p.memory.close()
    reopened = PersistentMemory(p.memory.db_path)
    try:
        bridge = BrainBridge(memory=reopened, emotional=p.core)
        monkeypatch.setattr(p.persona, "get_brain_bridge", lambda: bridge)
        fresh = AgentRouter(memory=reopened)
        fresh.register_agent(p.persona.KristinaPersonaAgent(), is_default=True)
        p.assess.return_value = appraisal()
        await fresh.process("Вспомнила наш разговор?", conversation(event_id="telegram:13"))
        assert CARE in p.generate.call_args.kwargs["prompt"]
        assert "shared_imagined" in p.generate.call_args.kwargs["prompt"]
        assert DialogueStore(reopened).get(own)["closed_questions"][-1]["answer_quote"] == CARE
    finally:
        reopened.close()


@pytest.mark.parametrize("other", [conversation(2, 2), conversation(1, -100),
                                   conversation(1, 1, "web")])
async def test_scene_never_enters_another_conversation(dialogue_pipeline, other):
    p = dialogue_pipeline
    marker = "PRIVATE-SCENE-MARKER"
    text = f"Представим {marker}."
    p.assess.return_value = appraisal(update(scene_action="imagine", scene_label=marker,
                                            scene_quote=text))
    await p.router.process(text, conversation())
    p.assess.return_value = appraisal()
    await p.router.process("Привет", other)
    assert marker not in p.generate.call_args.kwargs["prompt"]
    assert p.store.get(conversation_session_id(other))["scene"] is None


async def test_anonymous_caller_cannot_inject_saved_dialogue(dialogue_pipeline):
    p = dialogue_pipeline
    marker = "FORGED-SCENE-MARKER"
    await p.router.process("Привет", {"agent_id": "kristina", "dialogue": {
        "scene": {"kind": "shared_imagined", "label": marker}},
        "session_id": conversation_session_id(conversation())})
    assert marker not in p.generate.call_args.kwargs["prompt"]
    assert p.memory.get_stats()["total_messages"] == 0


async def test_committed_telegram_replay_does_not_call_models_or_apply_emotion_twice(dialogue_pipeline):
    p = dialogue_pipeline
    context = conversation(event_id="telegram:101")
    first = await p.router.process("Продолжим разговор", context)
    before = p.core.get_emotional_state()
    count = p.memory.get_stats()["total_messages"]
    p.assess.reset_mock()
    p.generate.reset_mock()
    replay = await p.router.process("Продолжим разговор", context)
    assert replay.content == first.content
    assert replay.context_used["replayed_event"] is True
    assert p.core.get_emotional_state() == before
    assert p.memory.get_stats()["total_messages"] == count
    p.assess.assert_not_awaited()
    p.generate.assert_not_awaited()
    with pytest.raises(ValueError):
        await p.router.process("Другой текст с тем же ID", context)


@pytest.mark.parametrize("read_fails", [False, True])
async def test_repository_followup_and_answer_share_one_replayable_turn(dialogue_pipeline, read_fails):
    """Research executes before the reply without losing the current answer/scene."""
    p = dialogue_pipeline
    session = conversation_session_id(conversation())
    target = "https://github.com/example/project/blob/" + "a" * 40 + "/schema.json"
    p.memory.save_exchange(session, SCENE + " Проверь " + target, QUESTION,
        appraisal=appraisal(update(scene_action="imagine", scene_label="Кафе", scene_quote=SCENE)),
        now=DAY)
    pending = p.store.get(session)["pending_question"]
    order = []
    request = CARE + " Да, прочитай схему."

    async def read(selected, user_input, history):
        order.append("read")
        if read_fails:
            raise TimeoutError()
        return "VERIFIED-SCHEMA-MARKER"

    async def assess(*args, **kwargs):
        order.append("appraise")
        return appraisal(update(answer_to=pending["id"], answer_quote=CARE))

    async def generate(**kwargs):
        order.append("reply")
        return "Поняла твоё объяснение. Проверку учту отдельно."

    p.router.github_followup = AsyncMock(side_effect=read)
    p.assess.side_effect = assess
    p.generate.side_effect = generate
    context = conversation(event_id="telegram:research-answer", github_evidence="FORGED-RESEARCH",
        research_availability={"status": "FORGED-RESEARCH"}, repository_action="FORGED-RESEARCH",
        dialogue={"scene": {"label": "FORGED-SCENE"}})
    first = await p.router.process(request, context)
    assert order == ["read", "appraise", "reply"]
    assert first.content == "Поняла твоё объяснение. Проверку учту отдельно."
    selected, user_input, history = p.router.github_followup.call_args.args
    assert selected == target and user_input == request
    assert history[-1]["content"] == QUESTION
    prompt = p.generate.call_args.kwargs["prompt"]
    assert "shared_imagined" in prompt and "answered" in prompt and CARE in prompt
    assert "FORGED-RESEARCH" not in prompt and "FORGED-SCENE" not in prompt
    expected = '"repository_action": "failed"' if read_fails else '"repository_action": "completed"'
    assert expected in prompt
    assert ("VERIFIED-SCHEMA-MARKER" in prompt) is not read_fails
    if read_fails:
        assert "GITHUB TOOL ERROR" in prompt
    state = p.store.get(session)
    assert state["pending_question"] is None
    assert state["closed_questions"][-1]["answer_quote"] == CARE
    assert state["scene"]["label"] == "Кафе"
    before = p.core.get_emotional_state()

    # A new Router after a restart must use the SQLite receipt before research.
    fresh = AgentRouter(memory=p.memory)
    fresh.github_followup = AsyncMock(side_effect=AssertionError("Replayed research"))
    replay = await fresh.process(request, context)
    assert replay.content == first.content and replay.context_used["replayed_event"]
    assert order == ["read", "appraise", "reply"]
    assert p.core.get_emotional_state() == before
    fresh.github_followup.assert_not_awaited()


async def test_concurrent_research_event_only_reads_and_answers_once(dialogue_pipeline):
    p = dialogue_pipeline
    session = conversation_session_id(conversation())
    p.memory.save_exchange(session, "https://github.com/example/project", "Прочитать схему?", now=DAY)
    entered, release = asyncio.Event(), asyncio.Event()

    async def read(*args):
        entered.set()
        await release.wait()
        return "VERIFIED-SCHEMA-MARKER"

    p.router.github_followup = AsyncMock(side_effect=read)
    context = conversation(event_id="telegram:concurrent-research")
    first = asyncio.create_task(p.router.process("Да, прочитай.", context))
    await asyncio.wait_for(entered.wait(), timeout=2)
    duplicate = asyncio.create_task(p.router.process("Да, прочитай.", context))
    release.set()
    replies = await asyncio.gather(first, duplicate)
    assert replies[0].content == replies[1].content
    assert replies[1].context_used["replayed_event"]
    p.router.github_followup.assert_awaited_once()
    p.assess.assert_awaited_once()
    p.generate.assert_awaited_once()
    assert p.memory.get_stats()["total_messages"] == 4


async def test_valid_cyrillic_evidence_survives_internal_appraisal_roundtrips(dialogue_pipeline):
    p = dialogue_pipeline
    warmth_quote = ("Благодарю за тёплый разговор. " * 12)[:240]
    scene_quote = ("Представим нашу прогулку у набережной. " * 12)[:240]
    pause_quote = ("Сейчас хочу немного отдохнуть без сообщений. " * 12)[:240]
    label = ("Воображаемая прогулка по набережной " * 4)[:120]
    text = "\n".join((warmth_quote, scene_quote, pause_quote))
    p.assess.return_value = Appraisal("warmth", 0.5, warmth_quote, "keep", "", "",
        dialogue=update(scene_action="imagine", scene_label=label, scene_quote=scene_quote,
                        contact_action="pause", contact_quote=pause_quote))
    # JSON escaping must not turn valid character-limited evidence into a rejected event.
    assert len(json.dumps(asdict(p.assess.return_value))) > 4000
    await p.router.process(text, conversation(event_id="telegram:unicode-event"))
    state = p.store.get(conversation_session_id(conversation()))
    assert state["scene"]["label"] == label
    assert state["scene"]["source_quote"] == scene_quote
    assert state["pause_until"]
    assert p.core.state["happiness"] == pytest.approx(0.63)
    assert [event["event"] for event in p.core.recent_experiences] == [
        "user_message", "appraisal_warmth",
    ]
    p.assess.assert_awaited_once()


def test_pause_is_durable_and_next_user_message_can_resume(persistent_memory):
    from dialogue_state import DialogueStore, proactive_block_reason

    p = persistent_memory
    text = "Мне нужна пауза, не пиши пока."
    p.save_exchange("own", text, "Хорошо.", now=DAY,
                    appraisal=appraisal(update(contact_action="pause", contact_quote=text)))
    p.close()
    restarted = PersistentMemory(p.db_path)
    try:
        store = DialogueStore(restarted)
        assert proactive_block_reason(store.get("own"), DAY + timedelta(hours=7))
        assert not proactive_block_reason(store.get("own"), DAY + timedelta(hours=9))
        resumed = DAY + timedelta(minutes=30)
        restarted.save_exchange("own", "Я вернулся, можем поговорить.", "Я здесь.", now=resumed)
        assert not proactive_block_reason(store.get("own"), resumed)
        assert store.get("own")["pause_until"] is None
        assert store.get("other")["pause_until"] is None
    finally:
        restarted.close()


def test_unrelated_answer_cannot_close_a_question_from_another_session(persistent_memory):
    from dialogue_state import DialogueStore

    p = persistent_memory
    p.save_exchange("first", "Продолжим", QUESTION, now=DAY)
    p.save_exchange("second", "Планы", "Ты придёшь завтра?", now=DAY)
    store = DialogueStore(p)
    target = store.get("first")["pending_question"]["id"]
    before = store.get("second")
    with pytest.raises(ValueError):
        p.save_exchange("second", CARE, "Понятно.", now=DAY,
                        appraisal=appraisal(update(answer_to=target, answer_quote=CARE)))
    assert store.get("second") == before
    assert len(p.get_recent_messages("second")) == 2


def test_failed_exchange_rolls_back_dialogue_and_can_retry_same_event(persistent_memory):
    from dialogue_state import DialogueStore

    p = persistent_memory
    p.save_exchange("own", "Планы", QUESTION, now=DAY)
    store = DialogueStore(p)
    before = store.get("own")
    answer = appraisal(update(answer_to=before["pending_question"]["id"], answer_quote=CARE))
    conn = p._get_connection()
    conn.execute("""CREATE TRIGGER reject_dialogue_answer BEFORE INSERT ON messages
        WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'answer failure'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        p.save_exchange("own", CARE, "Спасибо.", appraisal=answer,
                        event_id="telegram:22", expected_revision=before["revision"], now=DAY)
    assert store.get("own") == before
    assert len(p.get_recent_messages("own")) == 2
    assert store.get_exchange("own", "telegram:22", CARE) is None
    conn.execute("DROP TRIGGER reject_dialogue_answer")
    p.save_exchange("own", CARE, "Спасибо.", appraisal=answer,
                    event_id="telegram:22", expected_revision=before["revision"], now=DAY)
    assert store.get("own")["pending_question"] is None
    assert len(p.get_recent_messages("own")) == 4


def test_old_database_opens_without_fabricating_dialogue_history(tmp_path):
    from dialogue_state import DialogueStore

    path = str(tmp_path / "old-memory.db")
    with sqlite3.connect(path) as conn:
        conn.execute("""CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
            speaker TEXT, channel TEXT DEFAULT 'unknown', timestamp TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP)""")
        conn.execute("""INSERT INTO messages(session_id,role,content,timestamp)
            VALUES ('legacy','assistant',?,?)""", (QUESTION, DAY.isoformat()))
    memory = PersistentMemory(path)
    try:
        assert memory.get_recent_messages("legacy")[0]["content"] == QUESTION
        state = DialogueStore(memory).get("legacy")
        assert state["pending_question"] is None
        assert state["scene"] is None
        memory.save_exchange("new", "Новый разговор", "Привет.", now=DAY)
        assert len(memory.get_recent_messages("new")) == 2
        assert len(memory.get_recent_messages("legacy")) == 1
    finally:
        memory.close()


def test_proactive_claim_is_exclusive_and_new_user_invalidates_reserved_send(persistent_memory):
    from dialogue_state import DialogueStore

    p = persistent_memory
    p.save_exchange("own", "До встречи", "Пока.", now=DAY)
    second = PersistentMemory(p.db_path)
    try:
        first_store, second_store = DialogueStore(p), DialogueStore(second)
        token = first_store.claim_proactive("own", now=DAY)
        assert token
        assert second_store.claim_proactive("own", now=DAY) is None
        second.save_exchange("own", "Я вернулся", "Привет.", now=DAY + timedelta(minutes=1))
        assert first_store.mark_sending(token, now=DAY + timedelta(minutes=1)) is False
        assert len(p.get_recent_messages("own")) == 4
        assert first_store.get("own")["proactive_since_user"] == 0
    finally:
        second.close()


def test_inflight_delivery_cannot_overwrite_a_newer_user_explanation_or_pause(persistent_memory):
    from dialogue_state import DialogueStore

    p = persistent_memory
    store = DialogueStore(p)
    p.save_exchange("own", "Вернёмся к разговору", QUESTION, now=DAY)
    question = store.get("own")["pending_question"]
    p.save_exchange("own", CARE, "Теперь понимаю.", now=DAY,
                    appraisal=appraisal(update(answer_to=question["id"], answer_quote=CARE)))
    token = store.claim_proactive("own", now=DAY)
    assert store.mark_sending(token, now=DAY)

    returned = DAY + timedelta(minutes=1)
    source = "Представим встречу в парке. Теперь мне нужна пауза."
    p.save_exchange("own", source, "Договорились.", now=returned,
                    appraisal=appraisal(update(scene_action="imagine", scene_label="Парк",
                        scene_quote="Представим встречу в парке.", contact_action="pause",
                        contact_quote="Теперь мне нужна пауза.")))
    accepted = store.get("own")
    stale_message = "Как тебе идея с книгой?"
    assert store.finish_proactive(token, stale_message, now=returned + timedelta(seconds=1))
    after = store.get("own")
    for field in ("scene", "pause_until", "pause_source", "pending_question", "closed_questions",
                  "last_user_id", "last_user_at", "proactive_since_user"):
        assert after[field] == accepted[field]
    assert p.get_recent_messages("own")[-1]["content"] == stale_message
    assert after["last_proactive_at"]


def test_clear_removes_own_dialogue_and_replay_receipts(persistent_memory):
    from dialogue_state import DialogueStore

    p = persistent_memory
    store = DialogueStore(p)
    for session in ("own", "other"):
        p.save_exchange(session, SCENE, QUESTION, now=DAY, event_id="same-provider-id",
                        appraisal=appraisal(update(scene_action="imagine", scene_label="Кафе",
                                                    scene_quote=SCENE)))
    p.clear_user("own")
    assert store.get("own")["scene"] is None
    assert store.get("own")["pending_question"] is None
    assert store.get_exchange("own", "same-provider-id", SCENE) is None
    assert store.get("other")["scene"]["kind"] == "shared_imagined"
    assert store.get("other")["pending_question"]
    assert store.get_exchange("other", "same-provider-id", SCENE)


def test_return_on_another_topic_does_not_force_answer_or_permanently_disable_initiative(persistent_memory):
    from dialogue_state import DialogueStore, proactive_block_reason, repeated_question

    memory = persistent_memory
    store = DialogueStore(memory)
    memory.save_exchange("own", "Поговорим", QUESTION, now=DAY)
    assert proactive_block_reason(store.get("own"), DAY) == "awaiting_answer"
    # The user may continue a different topic without answering a personal question.
    memory.save_exchange("own", "Давай лучше про новый проект", "Обсудим проект.", now=DAY)
    state = store.get("own")
    assert state["pending_question"]["status"] == "open"
    assert state["closed_questions"] == []  # no fabricated answer
    assert not proactive_block_reason(state, DAY)
    assert repeated_question("Вернёмся к кофе. " + QUESTION, state)


async def test_idle_heartbeats_do_not_repeat_pending_question_or_create_new_events(dialogue_bot):
    b = dialogue_bot
    p = b.pipeline
    own = conversation_session_id(conversation())
    p.memory.save_exchange(own, "Поговорим позже", QUESTION, now=DAY)
    before = p.store.get(own)
    experiences = p.core.get_emotional_state()["recent_experiences"]
    for hour in (0, 3, 6, 9):
        p.clock.now = DAY + timedelta(hours=hour)
        b.module.next_proactive_opportunity[1] = p.clock.now - timedelta(minutes=1)
        await b.module.autonomous_proactive_tick(b.delivery)
    b.generate.assert_not_awaited()
    b.delivery.bot.send_message.assert_not_awaited()
    p.assess.assert_not_awaited()
    assert p.store.get(own) == before
    assert p.core.get_emotional_state()["recent_experiences"] == experiences
    assert before["silence_reason"] == "unknown"


async def test_one_unanswered_proactive_survives_restart_of_bot_and_memory(dialogue_bot):
    from dialogue_state import DialogueStore

    b = dialogue_bot
    p = b.pipeline
    own = conversation_session_id(conversation())
    p.memory.save_exchange(own, "Поговорим позже", "До встречи.", now=DAY)
    await b.module.autonomous_proactive_tick(b.delivery)
    b.delivery.bot.send_message.assert_awaited_once()
    p.assess.assert_not_awaited()
    assert p.store.get(own)["proactive_since_user"] == 1
    assert p.memory.get_recent_messages(own)[-1]["content"] == b.generate.return_value

    p.memory.close()
    reopened = PersistentMemory(p.memory.db_path)
    try:
        b.module.router = AgentRouter(memory=reopened)
        b.module.last_proactive.clear()
        b.module.recent_proactive.clear()
        p.clock.now = DAY + timedelta(hours=4)
        b.module.next_proactive_opportunity[1] = p.clock.now - timedelta(minutes=1)
        await b.module.autonomous_proactive_tick(b.delivery)
        b.delivery.bot.send_message.assert_awaited_once()
        b.generate.assert_awaited_once()
        assert DialogueStore(reopened).get(own)["proactive_since_user"] == 1
    finally:
        reopened.close()


async def test_uncertain_delivery_is_not_history_and_is_not_retried_until_user_returns(dialogue_bot):
    b = dialogue_bot
    p = b.pipeline
    own = conversation_session_id(conversation())
    p.memory.save_exchange(own, "Поговорим позже", "До встречи.", now=DAY)
    b.delivery.bot.send_message.side_effect = RuntimeError("connection lost after send")
    await b.module.autonomous_proactive_tick(b.delivery)
    assert len(p.memory.get_recent_messages(own)) == 2
    assert p.store.get(own)["proactive_since_user"] == 0
    assert p.store.get(own)["pending_question"] is None
    assert not b.module.recent_proactive[1]

    p.clock.now = DAY + timedelta(hours=4)
    b.module.next_proactive_opportunity[1] = p.clock.now - timedelta(minutes=1)
    await b.module.autonomous_proactive_tick(b.delivery)
    b.delivery.bot.send_message.assert_awaited_once()
    b.generate.assert_awaited_once()
    p.memory.save_exchange(own, "Я снова здесь", "Привет.", now=p.clock.now)
    b.delivery.bot.send_message.side_effect = None
    b.module.next_proactive_opportunity[1] = p.clock.now - timedelta(minutes=1)
    await b.module.autonomous_proactive_tick(b.delivery)
    assert b.delivery.bot.send_message.await_count == 2
    assert p.memory.get_recent_messages(own)[-1]["content"] == b.generate.return_value
    assert p.store.get(own)["proactive_since_user"] == 1


async def test_resolved_question_with_new_opening_is_not_sent_again(dialogue_bot, monkeypatch):
    b = dialogue_bot
    p = b.pipeline
    own = conversation_session_id(conversation())
    p.memory.save_exchange(own, "Хочу дать тебе отдохнуть", QUESTION, now=DAY)
    question = p.store.get(own)["pending_question"]
    p.memory.save_exchange(own, CARE, "Теперь понимаю.", now=DAY,
                          appraisal=appraisal(update(answer_to=question["id"], answer_quote=CARE)))
    chat = AsyncMock(return_value="Кстати, вспомнила кофе. " + QUESTION)
    monkeypatch.setattr(b.module, "generate_autonomous_message", b.real_generate)
    monkeypatch.setattr(b.module, "ai", SimpleNamespace(chat=chat))
    await b.module.autonomous_proactive_tick(b.delivery)
    chat.assert_awaited_once()
    assert CARE in chat.call_args.args[0][1]["content"]
    b.delivery.bot.send_message.assert_not_awaited()
    assert len(p.memory.get_recent_messages(own)) == 4
    assert p.store.get(own)["proactive_since_user"] == 0
    assert p.store.get(own)["pending_question"] is None


async def test_arriving_user_cancels_proactive_generation_before_waiting_for_session_lock(dialogue_bot):
    b = dialogue_bot
    p = b.pipeline
    own = conversation_session_id(conversation())
    p.memory.save_exchange(own, "До встречи", "Пока.", now=DAY)
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed_proactive(*args, **kwargs):
        entered.set()
        await release.wait()
        return "Вспомнила прошлый разговор."

    b.generate.side_effect = delayed_proactive
    proactive = asyncio.create_task(b.module.autonomous_proactive_tick(b.delivery))
    incoming = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        incoming = asyncio.create_task(p.router.process("Я вернулся", conversation(event_id="telegram:200")))
        await asyncio.sleep(0)
        assert not incoming.done()  # The in-flight generation still owns this lock.
        release.set()
        await asyncio.wait_for(asyncio.gather(proactive, incoming), timeout=2)
    finally:
        release.set()
        tasks = [task for task in (proactive, incoming) if task is not None]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    b.delivery.bot.send_message.assert_not_awaited()
    assert [message["content"] for message in p.memory.get_recent_messages(own)] == [
        "До встречи", "Пока.", "Я вернулся", p.generate.return_value,
    ]
    assert p.store.get(own)["proactive_since_user"] == 0
    p.assess.assert_awaited_once()


async def test_concurrent_routers_return_first_committed_answer_and_agent_name(persistent_memory):
    """Two model calls are allowed here; only one committed reply is authoritative."""
    p = persistent_memory
    other_memory = PersistentMemory(p.db_path)
    entered = [asyncio.Event(), asyncio.Event()]
    release = [asyncio.Event(), asyncio.Event()]
    routers = [AgentRouter(memory=p), AgentRouter(memory=other_memory)]
    generated = ["Первый подготовленный ответ.", "Другой подготовленный ответ."]

    def make_agent(index):
        async def process(user_input, context):
            entered[index].set()
            await release[index].wait()
            return AgentResponse(content=generated[index], agent_name="Kristina-Advisor",
                                 confidence=0.9, emotion="thoughtful", suggested_actions=[], context_used={})
        return SimpleNamespace(name="Kristina-Advisor", process=process)

    for index, router in enumerate(routers):
        router.register_agent(make_agent(index), is_default=True)
    context = conversation(agent_id="advisor", event_id="telegram:shared-event")
    tasks = [asyncio.create_task(router.process("Нужен план", context)) for router in routers]
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered)), timeout=2)
        release[0].set()
        first = await asyncio.wait_for(tasks[0], timeout=2)
        release[1].set()
        second = await asyncio.wait_for(tasks[1], timeout=2)
        assert first.content == second.content == generated[0]
        assert first.agent_name == second.agent_name == "Kristina-Advisor"
        own = conversation_session_id(context)
        assert [message["content"] for message in p.get_recent_messages(own)] == [
            "Нужен план", generated[0],
        ]
        replay = await routers[1].process("Нужен план", context)
        assert replay.content == generated[0]
        assert replay.agent_name == "Kristina-Advisor"
    finally:
        for event in release:
            event.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        other_memory.close()
