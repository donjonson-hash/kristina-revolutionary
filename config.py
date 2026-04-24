# kristina_revolutionary/config.py
"""Загрузка конфигурации из .env"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Загружаем .env из директории проекта
ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)

class Config:
    # API Keys
    KIMI_API_KEY = os.getenv("KIMI_API_KEY")
    TELEGRAM_TOKEN = os.getenv("KRISTINA_TELEGRAM_TOKEN")
    _admin_raw = os.getenv("KRISTINA_ADMIN_IDS", "")
    ADMIN_IDS = []
    for x in _admin_raw.split(","):
        x = x.strip()
        if x:
            try:
                ADMIN_IDS.append(int(x))
            except ValueError:
                pass
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
    ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
    
    # CORS (список origins через запятую; пусто = localhost)
    _cors_raw = os.getenv("KRISTINA_CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000")
    CORS_ORIGINS = [x.strip() for x in _cors_raw.split(",") if x.strip()]

    # Paths
    DATA_DIR = Path(os.getenv("KRISTINA_DATA_DIR", "~/kristina_revolutionary")).expanduser()
    PROJECTS_DIR = Path(os.getenv("KRISTINA_PROJECTS_DIR", "~/Projects")).expanduser()
    
    # Database
    DATABASE_MODE = os.getenv("DATABASE_MODE", "sqlite").lower()
    DATABASE_URL = os.getenv("DATABASE_URL")
    
    # PostgreSQL settings (если не используется DATABASE_URL)
    POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
    POSTGRES_DB = os.getenv("POSTGRES_DB", "kristina_db")
    POSTGRES_USER = os.getenv("POSTGRES_USER", "kristina_user")
    POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")
    
    @classmethod
    def get_postgres_dsn(cls) -> str:
        """Build PostgreSQL DSN"""
        if cls.DATABASE_URL:
            return cls.DATABASE_URL
        return f"postgresql://{cls.POSTGRES_USER}:{cls.POSTGRES_PASSWORD}@{cls.POSTGRES_HOST}:{cls.POSTGRES_PORT}/{cls.POSTGRES_DB}"
    
    # Validation
    @classmethod
    def validate(cls):
        missing = []
        if not cls.KIMI_API_KEY:
            missing.append("KIMI_API_KEY")
        if not cls.TELEGRAM_TOKEN:
            missing.append("KRISTINA_TELEGRAM_TOKEN")
        if missing:
            raise ValueError(f"Missing required config: {', '.join(missing)}")
        return True