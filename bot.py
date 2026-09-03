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

from document_handler import handle_document, DOCUMENT_PROCESSOR_AVAILABLE
from intent_detector import detect_proposal_intent, detect_meeting_intent
from telegram.error import NetworkError
from telegram_utils import split_message, parse_admin_ids, parse_report_days, next_weekly_run
from kristina_identity import build_system_prompt
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
active_agents: Dict[int, str] = {}
active_chat_ids: set = set()
last_user_activity: Dict[int, datetime] = {}
last_proactive: Dict[int, datetime] = {}
recent_proactive = defaultdict(lambda: deque(maxlen=6))
next_proactive_opportunity: Dict[int, datetime] = {}

emotional_core = get_emotional_core()
desire_engine = DesireEngine()
decision_engine = DecisionEngine()


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
    next_proactive_opportunity[chat_id] = due
    return due


def init_agents():
    if not router.agents:
        router.register_agent(KristinaPersonaAgent(), is_default=True)
        router.register_agent(KristinaAdvisorAgent())
        router.register_agent(KristinaCreativeAgent())
        router.register_agent(TrendScoutAgent())
        logger.info(f"🎭 Agents registered: {len(router.agents)}")


def mark_user_active(user_id: int):
    active_chat_ids.add(user_id)
    now = datetime.now(timezone.utc)
    last_user_activity[user_id] = now
    if user_id not in next_proactive_opportunity:
        _schedule_next_opportunity(user_id, now)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_tts_enabled[user_id] = False
    active_agents[user_id] = "kristina"
    mark_user_active(user_id)
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
        user_tts_enabled[user_id] = (args[0].lower() == 'on')
        status = "включены" if user_tts_enabled[user_id] else "выключены"
        await update.message.reply_text(f"🔊 Голосовые сообщения {status}!")
    else:
        await update.message.reply_text("Используй: /tts on или /tts off")


async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🧹 История очищена!")


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
    except Exception as e:
        logger.error(f"Trends command error: {e}")
        await update.message.reply_text(
            "😔 Исследование не удалось — источники или AI недоступны. Попробуй позже."
        )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    message_text = update.message.text
    agent_id = active_agents.get(user_id, "kristina")
    mark_user_active(user_id)

    if detect_proposal_intent(message_text) and user_id in user_context and "last_document" in user_context[user_id]:
        doc_info = user_context[user_id]["last_document"]
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
            return
        except Exception as e:
            logger.error(f"KP error: {e}")

    try:
        response = await router.process(message_text, context={"agent_id": agent_id, "user_id": user_id})
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
    user_id = update.effective_user.id

    if query.data.startswith("agent_"):
        agent_id = query.data.replace("agent_", "")
        active_agents[user_id] = agent_id
        agent_names = {
            "kristina": "Kristina",
            "advisor": "Kristina-Advisor",
            "creative": "Kristina-Creative",
            "trendscout": "TrendScout",
        }
        if agent_id in agent_names:
            router.set_active_agent(agent_names[agent_id])
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

Последние proactive-сообщения:
{recent_text}

Напиши одно естественное Telegram-сообщение, 1-2 предложения.
Форма сообщения должна возникать из мысли, а не из шаблона. Можно начать сразу с наблюдения, короткого утверждения, вопроса, шутки, конкретной детали, рабочей мелочи или продолжения прошлого контекста.
Не начинай по той же синтаксической схеме, что недавние сообщения. Не вставляй «Слушай» или «я тут» просто ради разговорности — используй их только если они действительно естественны в конкретной мысли.
Не обязана задавать вопрос. Не объясняй своё настроение. Не превращай личную мысль в разговор о работе и не демонстрируй профессию без причины.
Если импульс рабочий, ты Senior Software Engineer / Team Lead; UX-дизайнером ты не являешься.
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
    if message and recent and is_opening_too_similar(message, recent):
        logger.info("♻️ Proactive opening too similar; regenerating once")
        retry = await _generate(
            "Первый вариант слишком напоминал недавнее начало. Сохрани смысл импульса, но полностью поменяй способ входа в сообщение и ритм фразы."
        )
        if retry:
            message = retry

    return message


async def autonomous_proactive_tick(context: ContextTypes.DEFAULT_TYPE):
    """Frequent heartbeat; each chat gets independently jittered decision opportunities."""
    if not active_chat_ids:
        return

    now = datetime.now(timezone.utc)
    emotional_state = emotional_core.evolve()

    for chat_id in list(active_chat_ids):
        due = next_proactive_opportunity.get(chat_id)
        if due is None:
            due = _schedule_next_opportunity(chat_id, now)
        if now < due:
            continue

        # Schedule the next opportunity before deciding. Silence remains a valid outcome.
        next_due = _schedule_next_opportunity(chat_id, now)

        last_seen = last_user_activity.get(chat_id, now)
        hours_since_contact = max(0.0, (now - last_seen).total_seconds() / 3600.0)
        decision_context = {
            "hours_since_contact": hours_since_contact,
            "last_proactive": last_proactive.get(chat_id),
        }
        desires = desire_engine.calculate(emotional_state, decision_context)
        decision = decision_engine.decide(desires, decision_context, now=now)

        logger.info(
            "🧠 Autonomous decision chat=%s action=%s intention=%s score=%.2f reason=%s next=%s",
            chat_id, decision.action, decision.intention, decision.score, decision.reason,
            next_due.isoformat(),
        )

        if decision.action != "message":
            continue

        try:
            message = await generate_autonomous_message(
                decision.intention,
                emotional_state,
                recent_proactive[chat_id],
            )
            if not message:
                continue
            await context.bot.send_message(chat_id=chat_id, text=message)
            last_proactive[chat_id] = now
            recent_proactive[chat_id].append(message)
            logger.info(f"📤 Autonomous proactive sent to {chat_id}: {decision.intention}")
        except Exception as e:
            logger.error(f"Autonomous proactive failed for {chat_id}: {e}")


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
    logger.info("✅ Autonomous proactive heartbeat enabled with jittered opportunities")


async def on_telegram_error(update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик ошибок PTB: сетевые обрывы polling'а — не спам в журнал"""
    if isinstance(context.error, NetworkError):
        logger.warning(f"🌐 Telegram network hiccup (переподключимся): {context.error}")
    else:
        logger.error("Unhandled Telegram error", exc_info=context.error)


def main():
    init_agents()
    application = Application.builder().token(KRISTINA_TELEGRAM_TOKEN).build()
    application.add_error_handler(on_telegram_error)

    setup_proactive_messaging(application)
    setup_weekly_trends(application)

    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("agent", agent_command))
    application.add_handler(CommandHandler("tts", tts_command))
    application.add_handler(CommandHandler("clear", clear_command))
    application.add_handler(CommandHandler("trends", trends_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    application.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    application.add_handler(CallbackQueryHandler(button_callback))

    logger.info("🚀 Kristina Bot started with autonomous proactive messaging!")
    application.run_polling()


if __name__ == "__main__":
    main()
