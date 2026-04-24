import os
import io
import tempfile
import logging
import asyncio
from typing import Optional, Union

logger = logging.getLogger(__name__)

try:
    from gtts import gTTS
    GTTS_AVAILABLE = True
except ImportError:
    GTTS_AVAILABLE = False


class VoiceSynthesizer:
    """Простой TTS через gTTS (быстрый, не грузит сервер)"""
    
    def __init__(self):
        self.primary = "gtts" if GTTS_AVAILABLE else "none"
        logger.info(f"🎙️ TTS: {self.primary}")
    
    async def synthesize(self, text: str, output_path: Optional[str] = None) -> Union[str, bytes]:
        """Синтез через gTTS"""
        if not GTTS_AVAILABLE:
            raise RuntimeError("gTTS не установлен: pip install gtts")
        
        if len(text) > 500:
            text = text[:497] + "..."
        
        def _generate():
            tts = gTTS(text=text, lang='ru')
            if output_path:
                tts.save(output_path)
                return output_path
            else:
                fp = io.BytesIO()
                tts.write_to_fp(fp)
                return fp.getvalue()
        
        return await asyncio.to_thread(_generate)
    
    def synthesize_to_file(self, text: str, speaker: str = "Kristina") -> str:
        """Синхронный интерфейс"""
        fd, path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        result = loop.run_until_complete(self.synthesize(text, path))
        return result if isinstance(result, str) else path
    
    async def synthesize_to_file_async(self, text: str, speaker: str = "Kristina") -> str:
        """Асинхронная версия для bot.py"""
        fd, path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        
        result = await self.synthesize(text, path)
        return result if isinstance(result, str) else path
    
    def cleanup(self, path: str):
        """Удаляем временный файл"""
        try:
            if os.path.exists(path):
                os.remove(path)
        except:
            pass
    
    def get_status(self) -> dict:
        return {
            "primary": self.primary,
            "gtts_available": GTTS_AVAILABLE,
            "silero_available": False
        }


# Singleton
_tts_instance = None

def get_tts():
    global _tts_instance
    if _tts_instance is None:
        _tts_instance = VoiceSynthesizer()
    return _tts_instance

# Экспортируем для bot.py
tts = get_tts()
