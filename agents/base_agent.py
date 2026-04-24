"""
Base Agent Class for Kristina Multi-Agent System
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


@dataclass
class AgentResponse:
    content: str
    agent_name: str
    confidence: float
    emotion: str
    suggested_actions: List[str]
    context_used: Dict[str, Any]


class BaseAgent(ABC):
    def __init__(self, name: str, description: str, system_prompt: str):
        self.name = name
        self.description = description
        self.system_prompt = system_prompt
        self.conversation_history: List[Dict] = []
        self.is_active = False
        self.activation_keywords = []
        
    @abstractmethod
    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        pass
    
    def should_activate(self, user_input: str) -> float:
        input_lower = user_input.lower()
        score = 0.0
        for keyword in self.activation_keywords:
            if keyword in input_lower:
                score += 0.3
        return min(score, 1.0)
    
    def add_to_history(self, role: str, content: str):
        self.conversation_history.append({
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
            "agent": self.name
        })
        if len(self.conversation_history) > 20:
            self.conversation_history = self.conversation_history[-20:]
    
    def get_history_prompt(self) -> str:
        if not self.conversation_history:
            return ""
        history_str = "\n📜 Недавняя история:\n"
        for msg in self.conversation_history[-5:]:
            history_str += f"{msg['role']}: {msg['content'][:100]}...\n"
        return history_str
    
    def activate(self):
        self.is_active = True
        logger.info(f"🎭 Агент {self.name} активирован")
    
    def deactivate(self):
        self.is_active = False
        logger.info(f"🎭 Агент {self.name} деактивирован")
