"""
Mobile API for Kristina AI Assistant v1.0
FastAPI + WebSocket + JWT + Brain Unified
"""

import os
import json
import asyncio
import uuid
import hashlib
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path
from logging.handlers import RotatingFileHandler

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, File, UploadFile, status, Request

# ═══════════════════════════════════════════════════════════════
# ЛОГИРОВАНИЕ
# ═══════════════════════════════════════════════════════════════
log_dir = Path(__file__).parent / "logs"
log_dir.mkdir(exist_ok=True)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Файловый handler с ротацией (10MB, 5 файлов)
file_handler = RotatingFileHandler(
    log_dir / "mobile_api.log",
    maxBytes=10*1024*1024,  # 10MB
    backupCount=5
)
file_handler.setLevel(logging.INFO)

# Консольный handler
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)

# Форматтер
formatter = logging.Formatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
file_handler.setFormatter(formatter)
console_handler.setFormatter(formatter)

# Добавляем handlers
logger.addHandler(file_handler)
logger.addHandler(console_handler)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from jose import JWTError, jwt
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Импорты проекта
from brain_unified import get_brain, BrainRegion
from document_processor import DocumentProcessor
from pricing_config import calculate_price, format_price_quote
from emotional_core import get_emotional_core

# ============ КОНФИГУРАЦИЯ ============
SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "JWT_SECRET_KEY not set! Generate with: openssl rand -hex 32"
    )
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

app = FastAPI(
    title="Kristina Mobile API",
    description="AI Assistant API for Mobile App",
    version="1.0.0"
)

# CORS для мобильного приложения (ограниченный список)
CORS_ORIGINS = [
    "https://t.me",
    "https://web.telegram.org",
    "http://localhost:8000",
    "http://localhost:3000",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)

# ============ RATE LIMITING ============
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request, exc):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please wait."}
    )

# ============ STATIC FILES (Mini App) ============
BASE_DIR = Path(__file__).parent
mini_app_path = BASE_DIR / "mini_app"

# Проверяем существование mini_app директории
if mini_app_path.exists():
    app.mount("/mini_app", StaticFiles(directory=str(mini_app_path), html=True), name="mini_app")
    print(f"✅ Mini App mounted at /mini_app")

# Security
security = HTTPBearer()

# ============ ХЕШИРОВАНИЕ (SHA256 вместо bcrypt) ============
def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def verify_password(password: str, hashed: str) -> bool:
    return hash_password(password) == hashed

# ============ МОДЕЛИ ДАННЫХ ============
class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=6)
    email: Optional[str] = None

class UserLogin(BaseModel):
    username: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    context: Optional[Dict[str, Any]] = None

class ChatResponse(BaseModel):
    response: str
    agent: str = "kristina"
    timestamp: str
    message_id: str
    confidence: float = 0.85

class ChatHistoryItem(BaseModel):
    id: str
    role: str
    content: str
    timestamp: str
    agent: Optional[str] = None

class PriceEstimateRequest(BaseModel):
    project_type: str
    complexity: str = "medium"
    region: str = "sweden"

class PriceEstimateResponse(BaseModel):
    price_range: tuple
    timeline: str
    includes: List[str]
    formatted_quote: str

class StatusResponse(BaseModel):
    status: str
    version: str
    agents_active: int
    mood: str
    energy: float
    timestamp: str

# ============ ХРАНИЛИЩЕ ============
class MemoryStore:
    def __init__(self):
        self.users: Dict[str, Dict] = {}
        self.messages: Dict[str, List[Dict]] = {}
        
    def get_user_messages(self, user_id: str, limit: int = 50):
        return self.messages.get(user_id, [])[-limit:]
    
    def add_message(self, user_id: str, role: str, content: str, agent: str = None):
        if user_id not in self.messages:
            self.messages[user_id] = []
        msg = {
            "id": str(uuid.uuid4()),
            "role": role,
            "content": content,
            "timestamp": datetime.utcnow().isoformat(),
            "agent": agent
        }
        self.messages[user_id].append(msg)
        return msg

store = MemoryStore()

# ============ JWT ============
def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None or username not in store.users:
            raise HTTPException(status_code=401, detail="Invalid authentication")
        return store.users[username]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

# ============ ИНИЦИАЛИЗАЦИЯ ============
brain = get_brain()
emotional_core = get_emotional_core()
doc_processor = DocumentProcessor()

# ============ API ============
@app.get("/")
async def root():
    # Если есть mini_app, редиректим на него
    if (mini_app_path / "index.html").exists():
        return FileResponse(str(mini_app_path / "index.html"))
    
    return {
        "name": "Kristina Mobile API",
        "version": "1.0.0",
        "status": "active",
        "endpoints": [
            "/auth/register", "/auth/login",
            "/chat", "/chat/history",
            "/ws/chat", "/price/estimate", "/status"
        ],
        "mini_app": "/mini_app/" if mini_app_path.exists() else None
    }

@app.get("/app")
async def serve_mini_app():
    """Serve Mini App HTML"""
    index_file = mini_app_path / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    raise HTTPException(status_code=404, detail="Mini App not found")

@app.get("/health")
async def health_check():
    """Health check endpoint для мониторинга"""
    try:
        # Проверка базы данных
        db_status = "ok" if brain else "error"
        
        # Проверка AI клиента
        ai_status = "ok" if os.getenv('DEEPSEEK_API_KEY') else "no_key"
        
        return {
            "status": "healthy",
            "timestamp": datetime.utcnow().isoformat(),
            "version": "1.0.0",
            "services": {
                "api": "ok",
                "database": db_status,
                "ai": ai_status
            }
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }

@app.post("/auth/register", response_model=Token)
@limiter.limit("5/minute")
async def register(user: UserCreate, request: Request):
    if user.username in store.users:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    hashed = hash_password(user.password)
    user_id = str(uuid.uuid4())
    
    store.users[user.username] = {
        "id": user_id,
        "username": user.username,
        "email": user.email,
        "hashed_password": hashed,
        "created_at": datetime.utcnow().isoformat()
    }
    
    token = create_access_token(data={"sub": user.username})
    return Token(access_token=token, expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60)

@app.post("/auth/login", response_model=Token)
@limiter.limit("10/minute")
async def login(user_data: UserLogin, request: Request):
    user = store.users.get(user_data.username)
    if not user or not verify_password(user_data.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    
    token = create_access_token(data={"sub": user_data.username})
    return Token(access_token=token, expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60)

@app.get("/status", response_model=StatusResponse)
async def get_status():
    brain_status = brain.get_status()
    emotional = brain_status.get("agents", {}).get("emotional", {})
    return StatusResponse(
        status="active",
        version="1.0.0",
        agents_active=brain_status.get("agents_count", 0),
        mood=emotional.get("mood", "спокойствие"),
        energy=emotional.get("energy", 0.7),
        timestamp=datetime.utcnow().isoformat()
    )

@app.post("/chat", response_model=ChatResponse)
@limiter.limit("30/minute")
async def chat(payload: ChatRequest, request: Request,
               current_user: dict = Depends(get_current_user)):
    # slowapi требует параметр request: Request; тело запроса — payload
    user_id = current_user["id"]
    store.add_message(user_id, "user", payload.message)

    try:
        language_agent = brain.agents.get(BrainRegion.LANGUAGE)
        if language_agent:
            response_text = await language_agent.generate(payload.message)
        else:
            response_text = "Извини, я сейчас занята... 🌸"
        
        msg = store.add_message(user_id, "assistant", response_text, agent="kristina")
        return ChatResponse(
            response=response_text,
            agent="kristina",
            timestamp=msg["timestamp"],
            message_id=msg["id"],
            confidence=0.85
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Brain error: {str(e)}")

@app.get("/chat/history", response_model=List[ChatHistoryItem])
async def get_history(limit: int = 50, current_user: dict = Depends(get_current_user)):
    messages = store.get_user_messages(current_user["id"], limit)
    return [ChatHistoryItem(**msg) for msg in messages]

@app.post("/price/estimate", response_model=PriceEstimateResponse)
async def estimate_price(request: PriceEstimateRequest):
    try:
        result = calculate_price(
            project_type=request.project_type,
            complexity=request.complexity,
            region=request.region
        )
        formatted = format_price_quote(result)
        return PriceEstimateResponse(
            price_range=result["price_range"],
            timeline=result["timeline"],
            includes=result["includes"],
            formatted_quote=formatted
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/upload")
async def upload_file(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    temp_path = f"/tmp/{uuid.uuid4()}_{file.filename}"
    try:
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        result = await doc_processor.process_document(temp_path)
        os.remove(temp_path)
        
        if result.get("success"):
            return {
                "success": True,
                "filename": file.filename,
                "text": result.get("text", ""),
                "format": result.get("format"),
                "stats": result.get("stats", {})
            }
        else:
            raise HTTPException(status_code=400, detail=result.get("error", "Processing failed"))
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=str(e))

# ============ WEBSOCKET ============
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
    
    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections[user_id] = websocket
    
    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]

manager = ConnectionManager()

@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket, token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username or username not in store.users:
            await websocket.close(code=4001, reason="Invalid token")
            return
        user = store.users[username]
    except JWTError:
        await websocket.close(code=4001, reason="Invalid token")
        return
    
    user_id = user["id"]
    await manager.connect(websocket, user_id)
    
    try:
        while True:
            data = await websocket.receive_json()
            message_text = data.get("message", "")
            if not message_text:
                continue
            
            store.add_message(user_id, "user", message_text)
            
            try:
                language_agent = brain.agents.get(BrainRegion.LANGUAGE)
                if language_agent:
                    response_text = await language_agent.generate(message_text)
                else:
                    response_text = "Извини, я сейчас занята... 🌸"
                
                msg = store.add_message(user_id, "assistant", response_text, agent="kristina")
                await websocket.send_json({
                    "type": "message",
                    "id": msg["id"],
                    "content": response_text,
                    "agent": "kristina",
                    "timestamp": msg["timestamp"]
                })
            except Exception as e:
                await websocket.send_json({"type": "error", "error": str(e)})
    except WebSocketDisconnect:
        manager.disconnect(user_id)
    except Exception as e:
        manager.disconnect(user_id)
        print(f"WebSocket error: {e}")



@app.get("/chat/direct")
@limiter.limit("30/minute")
async def chat_direct(request: Request, message: str = "Привет", user_id: str = "guest"):
    """Прямой чат через GET с подключением к Brain"""
    from datetime import datetime
    
    try:
        # Проверяем инициализацию brain
        if brain and hasattr(brain, 'agents') and BrainRegion.LANGUAGE in brain.agents:
            language_agent = brain.agents[BrainRegion.LANGUAGE]
            if language_agent:
                # Получаем эмоциональное состояние
                emotional_state = "нейтральное"
                energy = 0.7
                if emotional_core:
                    emo_data = emotional_core.get_emotional_state()
                    emotional_state = emo_data.get("mood_description", "нейтральное")
                    energy = emo_data.get("state", {}).get("energy", 0.7)
                    # Обновляем эмоциональное состояние
                    emotional_core.evolve({"user_message": message})
                
                # Генерируем ответ через Language Agent
                response_text = await language_agent.generate(
                    message,
                    context={
                        "user_id": user_id,
                        "platform": "web",
                        "mood": emotional_state,
                        "energy": energy,
                        "session_type": "direct_chat"
                    }
                )
                
                return {
                    "response": response_text,
                    "agent": "kristina",
                    "timestamp": datetime.now().isoformat(),
                    "message_id": "direct_" + str(hash(message + user_id))[-8:],
                    "confidence": 0.9,
                    "mood": emotional_state,
                    "energy": energy,
                    "source": "brain_language_agent"
                }
    except Exception as e:
        print(f"[chat_direct] Brain error: {e}")
    
    # Fallback
    return {
        "response": f"Привет! Я Кристина. Получила: '{message}' 🎨",
        "agent": "kristina",
        "timestamp": datetime.now().isoformat(),
        "message_id": "direct_" + str(hash(message + user_id))[-8:],
        "confidence": 0.5,
        "source": "fallback"
    }

@app.on_event("startup")
async def startup_event():
    """Запуск приложения"""
    logger.info("🚀 Starting Kristina Mobile API v1.0")
    logger.info(f"📱 CORS origins: {CORS_ORIGINS}")

@app.on_event("shutdown")
async def shutdown_event():
    """Корректное завершение работы"""
    logger.info("🛑 Shutting down gracefully...")
    try:
        # Закрываем соединения с БД
        if 'pg' in globals() and pg:
            await pg.disconnect()
            logger.info("🔌 Database disconnected")
    except Exception as e:
        logger.error(f"Error during shutdown: {e}")

if __name__ == "__main__":
    import uvicorn
    print("🚀 Starting Kristina Mobile API v1.0")
    print("📱 http://0.0.0.0:8001")
    uvicorn.run(app, host="0.0.0.0", port=8001)
