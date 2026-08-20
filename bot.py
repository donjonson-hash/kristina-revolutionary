#!/usr/bin/env python3
"""
Kristina AI Influencer Bot — Telegram + Proactive Messaging
"""

import os
import sys
import logging
import asyncio
from datetime import datetime
from typing import Dict, Optional
from dotenv import load_dotenv

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes
from apscheduler.schedulers.background import BackgroundScheduler

# Document handler and intent detection
from document_handler import handle_document, DOCUMENT_PROCESSOR_AVAILABLE
from intent_detector import detect_proposal_intent, detect_meeting_intent

load_dotenv()

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
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
    from proactive_messaging import SCHEDULE
    
    # Получаем AI клиент
    ai = get_ai_client()
except ImportError as e:
    logger.error(f"❌ Import error: {e}")
    sys.exit(1)

user_tts_enabled: Dict[int, bool] = {}
active_agents: Dict[int, str] = {}
active_chat_ids: set = set()  # Для proactive messaging

def init_agents():
    if not router.agents:
        router.register_agent(KristinaPersonaAgent(), is_default=True)
        router.register_agent(KristinaAdvisorAgent())
        router.register_agent(KristinaCreativeAgent())
        router.register_agent(TrendScoutAgent())
        logger.info(f"🎭 Agents registered: {len(router.agents)}")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_tts_enabled[user_id] = False
    active_agents[user_id] = "kristina"
    active_chat_ids.add(user_id)
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
        # Telegram ограничивает сообщение 4096 символами
        for i in range(0, len(report), 4000):
            await update.message.reply_text(report[i:i + 4000])
    except Exception as e:
        logger.error(f"Trends command error: {e}")
        await update.message.reply_text(
            "😔 Исследование не удалось — источники или AI недоступны. Попробуй позже."
        )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    message_text = update.message.text
    agent_id = active_agents.get(user_id, "kristina")
    active_chat_ids.add(user_id)
    
    # Сначала проверяем специальные намерения (КП, встреча)
    if detect_proposal_intent(message_text) and user_id in user_context and "last_document" in user_context[user_id]:
        # Генерируем коммерческое предложение
        doc_info = user_context[user_id]["last_document"]
        # Рассчитываем реальную стоимость
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
    
    # Стандартная обработка через агента
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
        # Переключаем агента и в роутере
        agent_names = {
            "kristina": "Kristina",
            "advisor": "Kristina-Advisor",
            "creative": "Kristina-Creative",
            "trendscout": "TrendScout",
        }
        if agent_id in agent_names:
            router.set_active_agent(agent_names[agent_id])
        await query.edit_message_text(f"🎭 Активен: {agent_id.title()}")

# ✅ PROACTIVE MESSAGING
def send_proactive_message(application, mood: str, energy: int, time_str: str):
    """Отправить proactive сообщение всем активным пользователям"""
    if not active_chat_ids:
        logger.info(f"📤 Proactive [{time_str}]: нет активных чатов")
        return
    
    # Генерируем сообщение based on mood
    messages = {
        "пробуждение": "🌅 Доброе утро! Как спалось? Готова к новому дню?",
        "любопытство": "🔍 Интересно... Чем занимаешься сейчас?",
        "энергия": "⚡ Пик энергии! Давай творить что-то крутое!",
        "работа": "💼 Как продвигается работа? Нужен совет?",
        "мечтательность": "☁️ Время мечтать... О чём думаешь?",
        "ностальгия": "🌅 Помнишь наше первое сообщение? Было здорово!",
        "размышление": "🤔 Вечер — время подвести итоги. Как прошёл день?",
        "интимность": "💫 Привет... Хочется просто поговорить по-настоящему. Как ты?",
        "спокойствие": "🌙 Вечернее спокойствие... Расскажи, что на душе?",
        "меланхолия": "🌧️ Тихий вечер... Иногда это тоже прекрасно, да?",
        "сон": "😴 Пора отдыхать. Спокойной ночи!",
        "мистика": "🌙 Полночь... Время тайн и загадок. Не спишь?"
    }
    
    message = messages.get(mood, f"✨ Привет! Настроение: {mood}")
    
    # Отправляем всем активным чатам
    for chat_id in list(active_chat_ids):
        try:
            asyncio.create_task(
                application.bot.send_message(chat_id=chat_id, text=message)
            )
            logger.info(f"📤 Proactive to {chat_id}: {mood}")
        except Exception as e:
            logger.error(f"Failed to send proactive to {chat_id}: {e}")

def setup_proactive_messaging(application):
    """Настроить proactive messaging"""
    try:
        scheduler = BackgroundScheduler()
        
        for time_str, config in SCHEDULE.items():
            hour, minute = map(int, time_str.split(':'))
            
            scheduler.add_job(
                lambda t=time_str, c=config: send_proactive_message(
                    application, c['mood'], c['energy'], t
                ),
                'cron',
                hour=hour,
                minute=minute,
                id=f"proactive_{time_str}",
                replace_existing=True
            )
            logger.info(f"📅 Scheduled: {time_str} - {config['mood']}")
        
        scheduler.start()
        logger.info(f"✅ Proactive messaging: {len(SCHEDULE)} jobs")
        
    except Exception as e:
        logger.error(f"Proactive setup error: {e}")

def main():
    init_agents()
    application = Application.builder().token(KRISTINA_TELEGRAM_TOKEN).build()
    
    # Setup proactive
    setup_proactive_messaging(application)
    
    # Handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("agent", agent_command))
    application.add_handler(CommandHandler("tts", tts_command))
    application.add_handler(CommandHandler("clear", clear_command))
    application.add_handler(CommandHandler("trends", trends_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    application.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    application.add_handler(CallbackQueryHandler(button_callback))
    
    logger.info("🚀 Kristina Bot started with proactive messaging!")
    application.run_polling()

if __name__ == "__main__":
    main()
