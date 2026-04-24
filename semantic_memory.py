"""
Семантическая память Кристины — Chroma DB
Хранит смыслы, ассоциации, эмоциональный контекст
"""

import chromadb
from chromadb.config import Settings
from typing import List, Dict, Optional
import hashlib
from datetime import datetime

class SemanticMemory:
    """Векторное хранилище смыслов диалогов"""
    
    def __init__(self, persist_dir: str = "./chroma_db"):
        self.client = chromadb.Client(Settings(
            chroma_db_impl="duckdb+parquet",
            persist_directory=persist_dir
        ))
        
        # Коллекции для разных типов памяти
        self.facts = self.client.get_or_create_collection("facts")
        self.topics = self.client.get_or_create_collection("topics")
        
    def add_fact(self, user_id: str, fact: str, category: str = "general"):
        """Добавить факт о пользователе"""
        fact_id = hashlib.md5(f"{user_id}:{fact}".encode()).hexdigest()[:16]
        
        try:
            self.facts.add(
                documents=[fact],
                metadatas=[{
                    "user_id": user_id,
                    "category": category,
                    "timestamp": datetime.now().isoformat()
                }],
                ids=[fact_id]
            )
            return True
        except Exception as e:
            print(f"Add fact error: {e}")
            return False
    
    def add_topic(self, user_id: str, topic: str, emotion: str = "neutral"):
        """Добавить тему разговора"""
        topic_id = hashlib.md5(f"{user_id}:{topic}:{datetime.now().date()}".encode()).hexdigest()[:16]
        
        try:
            self.topics.add(
                documents=[topic],
                metadatas=[{
                    "user_id": user_id,
                    "emotion": emotion,
                    "date": datetime.now().isoformat()
                }],
                ids=[topic_id]
            )
            return True
        except Exception as e:
            print(f"Add topic error: {e}")
            return False
    
    def get_relevant_context(self, user_id: str, query: str, n_results: int = 3) -> List[str]:
        """Получить релевантный контекст"""
        try:
            results = self.facts.query(
                query_texts=[query],
                where={"user_id": user_id},
                n_results=n_results
            )
            return results['documents'][0] if results and results['documents'] else []
        except Exception as e:
            return []
    
    def get_user_profile(self, user_id: str) -> Dict:
        """Получить профиль пользователя"""
        try:
            facts = self.facts.get(where={"user_id": user_id})
            return {
                "facts": facts['documents'][:5] if facts else [],
                "count": len(facts['documents']) if facts else 0
            }
        except:
            return {"facts": [], "count": 0}


# Глобальный инстанс
_semantic_memory = None

def get_semantic_memory():
    global _semantic_memory
    if _semantic_memory is None:
        _semantic_memory = SemanticMemory()
    return _semantic_memory
