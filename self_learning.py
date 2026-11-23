"""
Self-Learning Module — двухконтурное самообучение Кристины:
1. Субсимвольное синаптическое обучение (kristina-brain-core v1.1.0, 0 токенов LLM):
   - Дневные реакции зажигают спайки сенсорных нейронов и след пригодности (eligibility_trace).
   - Ночная консолидация (SleepConsolidationWorker) обновляет веса синапсов по правилу Хебба,
     сдвигает baseline 12 мод и формирует семя сна (DreamSeed) для писательского блокнота.
2. Внешнее любопытство (Perplexity API, опционально при наличии PERPLEXITY_API_KEY):
   - Фоновые заметки о документальной прозе, эссеистике, культуре и жизни Стокгольма.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp
from dotenv import load_dotenv

from kristina_brain import Appraisal, AsyncSQLiteStateStore, BrainEngine

load_dotenv()

logger = logging.getLogger(__name__)

REACTION_STIMULI_MAP: Dict[str, Dict[str, float]] = {
    "warmth": {"sensor_warmth": 1.0, "sensor_curiosity": 0.35},
    "curiosity": {"sensor_curiosity": 1.0, "sensor_warmth": 0.25},
    "concern": {"sensor_tension": 0.65, "sensor_warmth": 0.30},
    "frustration": {"sensor_tension": 0.95, "sensor_fatigue": 0.45},
    "neutral": {"sensor_curiosity": 0.25},
}


class PerplexityAPI:
    """Клиент для Perplexity API (опциональный внешний поиск тем)."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("PERPLEXITY_API_KEY")
        self.base_url = "https://api.perplexity.ai"
        if not self.api_key:
            logger.debug("PERPLEXITY_API_KEY не задан — активен внутренний синаптический контур обучения.")

    async def query(self, question: str, max_tokens: int = 500) -> Dict[str, Any]:
        if not self.api_key:
            return {"error": "No API key", "content": ""}

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        data = {
            "model": "sonar",
            "messages": [
                {
                    "role": "system",
                    "content": "Ты помощник писателя-документалиста, даёшь точную фактуру без воды.",
                },
                {"role": "user", "content": question},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.7,
        }

        try:
            timeout = aiohttp.ClientTimeout(total=30)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json=data,
                ) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error("Perplexity API error: %s", response.status)
                        return {"error": error_text, "content": ""}
                    result = await response.json()
                    content = result["choices"][0]["message"]["content"]
                    return {
                        "content": content,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "query": question,
                    }
        except Exception as e:
            logger.error("Perplexity request failed: %s", e)
            return {"error": str(e), "content": ""}

    def _parse_response(self, data: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "content": data.get("content", ""),
            "timestamp": data.get("timestamp", datetime.now(timezone.utc).isoformat()),
            "sources": data.get("citations", []),
        }


class SelfLearningAgent:
    """Двухконтурный агент самообучения Кристины (синапсы + писательская эрудиция)."""

    WRITER_TOPICS: Dict[str, str] = {
        "stockholm_weather": "Какая погода в Стокгольме сегодня и как меняется свет в городе?",
        "stockholm_events": "Независимые книжные события, выставки и камерные концерты в Стокгольме сейчас",
        "literary_nonfiction": "Современная документальная проза, тревел-эссеистика и путевые дневники — заметные книги и авторы",
        "travel_essay_craft": "Приёмы художественного репортажа и путевого очерка: работа с деталью, ритмом и диалогом",
        "sweden_culture": "Повседневная культура Швеции, городские привычки и ирония — свежие наблюдения",
        "scandinavian_design": "Скандинавская повседневная среда, свет и архитектура общественных пространств",
        "ai_technology": "Как технологии и ИИ меняют чтение, журналистику и человеческую память",
        "nordic_cuisine": "Маленькие пекарни, кофейни и локальная гастрономия Стокгольма",
        "stockholm_nightlife": "Вечерний Сёдермальм: камерные бары, разговоры и ночной транспорт",
        "swedish_history": "Малоизвестные истории районов Стокгольма и старых маршрутов",
        "modern_architecture": "Современная городская среда Скандинавии глазами пешехода",
        "wellness_trends": "Бег в городе, восстановление в северном климате и работа с вниманием",
        "swedish_nature": "Архипелаг Стокгольма, тропы у воды и смена сезонов в Швеции",
        "stockholm_food": "Кофейная культура fika и места в Стокгольме, куда ходят местные",
    }

    def __init__(
        self,
        db_path: str = "kristina_knowledge.db",
        brain_db_path: Optional[str] = None,
    ):
        self.db_path = db_path
        self.brain_db_path = brain_db_path or os.getenv("KRISTINA_STATE_DB", "kristina_state.db")
        self.perplexity = PerplexityAPI()
        self.knowledge_cache: Dict[str, str] = {}
        self.last_learning: Optional[datetime] = None

        self._init_db()
        self._load_cache()

    def _init_db(self) -> None:
        try:
            with sqlite3.connect(self.db_path, timeout=5.0) as conn:
                if self.db_path != ":memory:":
                    conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS knowledge (
                        topic TEXT PRIMARY KEY,
                        content TEXT,
                        learned_at TIMESTAMP,
                        source TEXT
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS synaptic_reward_ledger (
                        scope_id TEXT PRIMARY KEY,
                        reward_sum REAL NOT NULL DEFAULT 0.0,
                        event_count INTEGER NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.commit()
        except Exception as e:
            logger.error("DB init error: %s", e)

    def _load_cache(self) -> None:
        try:
            with sqlite3.connect(self.db_path, timeout=5.0) as conn:
                cursor = conn.execute(
                    "SELECT topic, content FROM knowledge ORDER BY learned_at DESC LIMIT 20"
                )
                for row in cursor:
                    self.knowledge_cache[row[0]] = row[1]
        except Exception as e:
            logger.error("Cache load error: %s", e)

    def _accumulate_reward_sync(self, scope_id: str, reward: float) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(self.db_path, timeout=5.0) as conn:
            conn.execute(
                """
                INSERT INTO synaptic_reward_ledger(scope_id, reward_sum, event_count, updated_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(scope_id) DO UPDATE SET
                    reward_sum = synaptic_reward_ledger.reward_sum + excluded.reward_sum,
                    event_count = synaptic_reward_ledger.event_count + 1,
                    updated_at = excluded.updated_at
                """,
                (scope_id, float(reward), now_iso),
            )
            conn.commit()

    def _pop_daily_reward_sync(self, scope_id: str) -> Optional[float]:
        # Атомарный claim дневной награды: BEGIN IMMEDIATE сериализует read+reset в одну
        # write-транзакцию, поэтому из N конкурентных pop ровно один получает награду,
        # остальные видят event_count=0 и возвращают None. Раньше SELECT -> UPDATE шли
        # разными транзакциями и одна и та же награда выдавалась нескольким конкурентам.
        conn = sqlite3.connect(self.db_path, timeout=5.0, isolation_level=None)
        try:
            conn.execute("PRAGMA busy_timeout = 5000")
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT reward_sum, event_count FROM synaptic_reward_ledger WHERE scope_id = ?",
                (scope_id,),
            ).fetchone()
            if not row or int(row[1]) <= 0:
                conn.execute("ROLLBACK")
                return None
            avg = float(row[0]) / float(row[1])
            conn.execute(
                "UPDATE synaptic_reward_ledger SET reward_sum = 0.0, event_count = 0, updated_at = ? WHERE scope_id = ? AND event_count > 0",
                (datetime.now(timezone.utc).isoformat(), scope_id),
            )
            conn.execute("COMMIT")
            return max(-1.0, min(1.0, avg))
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            conn.close()

    async def record_dialogue_feedback(
        self,
        scope_id: str = "default",
        *,
        reaction: str = "curiosity",
        intensity: float = 0.6,
        reward: float = 0.0,
        user_excerpt: str = "",
        location: Optional[str] = None,
        sensory_cue: Optional[str] = None,
        event_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Не-LLM запись дневного опыта: спайки синапсов + след пригодности + якорь среды."""
        base_stimuli = REACTION_STIMULI_MAP.get(reaction, REACTION_STIMULI_MAP["neutral"])
        scale = max(0.15, min(1.0, float(intensity)))
        stimuli = {k: round(v * scale, 4) for k, v in base_stimuli.items()}

        store = AsyncSQLiteStateStore(self.brain_db_path)
        engine = BrainEngine(store)
        await engine.start()
        try:
            if user_excerpt or location or sensory_cue:
                appraisal = Appraisal(
                    reaction=reaction if reaction in ("curiosity", "warmth", "concern", "frustration", "neutral") else "neutral",
                    intensity=scale,
                    source_quote=user_excerpt[:160],
                    interest_action="keep",
                    topic="живой диалог",
                    reflection="",
                    detected_location=location,
                    environment_cue=sensory_cue,
                )
                await engine.ingest_message(
                    scope_id=scope_id,
                    event_id=event_id or f"learn-{datetime.now(timezone.utc).timestamp():.6f}",
                    user_input=user_excerpt or (sensory_cue or "сигнал диалога"),
                    explicit_appraisal=appraisal,
                )
            pulse = await engine.pulse_synapses(scope_id, stimuli)
        finally:
            await engine.shutdown()

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._accumulate_reward_sync, scope_id, reward)
        return pulse

    async def consolidate_sleep(
        self,
        scope_id: str = "default",
        *,
        explicit_reward: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Ночная консолидация: пластичность Хебба, дрейф baseline 12 мод и синтез DreamSeed."""
        loop = asyncio.get_running_loop()
        ledger_reward = await loop.run_in_executor(None, self._pop_daily_reward_sync, scope_id)
        effective_reward = (
            float(explicit_reward)
            if explicit_reward is not None
            else (ledger_reward if ledger_reward is not None else 0.25)
        )
        effective_reward = max(-1.0, min(1.0, effective_reward))

        store = AsyncSQLiteStateStore(self.brain_db_path)
        engine = BrainEngine(store)
        await engine.start()
        try:
            report = await engine.run_sleep_consolidation(scope_id, reward_signal=effective_reward)
        finally:
            await engine.shutdown()

        today_key = f"night_reflection:{scope_id}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
        seed = report.get("dream_seed") or {}
        summary = (
            f"Ночная интеграция опыта (reward={effective_reward:+.2f}): "
            f"обновлено синапсов={(report.get('synapses_adjusted', 0) if isinstance(report.get('synapses_adjusted', 0), int) else len(report.get('synapses_adjusted', {})))}, "
            f"мотивы={', '.join(seed.get('dominant_themes') or ()) or 'тишина'}."
        )
        await self._save_to_db(today_key, {"content": summary, "source": "synaptic_sleep"})
        self.knowledge_cache[today_key] = summary
        self.last_learning = datetime.now(timezone.utc)
        return report

    async def learn_topic(self, topic_key: str, custom_query: Optional[str] = None) -> Dict[str, Any]:
        query = custom_query or self.WRITER_TOPICS.get(topic_key, f"Наблюдения и фактура по теме: {topic_key}")
        result = await self.perplexity.query(query)
        if "error" not in result and result.get("content"):
            await self._save_to_db(topic_key, result)
            self.knowledge_cache[topic_key] = result["content"]
            self.last_learning = datetime.now(timezone.utc)
        return result

    async def _save_to_db(self, topic: str, data: Dict[str, Any]) -> None:
        def _write() -> None:
            with sqlite3.connect(self.db_path, timeout=5.0) as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO knowledge (topic, content, learned_at, source)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        topic,
                        data.get("content", ""),
                        datetime.now(timezone.utc).isoformat(),
                        data.get("source", "perplexity"),
                    ),
                )
                conn.commit()

        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _write)
        except Exception as e:
            logger.error("DB save error: %s", e)

    async def learn_random_topic(self) -> Dict[str, Any]:
        topic = random.choice(list(self.WRITER_TOPICS.keys()))
        return await self.learn_topic(topic)

    async def daily_learning_routine(self) -> None:
        await self.learn_topic("stockholm_events")
        await self.learn_topic("literary_nonfiction")
        await self.learn_topic("sweden_culture")

    def get_context_for_thought(self) -> str:
        if not self.knowledge_cache:
            return ""
        topic = random.choice(list(self.knowledge_cache.keys()))
        content = self.knowledge_cache[topic][:150]
        return f"{topic}: {content}"

    def get_recent_knowledge(self, limit: int = 3) -> List[Dict[str, str]]:
        topics = list(self.knowledge_cache.keys())[:limit]
        return [{"topic": t, "preview": self.knowledge_cache[t][:100]} for t in topics]


_learning_agent: Optional[SelfLearningAgent] = None


def get_learning_agent() -> SelfLearningAgent:
    global _learning_agent
    if _learning_agent is None:
        _learning_agent = SelfLearningAgent()
    return _learning_agent
