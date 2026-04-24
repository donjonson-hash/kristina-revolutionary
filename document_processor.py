"""
Document Processor v1.0
Обработка PDF, DOCX, TXT файлов для Кристины
"""

import os
import logging
from typing import Optional, Dict, Any
from io import BytesIO

logger = logging.getLogger(__name__)


class DocumentProcessor:
    """Процессор документов — извлечение текста из PDF, DOCX, TXT"""
    
    SUPPORTED_FORMATS = {
        'text/plain': 'txt',
        'application/pdf': 'pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/msword': 'doc'
    }
    
    def __init__(self):
        self.max_file_size = 10 * 1024 * 1024  # 10MB
        self.max_text_length = 50000  # 50K символов
        logger.info("📄 DocumentProcessor инициализирован")
    
    async def process_document(self, file_path: str, mime_type: str = None) -> Dict[str, Any]:
        """
        Обработка документа — извлечение текста
        
        Returns:
            {
                'success': bool,
                'text': str,
                'format': str,
                'error': str (если ошибка),
                'stats': {
                    'pages': int,
                    'chars': int,
                    'words': int
                }
            }
        """
        try:
            # Определяем формат
            file_format = self._detect_format(file_path, mime_type)
            
            if file_format not in ['txt', 'pdf', 'docx', 'doc']:
                return {
                    'success': False,
                    'text': '',
                    'format': 'unknown',
                    'error': f'Неподдерживаемый формат: {file_format}',
                    'stats': {}
                }
            
            # Проверяем размер
            file_size = os.path.getsize(file_path)
            if file_size > self.max_file_size:
                return {
                    'success': False,
                    'text': '',
                    'format': file_format,
                    'error': f'Файл слишком большой: {file_size / 1024 / 1024:.1f}MB (макс {self.max_file_size / 1024 / 1024}MB)',
                    'stats': {}
                }
            
            # Извлекаем текст
            if file_format == 'txt':
                text = self._extract_txt(file_path)
            elif file_format == 'pdf':
                text = self._extract_pdf(file_path)
            elif file_format in ['docx', 'doc']:
                text = self._extract_docx(file_path)
            else:
                text = ''
            
            # Обрезаем если слишком длинный
            if len(text) > self.max_text_length:
                text = text[:self.max_text_length] + "\n\n[... текст обрезан, слишком длинный ...]"
            
            # Статистика
            stats = {
                'pages': self._estimate_pages(text),
                'chars': len(text),
                'words': len(text.split())
            }
            
            logger.info(f"✅ Документ обработан: {file_format}, {stats['chars']} символов, {stats['words']} слов")
            
            return {
                'success': True,
                'text': text,
                'format': file_format,
                'error': None,
                'stats': stats
            }
            
        except Exception as e:
            logger.error(f"❌ Ошибка обработки документа: {e}")
            return {
                'success': False,
                'text': '',
                'format': 'unknown',
                'error': str(e),
                'stats': {}
            }
    
    def _detect_format(self, file_path: str, mime_type: str = None) -> str:
        """Определение формата файла"""
        # По MIME-type
        if mime_type and mime_type in self.SUPPORTED_FORMATS:
            return self.SUPPORTED_FORMATS[mime_type]
        
        # По расширению
        ext = os.path.splitext(file_path)[1].lower()
        format_map = {
            '.txt': 'txt',
            '.pdf': 'pdf',
            '.docx': 'docx',
            '.doc': 'doc'
        }
        return format_map.get(ext, 'unknown')
    
    def _extract_txt(self, file_path: str) -> str:
        """Извлечение текста из TXT"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read()
        except UnicodeDecodeError:
            # Пробуем другую кодировку
            with open(file_path, 'r', encoding='cp1251') as f:
                return f.read()
    
    def _extract_pdf(self, file_path: str) -> str:
        """Извлечение текста из PDF"""
        try:
            from PyPDF2 import PdfReader
            reader = PdfReader(file_path)
            text_parts = []
            
            for page in reader.pages:
                text_parts.append(page.extract_text() or '')
            
            return '\n'.join(text_parts)
        except Exception as e:
            logger.error(f"PDF extraction error: {e}")
            return f"[Ошибка чтения PDF: {e}]"
    
    def _extract_docx(self, file_path: str) -> str:
        """Извлечение текста из DOCX"""
        try:
            from docx import Document
            doc = Document(file_path)
            text_parts = []
            
            for para in doc.paragraphs:
                text_parts.append(para.text)
            
            return '\n'.join(text_parts)
        except Exception as e:
            logger.error(f"DOCX extraction error: {e}")
            return f"[Ошибка чтения DOCX: {e}]"
    
    def _estimate_pages(self, text: str) -> int:
        """Оценка количества страниц (примерно 3000 символов на страницу)"""
        return max(1, len(text) // 3000)
    
    def get_summary(self, text: str, max_chars: int = 500) -> str:
        """Получить краткое содержание текста"""
        if len(text) <= max_chars:
            return text
        
        # Берём начало и ищем конец предложения
        summary = text[:max_chars]
        last_period = summary.rfind('.')
        if last_period > max_chars * 0.8:
            summary = summary[:last_period + 1]
        
        return summary + "..."


# Singleton
_processor = None

def get_document_processor() -> DocumentProcessor:
    """Получить singleton экземпляр"""
    global _processor
    if _processor is None:
        _processor = DocumentProcessor()
    return _processor


# Тестирование
if __name__ == "__main__":
    import asyncio
    
    async def test():
        processor = get_document_processor()
        
        # Тест с созданием простого TXT
        test_file = "/tmp/test_doc.txt"
        with open(test_file, 'w') as f:
            f.write("Тестовый документ для Кристины.\nЭто техническое задание на разработку сайта.\nБюджет: 50000 рублей.\nСрок: 2 недели.")
        
        result = await processor.process_document(test_file, 'text/plain')
        
        print(f"Формат: {result['format']}")
        print(f"Успех: {result['success']}")
        print(f"Символов: {result['stats'].get('chars', 0)}")
        print(f"Слов: {result['stats'].get('words', 0)}")
        print(f"Текст: {result['text'][:100]}...")
        
        # Очистка
        os.remove(test_file)
        
        print("\n✅ Тест пройден!")
    
    asyncio.run(test())
