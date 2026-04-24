# === PROACTIVE MESSAGING INTEGRATION ===
# Вставить этот блок в начало bot.py после импортов

from proactive_messaging import ProactiveEngine, SCHEDULE
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

# Глобальные переменные
proactive_engine = None
scheduler = None


def setup_proactive(application, ai_client):
    """Настраивает proactive messaging"""
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
        logger.info(f"Scheduled proactive: {time_str} ({config['mood']})")
    
    scheduler.start()
    logger.info("Proactive scheduler started")


async def send_proactive(application):
    """Отправляет proactive сообщение"""
    global proactive_engine
    if not proactive_engine or not proactive_engine.should_send():
        return
    
    state = proactive_engine.get_current_state()
    if not state:
        return
    
    message = await proactive_engine.generate_message(state)
    
    for chat_id in list(proactive_engine.active_chat_ids):
        try:
            await application.bot.send_message(
                chat_id=chat_id,
                text=message
            )
            logger.info(f"Proactive sent to {chat_id}: {state['mood']}")
        except Exception as e:
            logger.error(f"Failed to send proactive to {chat_id}: {e}")


def mark_user_active(chat_id=None):
    """Отмечает активность пользователя"""
    global proactive_engine
    if proactive_engine:
        proactive_engine.mark_user_active(chat_id)
        if chat_id:
            proactive_engine.add_chat(chat_id)
