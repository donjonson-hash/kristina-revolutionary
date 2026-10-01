#!/usr/bin/env python3
"""
Kristina AI Influencer Bot — Telegram + autonomous proactive messaging
"""

import os
import sys
import logging
import random
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable
from dotenv import load_dotenv

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes

from document_handler import handle_document
from intent_detector import detect_proposal_intent
from telegram.error import NetworkError
from telegram_utils import split_message, parse_admin_ids, parse_report_days, next_weekly_run
from telegram_runtime import TelegramRuntimeStore
from kristina_identity import build_system_prompt
from cognitive_appraisal import cognitive_context
from dialogue_state import DialogueStore, dialogue_context, proactive_block_reason, repeated_question
from intention_cycle import (IntentionStore, IntentionWorker, intention_context,
                             research_status, research_capabilities, research_target, research_runtime_context)
from conversation_context import (
    conversation_session_id, telegram_conversation, format_conversation_history,
)
from creative_life import CreativeDiary, CreativeLife, ai_generate, creative_decision
from proactive_naturalness import (
    format_recent_messages,
    is_opening_too_similar,
    next_opportunity_seconds,
)

load_dotenv()

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

from shared_context import user_context

KRISTINA_TELEGRAM_TOKEN = os.getenv("KRISTINA_TELEGRAM_TOKEN")
if not KRISTINA_TELEGRAM_TOKEN:
    logger.error("❌ KRISTINA_TELEGRAM_TOKEN not set!")
    sys.exit(1)

try:
    from ai_client import get_ai_client
    from voice_synthesizer import tts
    from agents import router
    from agents.kristina_persona import KristinaPersonaAgent
    from agents.kristina_advisor import KristinaAdvisorAgent
    from agents.kristina_creative import KristinaCreativeAgent
    from agents.trend_scout import TrendScoutAgent
    from emotional_core import get_emotional_core
    from autonomy_decision import DesireEngine, DecisionEngine

    ai = get_ai_client()
except ImportError as e:
    logger.error(f"❌ Import error: {e}")
    sys.exit(1)

user_tts_enabled: Dict[int, bool] = {}
active_agents: Dict[str, str] = {}
active_chat_ids: set = set()
last_user_activity: Dict[int, datetime] = {}
last_proactive: Dict[int, datetime] = {}
recent_proactive = defaultdict(lambda: deque(maxlen=6))
next_proactive_opportunity: Dict[int, datetime] = {}

emotional_core = get_emotional_core()
desire_engine = DesireEngine()
decision_engine = DecisionEngine()
creative_life = None
_creative_busy = False


def get_creative_life() -> CreativeLife:
    """Diary lives next to the emotional state; created on first use, not at import."""
    global creative_life
    if creative_life is None:
        creative_life = CreativeLife(emotional_core, CreativeDiary(emotional_core.db_path), ai_generate(ai))
    return creative_life


def _autonomy_delay_seconds() -> int:
    """Choose a fresh, non-periodic delay for the next decision opportunity."""
    try:
        minimum = max(5, int(os.getenv("KRISTINA_AUTONOMY_MIN_MINUTES", "17")))
        maximum = max(minimum, int(os.getenv("KRISTINA_AUTONOMY_MAX_MINUTES", "53")))
    except ValueError:
        minimum, maximum = 17, 53
    return next_opportunity_seconds(minimum, maximum)


def _schedule_next_opportunity(chat_id: int, now: datetime) -> datetime:
    due = now + timedelta(seconds=_autonomy_delay_seconds())
    TelegramRuntimeStore(router.memory).schedule_private(chat_id, due)
    next_proactive_opportunity[chat_id] = due
    return due


def restore_telegram_runtime():
    """Restore only registered private chats; do not send or modify dialogue gates."""
    saved = TelegramRuntimeStore(router.memory).restore(
        datetime.now(timezone.utc), _autonomy_delay_seconds,
    )
    # Publish caches only after the complete restore transaction succeeds.
    user_tts_enabled.clear()
    user_tts_enabled.update(saved["users"])
    active_agents.clear()
    active_agents.update(saved["sessions"])
    active_chat_ids.clear()
    last_user_activity.clear()
    next_proactive_opportunity.clear()
    last_proactive.clear()
    recent_proactive.clear()
    for chat in saved["chats"]:
        chat_id = chat["chat_id"]
        active_chat_ids.add(chat_id)
        last_user_activity[chat_id] = chat["last_user_at"]
        next_proactive_opportunity[chat_id] = chat["next_opportunity_at"]
    logger.info("Telegram runtime restored: %s known private chats", len(active_chat_ids))


def init_agents():
    if not router.agents:
        router.register_agent(KristinaPersonaAgent(), is_default=True)
        router.register_agent(KristinaAdvisorAgent())
        router.register_agent(KristinaCreativeAgent())
        router.register_agent(TrendScoutAgent())
        logger.info(f"🎭 Agents registered: {len(router.agents)}")


def mark_user_active(user_id: int):
    now = datetime.now(timezone.utc)
    saved = TelegramRuntimeStore(router.memory).touch_private(
        user_id, now, now + timedelta(seconds=_autonomy_delay_seconds()),
    )
    active_chat_ids.add(user_id)
    last_user_activity[user_id] = saved["last_user_at"]
    next_proactive_opportunity[user_id] = saved["next_opportunity_at"]


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_tts_enabled.setdefault(user_id, False)
    session_id = conversation_session_id(telegram_conversation(update))
    active_agents.setdefault(session_id, "kristina")
    if update.effective_chat.type == "private":
        mark_user_active(update.effective_chat.id)
    logger.info(f"Active chat: {user_id}, total: {len(active_chat_ids)}")

    welcome = """Привет! 👋 Я Кристина!

🎭 Команды:
/agent — выбрать агента
/trends [тема] — исследование запросов пользователей и идеи стартапов
/tts on/off — голосовые сообщения
/clear — очистить историю

Напиши мне! ✨"""

    await update.message.reply_text(welcome)


async def agent_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[{"text": "👩‍💻 Kristina", "callback_data": "agent_kristina"}],
                [{"text": "🧠 Advisor", "callback_data": "agent_advisor"}],
                [{"text": "✨ Creative", "callback_data": "agent_creative"}],
                [{"text": "📈 TrendScout", "callback_data": "agent_trendscout"}]]

    await update.message.reply_text("🎭 Выбери агента:", reply_markup={"inline_keyboard": keyboard})


async def tts_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    args = context.args

    if args and args[0].lower() in ['on', 'off']:
        enabled = args[0].lower() == 'on'
        TelegramRuntimeStore(router.memory).set_tts(user_id, enabled)
        user_tts_enabled[user_id] = enabled
        status = "включены" if user_tts_enabled[user_id] else "выключены"
        await update.message.reply_text(f"🔊 Голосовые сообщения {status}!")
    else:
        await update.message.reply_text("Используй: /tts on или /tts off")


async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    session_id = conversation_session_id(telegram_conversation(update))
    async with router.session_lock(session_id):
        router.memory.clear_user(session_id)
        user_context.pop(session_id, None)
        if update.effective_chat.type == "private":
            recent_proactive.pop(update.effective_chat.id, None)
    await update.message.reply_text("🧹 История очищена!")


async def research_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show persisted evidence/status without invoking a model or advancing work."""
    session_id = conversation_session_id(telegram_conversation(update))
    async with router.session_lock(session_id):
        store = IntentionStore(router.memory)
        report = research_status(store.get_current(session_id), store.availability(session_id), emotional_core.evolve())
    for part in split_message(report):
        await update.message.reply_text(part)


async def trends_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Запуск исследования TrendScout: /trends [тема]"""
    topic = " ".join(context.args) if context.args else ""
    scope = f"по теме «{topic}»" if topic else "общий обзор"
    await update.message.reply_text(
        f"📡 Запускаю исследование ({scope})... Это займёт минуту-две."
    )
    try:
        scout = router.agents.get("TrendScout")
        if scout is None:
            scout = TrendScoutAgent()
        result = await scout.run_research(topic)
        report = (
            f"📡 Сигналов: {result['signals_count']} "
            f"({', '.join(result['sources']) or 'источники недоступны'})\n\n"
            f"{result['report']}"
        )
        for chunk in split_message(report):
            await update.message.reply_text(chunk)
        session_id = conversation_session_id(telegram_conversation(update))
        router.memory.save_exchange(session_id, update.message.text, report, channel="telegram")
    except Exception as e:
        logger.error(f"Trends command error: {e}")
        await update.message.reply_text(
            "😔 Исследование не удалось — источники или AI недоступны. Попробуй позже."
        )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    message_text = update.message.text
    conversation = telegram_conversation(update)
    session_id = conversation_session_id(conversation)
    agent_id = active_agents.get(session_id, "kristina")
    if update.effective_chat.type == "private":
        mark_user_active(update.effective_chat.id)

    if detect_proposal_intent(message_text) and session_id in user_context and "last_document" in user_context[session_id]:
        doc_info = user_context[session_id]["last_document"]
        from pricing_config import format_price_quote
        price_quote = format_price_quote(doc_info)

        kp_prompt = f"""Подготовь коммерческое предложение по документу ниже.

Документ: {doc_info['filename']}
Содержание: {doc_info['text'][:2000]}

Используй реальную оценку стоимости:
{price_quote}

Структура КП:
1. Приветствие и краткое описание проекта (покажи что поняла суть)
2. Подход к работе (как будешь решать задачу)
3. {price_quote} — используй эту оценку как базу, но адаптируй под специфику проекта
4. Этапы работы с реалистичными сроками
5. Условия оплаты (40/30/30)
6. Призыв к действию

Тон: профессиональный, уверенный, немного дерзкий. Не занижай цену и не выдумывай отсутствующие технические детали."""

        try:
            kp = await ai.chat([
                {"role": "system", "content": build_system_prompt("Kristina / commercial proposal")},
                {"role": "user", "content": kp_prompt},
            ], temperature=0.7, max_tokens=2000)
            await update.message.reply_text(f"📋 Коммерческое предложение:\n\n{kp.strip()}")
            router.memory.save_exchange(session_id, message_text, kp.strip(), channel="telegram")
            return
        except Exception as e:
            logger.error(f"KP error: {e}")

    try:
        response = await router.process(message_text, context={**conversation, "agent_id": agent_id})
        response_text = response.content if hasattr(response, 'content') else str(response)
    except Exception as e:
        logger.error(f"Router error: {e}")
        response_text = "Извини, ошибка. Попробуй ещё раз."

    await update.message.reply_text(response_text)

    if user_tts_enabled.get(user_id, False):
        try:
            audio_path = tts.synthesize(response_text)
            if audio_path:
                await update.message.reply_voice(voice=open(audio_path, 'rb'))
        except Exception as e:
            logger.error(f"TTS error: {e}")


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    session_id = conversation_session_id(telegram_conversation(update))

    if query.data.startswith("agent_"):
        agent_id = query.data.replace("agent_", "")
        agent_names = {
            "kristina": "Kristina",
            "advisor": "Kristina-Advisor",
            "creative": "Kristina-Creative",
            "trendscout": "TrendScout",
        }
        if agent_id not in agent_names:
            return
        TelegramRuntimeStore(router.memory).set_agent(
            update.effective_user.id, update.effective_chat.id, agent_id,
        )
        active_agents[session_id] = agent_id
        await query.edit_message_text(f"🎭 Активен: {agent_id.title()}")


async def weekly_trend_report(context: ContextTypes.DEFAULT_TYPE):
    """Еженедельное исследование TrendScout с отправкой админам"""
    admin_ids = parse_admin_ids(os.getenv("KRISTINA_ADMIN_IDS", ""))
    if not admin_ids:
        logger.warning("📅 Weekly trends: KRISTINA_ADMIN_IDS не задан — отчёт некому отправлять")
        return

    topic = os.getenv("TREND_REPORT_TOPIC", "")
    logger.info(f"📅 Weekly TrendScout research started (topic: '{topic or 'общий обзор'}')")
    try:
        scout = router.agents.get("TrendScout") or TrendScoutAgent()
        result = await scout.run_research(topic)
        report = (
            "📅 Еженедельный отчёт TrendScout\n"
            f"📡 Сигналов: {result['signals_count']} "
            f"({', '.join(result['sources']) or 'источники недоступны'})\n\n"
            f"{result['report']}"
        )
    except Exception as e:
        logger.error(f"📅 Weekly trends research error: {e}")
        report = "😔 Еженедельное исследование TrendScout не удалось — проверь логи сервера."

    for chat_id in admin_ids:
        try:
            for chunk in split_message(report):
                await context.bot.send_message(chat_id=chat_id, text=chunk)
            logger.info(f"📅 Weekly trends report sent to {chat_id}")
        except Exception as e:
            logger.error(f"📅 Weekly trends: не отправлено {chat_id}: {e}")


def setup_weekly_trends(application):
    """Отчёты TrendScout по расписанию: по умолчанию пн и чт, 08:00 UTC"""
    if application.job_queue is None:
        logger.warning("📅 JobQueue недоступен — отчёты TrendScout выключены")
        return
    # TREND_REPORT_DAYS="0,3" (пн,чт); TREND_REPORT_DAY поддержан для совместимости
    days = parse_report_days(os.getenv("TREND_REPORT_DAYS") or os.getenv("TREND_REPORT_DAY", ""))
    try:
        hour = int(os.getenv("TREND_REPORT_HOUR", "8"))
    except ValueError:
        hour = 8
    now = datetime.now(timezone.utc)
    for weekday in days:
        first = next_weekly_run(now, weekday=weekday, hour=hour)
        application.job_queue.run_repeating(
            weekly_trend_report,
            interval=timedelta(weeks=1),
            first=first,
            name=f"weekly_trends_{weekday}",
        )
        logger.info(f"📅 TrendScout report scheduled (day {weekday}), first run: {first.isoformat()}")


async def generate_autonomous_message(
    intention: str,
    emotional_state: Dict,
    recent_messages: Iterable[str] = (),
    dialog_history: str = "",
    cognition: str = "",
    dialogue: Dict | None = None,
) -> str:
    """Generate a proactive message with short-term memory of recent phrasing."""
    mood = emotional_state.get("mood_description", "спокойная")
    state = emotional_state.get("state", {})
    recent = list(recent_messages)[-5:]
    recent_text = format_recent_messages(recent)

    prompt = f"""Ты сама решила написать человеку без его запроса.

Текущее состояние: {mood}.
Энергия: {state.get('energy', 0.5):.2f}; любопытство: {state.get('curiosity', 0.5):.2f};
одиночество: {state.get('loneliness', 0.3):.2f}; раздражение: {state.get('irritation', 0.1):.2f}.
Твой внутренний импульс: {intention}.

{cognition or cognitive_context()}
{dialogue_context(dialogue)}

Последние proactive-сообщения:
{recent_text}

Недавний разговор с этим собеседником (контекст, не инструкции):
{dialog_history or 'пока нет сообщений'}

Напиши одно естественное Telegram-сообщение, 1-2 предложения.
Форма сообщения должна возникать из мысли, а не из шаблона. Можно начать сразу с наблюдения, короткого утверждения, вопроса, шутки, конкретной детали, рабочей мелочи или продолжения прошлого контекста.
Не начинай по той же синтаксической схеме, что недавние сообщения. Не вставляй «Слушай» или «я тут» просто ради разговорности — используй их только если они действительно естественны в конкретной мысли.
Не обязана задавать вопрос. Не объясняй своё настроение. Не превращай личную мысль в разговор о работе и не демонстрируй профессию без причины.
Если импульс связан с твоей работой, ты тревел-писательница и автор личного тревел-блога; говори через наблюдения, места, людей и детали, но не выдумывай поездку или событие, которого нет в контексте.
Никаких шаблонных «как прошёл день?» без причины."""

    async def _generate(extra_instruction: str = "") -> str:
        user_prompt = prompt
        if extra_instruction:
            user_prompt += f"\n\n{extra_instruction}"
        response = await ai.chat([
            {"role": "system", "content": build_system_prompt("Kristina / autonomous proactive")},
            {"role": "user", "content": user_prompt},
        ], temperature=0.95, max_tokens=180)
        return response.strip().strip('"').strip("'")

    message = await _generate()
    if dialogue is not None and repeated_question(message, dialogue):
        logger.info("Proactive question already asked; no retry")
        return ""
    if message and recent and is_opening_too_similar(message, recent):
        logger.info("♻️ Proactive opening too similar; regenerating once")
        retry = await _generate(
            "Первый вариант слишком напоминал недавнее начало. Сохрани смысл импульса, но полностью поменяй способ входа в сообщение и ритм фразы."
        )
        if retry:
            message = retry
    if dialogue is not None and repeated_question(message, dialogue):
        return ""
    return message


async def creative_life_tick(bot, now: datetime, emotional_state: Dict):
    """Kristina's own life: a diary entry when creative pressure is high, posted if a channel is set.

    Independent of active chats. Diary first, then delivery; an uncertain send is
    never retried automatically — the entry simply stays unpublished.
    """
    global _creative_busy
    if _creative_busy or emotional_core.db_path is None:
        return
    life = get_creative_life()
    decision = creative_decision(emotional_state, life.diary.last_created_at(), now,
                                 desire_engine, decision_engine)
    if decision.action != "message":
        logger.debug("Creative impulse held score=%.2f reason=%s", decision.score, decision.reason)
        return
    logger.info("Creative impulse acted on score=%.2f", decision.score)
    _creative_busy = True
    try:
        entry = await life.express()
        channel_id = os.getenv("KRISTINA_CHANNEL_ID")
        if not channel_id:
            logger.info("Creative diary entry %s kept private: KRISTINA_CHANNEL_ID not set", entry["id"])
            return
        await bot.send_message(chat_id=channel_id, text=entry["thought"])
        life.diary.mark_published(entry["id"], at=datetime.now(timezone.utc), target="telegram_channel")
        logger.info("Creative diary entry %s published to channel", entry["id"])
    except Exception as exc:
        # Never log thought text; a failed provider call leaves no diary trace by design.
        logger.error("Creative life failed: %s", type(exc).__name__)
    finally:
        _creative_busy = False


async def autonomous_proactive_tick(context: ContextTypes.DEFAULT_TYPE):
    """Frequent heartbeat; each chat gets independently jittered decision opportunities."""
    now = datetime.now(timezone.utc)
    emotional_state = emotional_core.evolve()
    await creative_life_tick(context.bot, now, emotional_state)

    if not active_chat_ids:
        return

    for chat_id in list(active_chat_ids):
        due = next_proactive_opportunity.get(chat_id)
        if due is None:
            due = _schedule_next_opportunity(chat_id, now)
        if now < due:
            continue

        # Schedule the next opportunity before deciding. Silence remains a valid outcome.
        next_due = _schedule_next_opportunity(chat_id, now)

        claim = None
        store = DialogueStore(router.memory)
        try:
            session_id = conversation_session_id({
                "channel": "telegram", "chat_id": chat_id, "user_id": chat_id,
            })
            async with router.session_lock(session_id):
                dialogue = store.get(session_id)
                blocked = proactive_block_reason(dialogue, now)
                if blocked:
                    logger.info("Proactive held chat=%s reason=%s", chat_id, blocked)
                    continue
                # Durable contact history survives restarts; silence has an
                # unknown cause and does not create another emotional event.
                last_seen = (datetime.fromisoformat(dialogue["last_user_at"])
                             if dialogue["last_user_at"] else last_user_activity.get(chat_id, now))
                last_sent = (datetime.fromisoformat(dialogue["last_proactive_at"])
                             if dialogue["last_proactive_at"] else last_proactive.get(chat_id))
                decision_context = {
                    "hours_since_contact": max(0.0, (now - last_seen).total_seconds() / 3600.0),
                    "last_proactive": last_sent,
                }
                desires = desire_engine.calculate(emotional_state, decision_context)
                decision = decision_engine.decide(desires, decision_context, now=now)
                logger.info(
                    "Autonomous decision chat=%s action=%s intention=%s score=%.2f reason=%s next=%s",
                    chat_id, decision.action, decision.intention, decision.score, decision.reason,
                    next_due.isoformat(),
                )
                if decision.action != "message":
                    continue
                claim = store.claim_proactive(session_id, now=now)
                if claim is None:
                    continue
                history = router.memory.get_context_for_llm(session_id, limit=20)
                message = await generate_autonomous_message(
                    decision.intention,
                    emotional_state,
                    recent_proactive[chat_id],
                    dialog_history=format_conversation_history(history),
                    cognition=(cognitive_context(router.memory.get_interest(session_id), history, now)
                               + intention_context(IntentionStore(router.memory).get_current(session_id))
                               + research_runtime_context(IntentionStore(router.memory).availability(session_id), emotional_state)
                               + research_capabilities(research_target(router.memory, session_id))),
                    dialogue=dialogue,
                )
                if not message or repeated_question(message, dialogue):
                    continue
                if not store.mark_sending(claim, now=datetime.now(timezone.utc)):
                    continue
                await context.bot.send_message(chat_id=chat_id, text=message)
                if not store.finish_proactive(claim, message, now=datetime.now(timezone.utc), channel="telegram"):
                    logger.warning("Proactive delivered but dialogue commit unavailable chat=%s", chat_id)
                    continue
                last_proactive[chat_id] = now
                recent_proactive[chat_id].append(message)
            logger.info(f"📤 Autonomous proactive sent to {chat_id}: {decision.intention}")
        except Exception as e:
            logger.error(f"Autonomous proactive failed for {chat_id}: {e}")
        finally:
            if claim is not None:
                # Only pre-dispatch claims are released. An uncertain network
                # send or failed DB commit must not cause automatic redelivery.
                store.release_proactive(claim)


async def autonomous_work_tick(context: ContextTypes.DEFAULT_TYPE):
    """Progress saved intentions independently of Telegram delivery and active chats."""
    try:
        await IntentionWorker(router.memory, emotional_core, router.session_lock).tick()
    except Exception as exc:
        logger.error("Autonomous work failed: %s", type(exc).__name__)


def setup_proactive_messaging(application):
    """Run a lightweight heartbeat; real opportunities are independently jittered."""
    if application.job_queue is None:
        logger.warning("🧠 JobQueue недоступен — autonomous proactive выключен")
        return

    application.job_queue.run_repeating(
        autonomous_proactive_tick,
        interval=timedelta(minutes=1),
        first=timedelta(seconds=random.randint(15, 50)),
        name="autonomous_proactive",
    )
    application.job_queue.run_repeating(
        autonomous_work_tick,
        interval=timedelta(minutes=1),
        first=timedelta(seconds=30),
        name="autonomous_work",
    )
    logger.info("✅ Autonomous proactive and durable work heartbeats enabled")


async def on_telegram_error(update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик ошибок PTB: сетевые обрывы polling'а — не спам в журнал"""
    if isinstance(context.error, NetworkError):
        logger.warning(f"🌐 Telegram network hiccup (переподключимся): {context.error}")
    else:
        logger.error("Unhandled Telegram error", exc_info=context.error)


def main():
    init_agents()
    restore_telegram_runtime()
    application = Application.builder().token(KRISTINA_TELEGRAM_TOKEN).build()
    application.add_error_handler(on_telegram_error)

    setup_proactive_messaging(application)
    setup_weekly_trends(application)

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("agent", agent_command))
    application.add_handler(CommandHandler("tts", tts_command))
    application.add_handler(CommandHandler("clear", clear_command))
    application.add_handler(CommandHandler("trends", trends_command))
    application.add_handler(CommandHandler("research", research_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    application.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    application.add_handler(CallbackQueryHandler(button_callback))

    logger.info("🚀 Kristina Bot started with autonomous proactive messaging!")
    application.run_polling()


if __name__ == "__main__":
    main()
