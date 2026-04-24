"""
PostgreSQL async manager для Kristina AI
"""

import os
import json
import logging
from typing import List, Dict, Optional, Any
from datetime import datetime
from contextlib import asynccontextmanager

try:
    import asyncpg
    POSTGRES_AVAILABLE = True
except ImportError:
    POSTGRES_AVAILABLE = False
    logging.warning("asyncpg не установлен. PostgreSQL недоступен.")

logger = logging.getLogger(__name__)


class PostgresManager:
    """
    Async PostgreSQL manager
    """
    
    def __init__(self, dsn: str = None):
        if not POSTGRES_AVAILABLE:
            raise ImportError("asyncpg not installed. Run: pip install asyncpg")
        
        self.dsn = dsn or os.getenv('DATABASE_URL') or self._build_dsn()
        self.pool: Optional[asyncpg.Pool] = None
        
    def _build_dsn(self) -> str:
        """Build DSN from env variables"""
        host = os.getenv('POSTGRES_HOST', 'localhost')
        port = os.getenv('POSTGRES_PORT', '5432')
        db = os.getenv('POSTGRES_DB', 'kristina_db')
        user = os.getenv('POSTGRES_USER', 'kristina_user')
        password = os.getenv('POSTGRES_PASSWORD', '')
        return f"postgresql://{user}:{password}@{host}:{port}/{db}"
    
    async def connect(self):
        """Create connection pool"""
        try:
            self.pool = await asyncpg.create_pool(
                self.dsn,
                min_size=5,
                max_size=20,
                command_timeout=60
            )
            logger.info("✅ PostgreSQL connected")
        except Exception as e:
            logger.error(f"❌ PostgreSQL connection error: {e}")
            raise
    
    async def disconnect(self):
        """Close pool"""
        if self.pool:
            await self.pool.close()
            logger.info("🔌 PostgreSQL disconnected")
    
    async def init_tables(self):
        """Initialize database tables"""
        async with self.pool.acquire() as conn:
            # Messages table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    session_id VARCHAR(50) NOT NULL,
                    role VARCHAR(20) NOT NULL,
                    content TEXT NOT NULL,
                    agent VARCHAR(50),
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    metadata JSONB DEFAULT '{}'
                )
            """)
            
            # Sessions table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id VARCHAR(50) PRIMARY KEY,
                    user_id BIGINT,
                    agent VARCHAR(50) DEFAULT 'kristina',
                    context JSONB DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Freelance projects
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS freelance_projects (
                    id SERIAL PRIMARY KEY,
                    project_id VARCHAR(100) UNIQUE NOT NULL,
                    client_id BIGINT NOT NULL,
                    title VARCHAR(255),
                    description TEXT,
                    status VARCHAR(50) DEFAULT 'draft',
                    budget_range VARCHAR(100),
                    timeline VARCHAR(100),
                    attachments JSONB DEFAULT '[]',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Dialog history
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS dialog_history (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    message TEXT NOT NULL,
                    response TEXT NOT NULL,
                    agent VARCHAR(50),
                    sentiment VARCHAR(50),
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Knowledge base
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS knowledge (
                    id SERIAL PRIMARY KEY,
                    category VARCHAR(100),
                    topic VARCHAR(255),
                    content TEXT NOT NULL,
                    source VARCHAR(255),
                    confidence FLOAT DEFAULT 1.0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Create indexes
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_dialog_user ON dialog_history(user_id)")
            
            logger.info("✅ PostgreSQL tables initialized")
    
    # ═══════════════════════════════════════════════════════════════
    # Messages
    # ═══════════════════════════════════════════════════════════════
    
    async def save_message(self, session_id: str, role: str, content: str, 
                          agent: str = None, metadata: dict = None) -> int:
        """Save message to database"""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO messages (session_id, role, content, agent, metadata)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
                """,
                session_id, role, content, agent, json.dumps(metadata or {})
            )
            return row['id']
    
    async def get_messages(self, session_id: str, limit: int = 50) -> List[Dict]:
        """Get messages for session"""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, role, content, agent, timestamp, metadata
                FROM messages
                WHERE session_id = $1
                ORDER BY timestamp DESC
                LIMIT $2
                """,
                session_id, limit
            )
            return [dict(row) for row in rows]
    
    # ═══════════════════════════════════════════════════════════════
    # Sessions
    # ═══════════════════════════════════════════════════════════════
    
    async def save_session(self, session_id: str, user_id: int = None, 
                          agent: str = 'kristina', context: dict = None):
        """Save or update session"""
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO sessions (id, user_id, agent, context, updated_at)
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
                    agent = EXCLUDED.agent,
                    context = EXCLUDED.context,
                    updated_at = CURRENT_TIMESTAMP
                """,
                session_id, user_id, agent, json.dumps(context or {})
            )
    
    async def get_session(self, session_id: str) -> Optional[Dict]:
        """Get session by ID"""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM sessions WHERE id = $1",
                session_id
            )
            return dict(row) if row else None
    
    # ═══════════════════════════════════════════════════════════════
    # Freelance
    # ═══════════════════════════════════════════════════════════════
    
    async def save_project(self, project_data: Dict) -> int:
        """Save freelance project"""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO freelance_projects 
                (project_id, client_id, title, description, status, budget_range, timeline, attachments)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (project_id) DO UPDATE SET
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    status = EXCLUDED.status,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
                """,
                project_data.get('project_id'),
                project_data.get('client_id'),
                project_data.get('title'),
                project_data.get('description'),
                project_data.get('status', 'draft'),
                project_data.get('budget_range'),
                project_data.get('timeline'),
                json.dumps(project_data.get('attachments', []))
            )
            return row['id']
    
    async def get_projects(self, client_id: int = None) -> List[Dict]:
        """Get freelance projects"""
        async with self.pool.acquire() as conn:
            if client_id:
                rows = await conn.fetch(
                    "SELECT * FROM freelance_projects WHERE client_id = $1 ORDER BY created_at DESC",
                    client_id
                )
            else:
                rows = await conn.fetch("SELECT * FROM freelance_projects ORDER BY created_at DESC")
            return [dict(row) for row in rows]
    
    # ═══════════════════════════════════════════════════════════════
    # Dialog History
    # ═══════════════════════════════════════════════════════════════
    
    async def save_dialog(self, user_id: int, message: str, response: str, 
                         agent: str = None, sentiment: str = None) -> int:
        """Save dialog entry"""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO dialog_history (user_id, message, response, agent, sentiment)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
                """,
                user_id, message, response, agent, sentiment
            )
            return row['id']
    
    async def get_dialog_history(self, user_id: int, limit: int = 100) -> List[Dict]:
        """Get dialog history for user"""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM dialog_history
                WHERE user_id = $1
                ORDER BY timestamp DESC
                LIMIT $2
                """,
                user_id, limit
            )
            return [dict(row) for row in rows]
    
    # ═══════════════════════════════════════════════════════════════
    # Knowledge
    # ═══════════════════════════════════════════════════════════════
    
    async def add_knowledge(self, category: str, topic: str, content: str, 
                           source: str = None, confidence: float = 1.0) -> int:
        """Add knowledge entry"""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO knowledge (category, topic, content, source, confidence)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
                """,
                category, topic, content, source, confidence
            )
            return row['id']
    
    async def search_knowledge(self, query: str, category: str = None, limit: int = 10) -> List[Dict]:
        """Search knowledge base"""
        async with self.pool.acquire() as conn:
            if category:
                rows = await conn.fetch(
                    """
                    SELECT * FROM knowledge
                    WHERE category = $1 AND (content ILIKE $2 OR topic ILIKE $2)
                    ORDER BY confidence DESC
                    LIMIT $3
                    """,
                    category, f"%{query}%", limit
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT * FROM knowledge
                    WHERE content ILIKE $1 OR topic ILIKE $1
                    ORDER BY confidence DESC
                    LIMIT $2
                    """,
                    f"%{query}%", limit
                )
            return [dict(row) for row in rows]
    
    # ═══════════════════════════════════════════════════════════════
    # Stats
    # ═══════════════════════════════════════════════════════════════
    
    async def get_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        async with self.pool.acquire() as conn:
            stats = {}
            
            tables = ['messages', 'sessions', 'freelance_projects', 'dialog_history', 'knowledge']
            for table in tables:
                count = await conn.fetchval(f"SELECT COUNT(*) FROM {table}")
                stats[table] = count
            
            return stats
