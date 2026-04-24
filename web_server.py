"""
Web Server for Kristina Control Panel v3.1
"""

from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import json
import asyncio
from datetime import datetime
from typing import List, Dict, Optional
import logging
import os
import subprocess

# Импорты из проекта
try:
    from agents.router import router
    from agents.kristina_persona import KristinaPersonaAgent
    from agents.kristina_advisor import KristinaAdvisorAgent
    from agents.kristina_creative import KristinaCreativeAgent
    from mood_engine import mood_engine
except ImportError as e:
    print(f"⚠️  Import warning: {e}")
    router = None
    mood_engine = None

app = FastAPI(title="Kristina Control Panel", version="3.1")

# STATIC FILES
BASE_DIR = Path(__file__).parent
static_path = BASE_DIR / "static"
templates_path = BASE_DIR / "templates"

app.mount("/static", StaticFiles(directory=str(static_path)), name="static")
templates = Jinja2Templates(directory=str(templates_path))

# Инициализация агентов
def init_web_agents():
    if router and not router.agents:
        try:
            router.register_agent(KristinaPersonaAgent(), is_default=True)
            router.register_agent(KristinaAdvisorAgent())
            router.register_agent(KristinaCreativeAgent())
            print(f"🎭 Web: Инициализировано агентов: {len(router.agents)}")
        except Exception as e:
            print(f"⚠️  Agent init error: {e}")

init_web_agents()

# Хранилища
web_chat_history: List[Dict] = []
MAX_CHAT_HISTORY = 100
connected_websockets: List[WebSocket] = []

# ==================== Pydantic Models ====================

class ChatRequest(BaseModel):
    message: str
    agent: str = "kristina"

class ChatResponse(BaseModel):
    response: str
    agent: str
    timestamp: str

# ==================== ROUTES ====================

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/status")
async def get_status():
    """Статус системы"""
    try:
        if mood_engine:
            if hasattr(mood_engine, 'get_current'):
                current_mood = mood_engine.get_current()
            elif hasattr(mood_engine, 'current'):
                current_mood = mood_engine.current
            else:
                current_mood = {
                    "emoji": getattr(mood_engine, 'emoji', '🌅'),
                    "label": getattr(mood_engine, 'label', 'Утреннее любопытство'),
                    "energy": getattr(mood_engine, 'energy', 65)
                }
        else:
            raise AttributeError("No mood_engine")
    except Exception as e:
        current_mood = {
            "emoji": "🌅",
            "label": "Утреннее любопытство",
            "energy": 65
        }
    
    return {
        "active_agent": "kristina",
        "mood": current_mood,
        "stats": {
            "web_messages": len(web_chat_history),
            "active_users": len(connected_websockets) + 1,
            "uptime": "00:00"
        }
    }

@app.post("/api/chat", response_model=ChatResponse)
async def post_chat_json(request: ChatRequest):
    """JSON endpoint для чата"""
    return await process_chat(request.message, request.agent)

@app.post("/api/chat/form")
async def post_chat_form(message: str = Form(...), agent: str = Form("kristina")):
    """Form endpoint для чата"""
    return await process_chat(message, agent)

async def process_chat(message: str, agent: str):
    """Общая логика обработки чата"""
    global web_chat_history
    
    msg_data = {
        "id": len(web_chat_history),
        "text": message,
        "sender": "user",
        "agent": agent,
        "time": datetime.now().isoformat()
    }
    web_chat_history.append(msg_data)
    
    response_text = ""
    if router:
        try:
            context = {"agent_id": agent, "source": "web"}
            response = await router.process(message, context)
            response_text = response.content if hasattr(response, 'content') else str(response)
        except Exception as e:
            print(f"Router error: {e}")
            response_text = f"Извини, произошла ошибка: {str(e)[:100]}"
    else:
        responses = {
            "kristina": f"Привет! Я Кристина. '{message[:50]}...' — интересно, расскажи подробнее? ✨",
            "advisor": f"Анализ: '{message[:50]}...' — рекомендую действовать последовательно. 🧠",
            "creative": f"О! '{message[:50]}...' — как свет в стокгольмском кафе. Вдохновляет... 🎨"
        }
        response_text = responses.get(agent, responses["kristina"])
    
    response_data = {
        "id": len(web_chat_history),
        "text": response_text,
        "sender": "kristina",
        "agent": agent,
        "time": datetime.now().isoformat()
    }
    web_chat_history.append(response_data)
    
    if len(web_chat_history) > MAX_CHAT_HISTORY:
        web_chat_history = web_chat_history[-MAX_CHAT_HISTORY:]
    
    return {
        "response": response_text, 
        "agent": agent,
        "timestamp": datetime.now().isoformat()
    }

# ✅ SYSTEM LOGS — с абсолютным путем к journalctl
@app.get("/api/logs")
async def get_logs(lines: int = 20):
    """Получить последние логи системы"""
    try:
        # Используем абсолютный путь
        result = subprocess.run(
            ["/bin/journalctl", "-u", "kristina", "-n", str(lines), "--no-pager", "-q"],
            capture_output=True, text=True, timeout=10
        )
        
        if result.returncode != 0:
            # Fallback — пробуем без пути
            result = subprocess.run(
                ["journalctl", "-u", "kristina", "-n", str(lines), "--no-pager", "-q"],
                capture_output=True, text=True, timeout=10, shell=False
            )
        
        logs_raw = result.stdout.strip().split('\n') if result.stdout else []
        
        # Парсим логи
        parsed_logs = []
        for line in logs_raw[-20:]:
            if not line.strip():
                continue
            
            # Определяем уровень
            level = "info"
            line_lower = line.lower()
            if "error" in line_lower or "failed" in line_lower or "traceback" in line_lower:
                level = "error"
            elif "warning" in line_lower or "warn" in line_lower:
                level = "warn"
            
            # Извлекаем время из строки лога (если есть)
            time_str = datetime.now().strftime("%H:%M:%S")
            if len(line) > 20 and ":" in line[11:20]:
                try:
                    time_str = line[11:19]  # HH:MM:SS из systemd лога
                except:
                    pass
            
            # Короткое сообщение (без timestamp systemd)
            message = line
            if "]: " in line:
                message = line.split("]: ", 1)[-1]
            elif ": " in line[20:]:
                message = line.split(": ", 1)[-1]
            
            parsed_logs.append({
                "time": time_str,
                "level": level,
                "source": "kristina",
                "message": message[:150]  # Ограничиваем длину
            })
        
        # Если логи пустые — показываем статус
        if not parsed_logs:
            parsed_logs = [{
                "time": datetime.now().strftime("%H:%M:%S"),
                "level": "info",
                "source": "system",
                "message": "Логи загружаются... Или сервис не активен."
            }]
        
        return {"logs": parsed_logs}
        
    except Exception as e:
        return {
            "logs": [{
                "time": datetime.now().strftime("%H:%M:%S"),
                "level": "error",
                "source": "system",
                "message": f"Ошибка загрузки логов: {str(e)[:100]}"
            }]
        }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_websockets.append(websocket)
    print(f"🔌 WebSocket connected. Total: {len(connected_websockets)}")
    
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            if msg.get("type") == "chat":
                response = await process_chat(msg.get("text", ""), msg.get("agent", "kristina"))
                await websocket.send_json({
                    "type": "message",
                    "data": response
                })
            elif msg.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                
    except WebSocketDisconnect:
        connected_websockets.remove(websocket)
    except Exception as e:
        print(f"❌ WebSocket error: {e}")
        if websocket in connected_websockets:
            connected_websockets.remove(websocket)

if __name__ == "__main__":
    import uvicorn
    print("🚀 Starting Kristina Control Panel v3.1")
    print("🌐 URL: http://195.245.112.66:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
