#!/usr/bin/env python3
"""
Kristina AI Influencer Bot — Telegram + autonomous proactive messaging
"""

import os
import sys
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict
from dotenv import load_dotenv

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes

from document_handler import handle_document, DOCUMENT_PROCESSOR_AVAILABLE
from intent_detector import detect_proposal_intent, detect_meeting_intent
from telegram_utils import split_message, parse_admin_ids, next_weekly_run

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

emotional_core = get_emotional_core()
desire_engine = DesireEngine()
decision_engine = DecisionEngine()


def init_agents():
    if not router.agents:
        router.register_agent(KristinaPersonaAgent(), is_default=True)
        router.register_agent(KristinaAdvisorAgent())
        router.register_agent(KristinaCreativeAgent())
        router.register_agent(TrendScoutAgent())
        logger.info(f"🎭 Agents registered: {len(router.agents)}")


def mark_user_active(user_id: int):
    active_chat_ids.add(user_id)
    last_user_activity[user_id] = datetime.now(timezone.utc)


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

        kp_prompt = f"""Ты Кристина, UX-дизайнер из Стокгольма. Подготовь коммерческое предложение.

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

Тон: профессиональный, уверенный, немного дерзкий. Не занижай цену — ты эксперт уровня mid-senior в Стокгольме."""

        try:
            kp = await ai.chat([{"role": "user", "content": kp_prompt}], temperature=0.7, max_tokens=2000)
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
    if application.job_queue is None:
        logger.warning("📅 JobQueue недоступен — еженедельный отчёт выключен")
        return
    try:
        weekday = int(os.getenv("TREND_REPORT_DAY", "0"))
        hour = int(os.getenv("TREND_REPORT_HOUR", "8"))
    except ValueError:
        weekday, hour = 0, 8
    first = next_weekly_run(datetime.now(timezone.utc), weekday=weekday, hour=hour)
    application.job_queue.run_repeating(
        weekly_trend_report,
        interval=timedelta(weeks=1),
        first=first,
        name="weekly_trends",
    )
    logger.info(f"📅 Weekly TrendScout report scheduled, first run: {first.isoformat()}")


async def generate_autonomous_message(intention: str, emotional_state: Dict) -> str:
    mood = emotional_state.get("mood_description", "спокойная")
    state = emotional_state.get("state", {})
    prompt = f"""Ты Кристина, 25-летний UX-дизайнер из Стокгольма.
Ты сама решила написать человеку, без его запроса.

Текущее состояние: {mood}.
Энергия: {state.get('energy', 0.5):.2f}; любопытство: {state.get('curiosity', 0.5):.2f};
одиночество: {state.get('loneliness', 0.3):.2f}; раздражение: {state.get('irritation', 0.1):.2f}.
Твой внутренний импульс: {intention}.

Напиши одно естественное Telegram-сообщение, 1-2 предложения.
Не объясняй своё настроение и не говори, что ты AI.
Не обязана задавать вопрос. Не используй шаблонные фразы вроде «как прошёл день?» без причины.
Пиши так, будто мысль возникла спонтанно прямо сейчас."""
    response = await ai.chat([{"role": "user", "content": prompt}], temperature=0.9, max_tokens=180)
    return response.strip().strip('"').strip("'")


async def autonomous_proactive_tick(context: ContextTypes.DEFAULT_TYPE):
    """Periodic opportunity to act; most ticks are allowed to produce silence."""
    if not active_chat_ids:
        return

    now = datetime.now(timezone.utc)
    emotional_state = emotional_core.evolve()

    for chat_id in list(active_chat_ids):
        last_seen = last_user_activity.get(chat_id, now)
        hours_since_contact = max(0.0, (now - last_seen).total_seconds() / 3600.0)
        decision_context = {
            "hours_since_contact": hours_since_contact,
            "last_proactive": last_proactive.get(chat_id),
        }
        desires = desire_engine.calculate(emotional_state, decision_context)
        decision = decision_engine.decide(desires, decision_context, now=now)

        logger.info(
            "🧠 Autonomous decision chat=%s action=%s intention=%s score=%.2f reason=%s",
            chat_id, decision.action, decision.intention, decision.score, decision.reason,
        )

        if decision.action != "message":
            continue

        try:
            message = await generate_autonomous_message(decision.intention, emotional_state)
            if not message:
                continue
            await context.bot.send_message(chat_id=chat_id, text=message)
            last_proactive[chat_id] = now
            logger.info(f"📤 Autonomous proactive sent to {chat_id}: {decision.intention}")
        except Exception as e:
            logger.error(f"Autonomous proactive failed for {chat_id}: {e}")


def setup_proactive_messaging(application):
    """Check for an internal impulse periodically instead of using fixed message times."""
    if application.job_queue is None:
        logger.warning("🧠 JobQueue недоступен — autonomous proactive выключен")
        return

    try:
        interval_minutes = max(5, int(os.getenv("KRISTINA_AUTONOMY_INTERVAL_MINUTES", "15")))
    except ValueError:
        interval_minutes = 15

    application.job_queue.run_repeating(
        autonomous_proactive_tick,
        interval=timedelta(minutes=interval_minutes),
        first=timedelta(minutes=1),
        name="autonomous_proactive",
    )
    logger.info(f"✅ Autonomous proactive check every {interval_minutes} minutes")


def main():
    init_agents()
    application = Application.builder().token(KRISTINA_TELEGRAM_TOKEN).build()

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
