"""
Обработчик документов для Kristina Bot
"""
import os
import logging
from shared_context import user_context
from conversation_context import conversation_session_id, telegram_conversation
from persistent_memory import get_memory
from telegram import Update
from telegram.ext import ContextTypes

logger = logging.getLogger(__name__)

# Импортируем document_processor
try:
    from document_processor import get_document_processor
    DOCUMENT_PROCESSOR_AVAILABLE = True
except ImportError:
    DOCUMENT_PROCESSOR_AVAILABLE = False
    logger.warning("⚠️ document_processor not available")

# user_context будет импортирован из bot.py

async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработка входящих документов (PDF, DOCX, TXT)"""
    if not DOCUMENT_PROCESSOR_AVAILABLE:
        await update.message.reply_text("📄 Извини, обработка документов временно недоступна.")
        return
    
    user_id = update.effective_user.id
    session_id = conversation_session_id(telegram_conversation(update))
    document = update.message.document
    
    # Проверяем размер (20MB лимит Telegram)
    if document.file_size > 20 * 1024 * 1024:
        await update.message.reply_text("❌ Файл слишком большой. Максимум 20MB.")
        return
    
    # Скачиваем файл
    processing_msg = await update.message.reply_text("📥 Скачиваю документ...")
    
    try:
        file = await context.bot.get_file(document.file_id)
        file_path = f"/tmp/doc_{user_id}_{document.file_name}"
        await file.download_to_drive(file_path)
        
        await processing_msg.edit_text("🔍 Анализирую содержимое...")
        
        # Обрабатываем документ
        processor = get_document_processor()
        result = await processor.process_document(file_path, document.mime_type)
        
        if not result['success']:
            await processing_msg.edit_text(f"❌ Ошибка: {result['error']}")
            os.remove(file_path)
            return
        
        # Формируем ответ через AI как UX-дизайнер
        stats = result['stats']
        
        # Генерируем анализ документа через AI
        from ai_client import get_ai_client
        analysis_prompt = f"""Ты Кристина, UX-дизайнер из Стокгольма. Тебе прислали техническое задание/описание проекта.

Проанализируй документ как профессионал:
1. О чём проект? (кратко, 2-3 предложения)
2. Какие UX/UI проблемы видишь? (если есть описание интерфейса)
3. Возьмёшься ли за проект? Почему да/нет?
4. Что бы переделала/улучшила?
5. Примерная оценка стоимости (в евро или рублях) и сроки
6. Твои условия работы (предоплата, этапы, правки)

Документ ({stats.get('pages', 'N/A')} стр., {stats.get('words', 'N/A')} слов):
{result['text'][:3000]}

Отвечай от первого лица, как Кристина. Будь честной, профессиональной, немного дерзкой. ВАЖНО: максимум 3000 символов, кратко и по делу."""

        try:
            ai_client = get_ai_client()
            analysis = await ai_client.chat([{"role": "user", "content": analysis_prompt}], temperature=0.8, max_tokens=2500)
            await ai_client.close()
            kristina_response = analysis.strip()
        except Exception as e:
            logger.error(f"AI analysis error: {e}")
            kristina_response = "Извини, не смогла проанализировать документ. Давай обсудим устно?"
        
        response = f"""📄 **Документ получен:** `{document.file_name}`

📊 **Статистика:** {stats.get('pages', 'N/A')} стр., {stats.get('words', 'N/A')} слов

{kristina_response}

💡 Хочешь уточнить детали или обсудить условия?"""
        
        await processing_msg.edit_text(response)
        
        # Сохраняем в контекст для дальнейшей работы
        if session_id not in user_context:
            user_context[session_id] = {}
        user_context[session_id]['last_document'] = {
            'text': result['text'],
            'filename': document.file_name,
            'stats': stats
        }
        get_memory().save_exchange(
            session_id, f"[Документ: {document.file_name}]", response, channel="telegram",
        )
        
        # Удаляем временный файл
        os.remove(file_path)
        
    except Exception as e:
        logger.error(f"Document processing error: {e}")
        await processing_msg.edit_text("❌ Произошла ошибка при обработке документа.")
        if os.path.exists(file_path):
            os.remove(file_path)
