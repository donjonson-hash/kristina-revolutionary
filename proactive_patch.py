"""
Интеграция proactive messaging в bot.py
Добавить импорты и вызовы в основной файл бота
"""

# === КОД ДЛЯ ДОБАВЛЕНИЯ В bot.py ===

IMPORTS = """
# === PROACTIVE MESSAGING ===
from proactive_messaging import ProactiveEngine, SCHEDULE
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

# Глобальные переменные
proactive_engine = None
scheduler = None
"""

SETUP_FUNCTION = """
def setup_proactive(application, ai_client):
    global proactive_engine, scheduler
    
    proactive_engine = ProactiveEngine(ai_client)
    scheduler = AsyncIOScheduler()
    
    for time_str, config in SCHEDULE.items():
        hour, minute = map(int, time_str.split(":"))
        scheduler.add_job(
            send_proactive,
            trigger=CronTrigger(hour=hour, minute=minute),
            args=[application],
            id=f"proactive_{time_str}",
            replace_existing=True,
            misfire_grace_time=300
        )
        logger.info(f"Scheduled: {time_str} ({config['mood']})")
    
    scheduler.start()
    logger.info("Proactive scheduler started")

async def send_proactive(application):
    global proactive_engine
    if not proactive_engine or not proactive_engine.should_send():
        return
    
    state = proactive_engine.get_current_state()
    if not state:
        return
    
    message = await proactive_engine.generate_message(state)
    
    for chat_id in proactive_engine.active_chat_ids:
        try:
            await application.bot.send_message(
                chat_id=chat_id,
                text=message,
                parse_mode="HTML"
            )
            logger.info(f"Proactive sent to {chat_id}: {state['mood']}")
        except Exception as e:
            logger.error(f"Failed to send to {chat_id}: {e}")

def mark_user_active(chat_id=None):
    global proactive_engine
    if proactive_engine:
        proactive_engine.mark_user_active(chat_id)
"""

# === ИНСТРУКЦИЯ ===
"""
1. Добавить импорты в начало bot.py (после существующих импортов)
2. Добавить setup_proactive и send_proactive в bot.py
3. В main() добавить: setup_proactive(application, ai_client)
4. В start() добавить: mark_user_active(update.effective_chat.id)
5. В handle_message() добавить: mark_user_active(update.effective_chat.id)
6. В start() добавить: proactive_engine.add_chat(update.effective_chat.id)
"""
