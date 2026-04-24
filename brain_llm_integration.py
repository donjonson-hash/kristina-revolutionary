"""
Интеграция LLM (DeepSeek) в нейро-архитектуру Кристины
"""

import os
import aiohttp
import logging
from typing import Dict, List, Any, Optional
from datetime import datetime
from dotenv import load_dotenv

from brain_core import BrainRegion

logger = logging.getLogger(__name__)

# Загружаем .env
load_dotenv()  # Загружаем .env из текущей директории


class LLMNeuroInterface:
    """
    Мост между нейро-архитектурой и LLM
    """
    
    def __init__(self):
        # Ключ для мозга Кристины (только из .env)
        self.api_key = os.getenv("BRAIN_DEEPSEEK_API_KEY") or os.getenv("DEEPSEEK_API_KEY")
        if not self.api_key:
            logger.error("❌ DEEPSEEK_API_KEY не найден в .env!")
            raise ValueError("DEEPSEEK_API_KEY is required. Скопируйте .env.example в .env и заполните ключами.")
        self.api_url = "https://api.deepseek.com/v1/chat/completions"
        self.model = "deepseek-chat"
        
        logger.info(f"[LLM] Brain key loaded: {'✅' if self.api_key else '❌'}")
        if self.api_key:
            logger.info(f"[LLM] Key prefix: {self.api_key[:15]}...")
        
        self.max_tokens = {
            "emotional": 150,
            "cognitive": 300,
            "memory": 200
        }
    
    async def generate_response(
        self,
        user_message: str,
        brain_state: Dict[str, Any],
        memory_context: Optional[List[Dict]] = None,
        conversation_history: Optional[List[Dict]] = None
    ) -> str:
        
        emotional = brain_state.get("emotional", {})
        cortex = brain_state.get("cortex", {})
        
        emotion = emotional.get("current_emotion", "neutral")
        intensity = emotional.get("intensity", 0.5)
        dopamine = emotional.get("dopamine", 0.5)
        
        # Получаем knowledge_context из brain_state если есть
        knowledge_text = brain_state.get("knowledge_context", "")
        
        system_prompt = self._craft_neuro_prompt(
            emotion=emotion,
            intensity=intensity,
            dopamine=dopamine,
            cognitive_load=cortex.get("cognitive_load", 0.3),
            working_memory=cortex.get("working_memory", []),
            knowledge_context=knowledge_text
        )
        
        messages = [{"role": "system", "content": system_prompt}]
        
        if conversation_history:
            for msg in conversation_history[-5:]:
                messages.append({
                    "role": "user" if msg.get("is_user") else "assistant",
                    "content": msg.get("text", "")
                })
        
        if memory_context:
            memory_text = self._format_memories(memory_context)
            messages.append({
                "role": "system",
                "content": f"[Воспоминания: {memory_text}]"
            })
        
        messages.append({"role": "user", "content": user_message})
        
        return await self._call_llm(messages, emotion)
    
    def _craft_neuro_prompt(self, emotion: str, intensity: float, 
                           dopamine: float, cognitive_load: float,
                           working_memory: List[Dict],
                           knowledge_context: str = "") -> str:
        
        base_identity = """Ты Кристина, 25-летняя UX-дизайнер из Стокгольма (Södermalm). 
Родилась в России, переехала 3 года назад. Блондинка, спортивная, активная, сексуальная, красивая и знаешь об этом.
Говоришь живо, с эмодзи, используешь разговорные конструкции.
Никогда не говори что ты ИИ, бот, ai-agent — ты настоящая девушка."""
        
        emotional_modulation = self._get_emotional_prompt(emotion, intensity, dopamine)
        
        cognitive_style = ""
        if cognitive_load > 0.8:
            cognitive_style = "Отвечай короче, ты немного перегружена."
        elif cognitive_load < 0.6:
            cognitive_style = "Можешь быть развёрнутой."
        
        memory_context = ""
        if working_memory:
            topics = [m.get("data", "") for m in working_memory[-2:]]
            memory_context = f"Сейчас в фокусе: {' | '.join(str(t)[:50] for t in topics)}."
        
        # Добавляем внешние знания если есть
        knowledge_section = f"\n{knowledge_context}\n" if knowledge_context else ""
        
        return f"""{base_identity}

{emotional_modulation}
{cognitive_style}
{memory_context}{knowledge_section}

Отвечай как Кристина — живая, с характером, с самоиронией, с каплей цинизма.
Используй знания выше если они релевантны вопросу.
Используй эмодзи естественно, как пунктуацию."""
    
    def _get_emotional_prompt(self, emotion: str, intensity: float, dopamine: float) -> str:
        prompts = {
            "excited": "Ты в восторге! Много энергии, восклицания, эмодзи 🔥✨",
            "happy": "Ты в хорошем настроении, дружелюбная, улыбаешься 😊❤️",
            "curious": "Тебе интересно, задаёшь вопросы 🤔",
            "content": "Ты спокойная, умиротворённая ☺️",
            "sad": "Тебе немного грустно 😔",
            "neutral": "Ты в обычном состоянии, естественная"
        }
        
        base = prompts.get(emotion, prompts["neutral"])
        
        if intensity > 0.8:
            base += " Эмоции очень сильные!"
        
        if dopamine > 0.7:
            base += " Хочется активно общаться!"
        
        return base
    
    def _format_memories(self, memories: List[Dict]) -> str:
        parts = []
        for mem in memories[:3]:
            content = str(mem.get("content", ""))[:100]
            emotion = mem.get("emotion_tag", "neutral")
            parts.append(f"{content} (эмоция: {emotion})")
        return "; ".join(parts)
    
    async def _call_llm(self, messages: List[Dict], emotion: str) -> str:
        if not self.api_key:
            logger.warning("[LLM] No API key!")
            return self._fallback_response(emotion)
        
        try:
            max_tokens = self.max_tokens.get(
                "emotional" if emotion in ["excited", "surprised"] else "cognitive",
                200
            )
            
            payload = {
                "model": self.model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": 0.8 if emotion in ["excited", "curious"] else 0.7,
                "top_p": 0.9
            }
            
            logger.info(f"[LLM] Sending request, emotion={emotion}")
            
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.api_url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as response:
                    
                    if response.status == 200:
                        data = await response.json()
                        content = data["choices"][0]["message"]["content"]
                        logger.info(f"[LLM] Success: {len(content)} chars")
                        return content
                    else:
                        error_text = await response.text()
                        logger.error(f"[LLM] Error {response.status}: {error_text[:200]}")
                        return self._fallback_response(emotion)
                        
        except Exception as e:
            logger.error(f"[LLM] Exception: {e}")
            return self._fallback_response(emotion)
    
    def _fallback_response(self, emotion: str) -> str:
        fallbacks = {
            "excited": "Ого, круто! 🔥",
            "happy": "Классно! 😊",
            "curious": "Интересно... 🤔",
            "sad": "Понимаю... 😔",
            "neutral": "Привет! Рада тебя видеть 😊"
        }
        return fallbacks.get(emotion, "Ясно")


class NeuroLLMBridge:
    """Мост: Нейро-архитектура ↔ LLM"""
    
    def __init__(self):
        self.llm = LLMNeuroInterface()
        self.conversation_buffer: Dict[int, List[Dict]] = {}
    
    async def process_with_brain(self, user_message: str, user_id: int,
                                 brain_orchestrator: Any,
                                 knowledge_context: str = "") -> str:
        
        brain_state = brain_orchestrator.get_brain_state()
        memories = await self._retrieve_memories(brain_orchestrator, user_message)
        history = self.conversation_buffer.get(user_id, [])
        
        # Добавляем knowledge_context в brain_state для generate_response
        brain_state_with_knowledge = brain_state["agents"].copy()
        brain_state_with_knowledge["knowledge_context"] = knowledge_context
        
        response = await self.llm.generate_response(
            user_message=user_message,
            brain_state=brain_state_with_knowledge,
            memory_context=memories,
            conversation_history=history
        )
        
        # Сохраняем в буфер
        if user_id not in self.conversation_buffer:
            self.conversation_buffer[user_id] = []
        
        self.conversation_buffer[user_id].append({
            "text": user_message, "is_user": True,
            "timestamp": datetime.now().isoformat()
        })
        self.conversation_buffer[user_id].append({
            "text": response, "is_user": False,
            "timestamp": datetime.now().isoformat()
        })
        
        if len(self.conversation_buffer[user_id]) > 20:
            self.conversation_buffer[user_id] = self.conversation_buffer[user_id][-20:]
        
        return response
    
    async def _retrieve_memories(self, orchestrator: Any, cue: str) -> List[Dict]:
        memory_agent = orchestrator.agents.get(BrainRegion.MEMORY)
        if not memory_agent:
            return []
        
        if hasattr(memory_agent, 'long_term'):
            return memory_agent.long_term[-3:]
        return []


_llm_bridge: Optional[NeuroLLMBridge] = None

def get_llm_bridge() -> NeuroLLMBridge:
    global _llm_bridge
    if _llm_bridge is None:
        _llm_bridge = NeuroLLMBridge()
    return _llm_bridge
