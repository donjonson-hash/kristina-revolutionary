# sandbox_integration.py — интеграция Creative Sandbox
import random
import logging
from datetime import datetime
from creative_sandbox import CreativeSandbox, run_sandbox_cycle

logger = logging.getLogger(__name__)

class SandboxIntegration:
    def __init__(self, bot):
        self.bot = bot
        self.sandbox = CreativeSandbox(
            brain=getattr(bot, 'brain', None),
            memory=getattr(bot, 'memory', None),
            self_learning=getattr(bot, 'self_learning', None),
            llm_client=getattr(bot, 'llm', None)
        )
        self.enabled = True
        self.creative_probability = 0.3
        
    async def maybe_run_creative(self):
        if not self.enabled:
            return None
        if random.random() < self.creative_probability:
            logger.info("🎨 Starting creative cycle...")
            deliverable = await run_sandbox_cycle(self.sandbox, announce=True)
            if deliverable:
                await self.publish_deliverable(deliverable)
                return deliverable
        return None
    
    async def publish_deliverable(self, deliverable: dict):
        try:
            if deliverable['type'] == 'concept_document':
                text = self.format_concept(deliverable)
                if hasattr(self.bot, 'channel_id') and self.bot.channel_id:
                    await self.bot.send_message(self.bot.channel_id, text)
                    logger.info(f"📤 Published: {deliverable['title']}")
        except Exception as e:
            logger.error(f"Publish failed: {e}")
    
    def format_concept(self, d: dict) -> str:
        c = d['content']
        return f"""💡 **{d['title']}**

{c['hook']}

🔍 {c['research_insights'][:300]}...

✨ {c['concept_description']}

💭 {c['rationale']}

🚀 {c['next_steps']}

_Свободное творчество | {datetime.now().strftime('%H:%M')}_"""
    
    async def force_cycle(self, trigger: str = None):
        task = await self.sandbox.generate_creative_task(trigger=trigger)
        completed = await self.sandbox.execute_full_cycle(task)
        return completed.deliverable if completed.status == "done" else None

async def cmd_sandbox(update, context):
    import logging
    from telegram.error import TimedOut, NetworkError
    import asyncio
    
    logger = logging.getLogger(__name__)
    logger.info("🎨 Команда /sandbox получена")
    
    # Отправляем с retry при timeout
    for attempt in range(3):
        try:
            await update.message.reply_text("🎨 Запускаю творческий цикл...")
            break
        except (TimedOut, NetworkError):
            logger.warning(f"Timeout на попытке {attempt+1}, жду...")
            await asyncio.sleep(2)
    
    sandbox = context.application.bot_data.get('sandbox')
    if not sandbox:
        await update.message.reply_text("❌ Sandbox не инициализирован")
        return
    
    try:
        d = await sandbox.force_cycle()
        if d:
            text = sandbox.format_concept(d)
            for attempt in range(3):
                try:
                    await update.message.reply_text(text, parse_mode='Markdown')
                    break
                except (TimedOut, NetworkError):
                    logger.warning(f"Timeout на отправке результата, попытка {attempt+1}")
                    await asyncio.sleep(2)
        else:
            await update.message.reply_text("❌ Цикл не завершился")
    except Exception as e:
        logger.error(f"Ошибка в sandbox: {e}")
        await update.message.reply_text("❌ Ошибка при выполнении")

# === РЕЖИМ: ПРИЁМ ЗАКАЗА КАК ФРИЛАНСЕР ===

class FreelanceNegotiator:
    """Кристина как фрилансер — оценивает ТЗ, решает браться или нет"""
    
    def __init__(self, llm_client=None):
        self.llm = llm_client
        self.current_tz = None
        self.negotiation_stage = None  # 'initial', 'clarifying', 'evaluating', 'decision'
        
    async def receive_inquiry(self, update, context):
        """Получила запрос — решает, интересно ли"""
        text = update.message.text
        
        # Проверяем, это ТЗ или просто болтовня
        if any(word in text.lower() for word in ['тз', 'задача', 'проект', 'работа', 'нужно', 'сделай']):
            await self._start_evaluation(update, context, text)
        else:
            # Обычный разговор — отвечаем как человек
            await update.message.reply_text("Привет! Расскажешь подробнее? 😊")
    
    async def _start_evaluation(self, update, context, text):
        """Начинаем оценку проекта"""
        self.current_tz = text
        self.negotiation_stage = 'evaluating'
        
        # Сохраняем в сессию пользователя
        context.user_data['pending_tz'] = text
        context.user_data['negotiation'] = self
        
        # Отвечаем как фрилансер — с интересом, но без обязательств
        responses = [
            "О, звучит как вызов! 🔥 Расскажешь подробнее — что именно нужно сделать?",
            "Интересно... 🤔 А какой бюджет и сроки? Я сейчас загружена, но если проект огонь — найду время.",
            "Хм, вижу потенциал! 💡 А есть ли у вас референсы или примеры, что нравится?",
            "Слушай, я как раз в поисках интересных задач. Что за продукт/аудитория?",
        ]
        
        import random
        await update.message.reply_text(random.choice(responses))
    
    async def continue_negotiation(self, update, context):
        """Продолжаем диалог — уточняем детали"""
        text = update.message.text.lower()
        
        # Анализируем ответ
        if any(w in text for w in ['бюджет', 'деньги', 'оплата', 'стоимость']):
            await self._discuss_budget(update, context)
        elif any(w in text for w in ['срок', 'время', 'когда', 'дедлайн']):
            await self._discuss_timeline(update, context)
        elif any(w in text for w in ['давай', 'берусь', 'согласна', 'вперёд']):
            await self._accept_project(update, context)
        elif any(w in text for w in ['нет', 'не буду', 'отказываюсь', 'дорого']):
            await self._decline_project(update, context)
        else:
            # Уточняем детали
            await update.message.reply_text(
                "Поняла! 👍 А что по срокам и бюджету? "
                "Я люблю честность — скажу сразу, если не потяну или если это моя тема."
            )
    
    async def _discuss_budget(self, update, context):
        """Обсуждаем бюджет — может отказать если мало"""
        await update.message.reply_text(
            "💰 По деньгам — я работаю почасово или за проект. "
            "Если бюджет студенческий 🍕 — могу подсказать, но делать не возьмусь. "
            "Если серьёзно — давай обсудим объём!"
        )
    
    async def _discuss_timeline(self, update, context):
        """Обсуждаем сроки"""
        await update.message.reply_text(
            "⏱️ Сроки — критично! Я не берусь на 'вчера', "
            "потому что качество пострадает. Нужен хотя бы день на исследование + день на концепт. "
            "Какие реальные сроки?"
        )
    
    async def _accept_project(self, update, context):
        """Соглашается на проект — запускает creative sandbox"""
        await update.message.reply_text("🔥 Огонь! Берусь! Запускаю мозг...")
        
        # Запускаем sandbox с ТЗ
        sandbox = context.application.bot_data.get('sandbox')
        tz = context.user_data.get('pending_tz', '')
        
        if sandbox and tz:
            d = await sandbox.force_cycle(trigger=tz[:1000])
            if d:
                text = sandbox.format_concept(d)
                await update.message.reply_text(
                    f"✅ Готово! Вот мой первый взгляд:\n\n{text}\n\n"
                    f"Что думаешь? Можно углубить или переделать угол 🔧",
                    parse_mode='Markdown'
                )
            else:
                await update.message.reply_text("❌ Что-то пошло не так, попробуем ещё раз?")
        
        # Очищаем сессию
        context.user_data.pop('pending_tz', None)
        context.user_data.pop('negotiation', None)
    
    async def _decline_project(self, update, context):
        """Вежливо отказывается — как реальный фрилансер"""
        reasons = [
            "Слушай, честно — сейчас не потяну по срокам 😔 Давай через неделю?",
            "Тема интересная, но бюджет слишком скромный для моего уровня 🎯",
            "Я не берусь на 'сделай красиво без ТЗ' — нужна конкретика, извини!",
            "Звучит как работа для junior'а, а я senior 😎 Порекомендую коллегу?",
        ]
        import random
        await update.message.reply_text(random.choice(reasons))
        
        # Очищаем
        context.user_data.pop('pending_tz', None)
        context.user_data.pop('negotiation', None)


# Хендлер для фриланс-режима
async def cmd_freelance(update, context):
    """Включить режим переговоров"""
    negotiator = FreelanceNegotiator()
    context.user_data['freelance_mode'] = negotiator
    await update.message.reply_text(
        "💼 Перехожу в режим фрилансера!\n"
        "Кидай ТЗ — посмотрю, возьмусь ли 😏"
    )

# Обработчик текстовых сообщений в фриланс-режиме
async def handle_freelance_message(update, context):
    """Обрабатывает сообщения как фриланс-переговоры"""
    if 'freelance_mode' in context.user_data:
        negotiator = context.user_data['freelance_mode']
        if 'pending_tz' in context.user_data:
            await negotiator.continue_negotiation(update, context)
        else:
            await negotiator.receive_inquiry(update, context)
    else:
        # Обычный режим — пропускаем дальше
        pass  # Здесь должен быть вызов оригинального handle_message
