"""
Trend Scout Agent — разведчик рынка

Собирает информацию об актуальных запросах пользователей из открытых
источников (Hacker News, Reddit, GitHub) и на её основе предлагает
идеи монетизируемых стартапов.
"""

import logging
import re
from typing import Dict, List, Optional

from .base_agent import BaseAgent, AgentResponse

logger = logging.getLogger(__name__)

# Слова, которые убираем из сообщения при извлечении темы исследования
_TOPIC_STOPWORDS = [
    "исследуй", "найди", "проанализируй", "собери", "покажи",
    "тренды", "тренд", "стартап", "стартапы", "идеи", "идея",
    "рынок", "спрос", "запросы", "монетизация", "ниша", "ниши",
    "для", "про", "по", "на", "в", "о", "об",
]


def extract_topic(user_input: str) -> str:
    """Извлечь тему исследования из сообщения пользователя"""
    words = re.findall(r"[\w-]+", user_input.lower())
    topic_words = [w for w in words if w not in _TOPIC_STOPWORDS and len(w) > 2]
    return " ".join(topic_words[:4])


class TrendScoutAgent(BaseAgent):
    """Агент-исследователь: спрос пользователей → идеи стартапов"""

    def __init__(self, collector=None, analyzer=None):
        from trend_scout_prompt import AGENT_SYSTEM_PROMPT
        super().__init__(
            name="TrendScout",
            description="Разведчик рынка: собирает актуальные запросы пользователей "
                        "и предлагает идеи монетизируемых стартапов",
            system_prompt=AGENT_SYSTEM_PROMPT,
        )
        # Основы слов — матчатся с разными словоформами ("нишу", "монетизации")
        self.activation_keywords = [
            "стартап", "тренд", "монетизаци", "ниш", "спрос",
            "идея бизнеса", "бизнес идея", "бизнес-идея", "рынок", "рынк",
            "запросы пользователей", "startup", "trend", "mvp",
            "чем заняться", "что востребовано", "актуальные запросы",
        ]
        # Инъекция зависимостей для тестов; по умолчанию — ленивое создание
        self._collector = collector
        self._analyzer = analyzer

    def _get_collector(self):
        if self._collector is None:
            from trend_collector import get_trend_collector
            self._collector = get_trend_collector()
        return self._collector

    def _get_analyzer(self):
        if self._analyzer is None:
            from trend_analyzer import get_trend_analyzer
            self._analyzer = get_trend_analyzer()
        return self._analyzer

    async def run_research(self, topic: str = "", save: bool = True,
                           limit_per_source: int = 15) -> Dict:
        """
        Полный цикл исследования: сбор сигналов → LLM-анализ → сохранение.

        Возвращает dict: report (Markdown), signals_count, sources, report_path.
        """
        collector = self._get_collector()
        analyzer = self._get_analyzer()

        signals = []
        try:
            signals = await collector.collect_all(topic, limit_per_source)
        except Exception as e:
            logger.error(f"TrendScout collect error: {e}")
        finally:
            try:
                await collector.close()
            except Exception:
                pass

        report = await analyzer.analyze(signals, topic)

        report_path = None
        if save and signals:
            try:
                from trend_analyzer import save_report
                report_path, _ = save_report(report, signals, topic)
            except Exception as e:
                logger.warning(f"TrendScout save error: {e}")

        return {
            "report": report,
            "signals_count": len(signals),
            "sources": sorted({s.source for s in signals}),
            "report_path": report_path,
        }

    async def process(self, user_input: str, context: Dict) -> AgentResponse:
        self.add_to_history("user", user_input)

        topic = extract_topic(user_input)
        logger.info(f"🔍 TrendScout research, topic: '{topic or 'общий обзор'}'")

        try:
            result = await self.run_research(topic)
            header = (
                f"📡 Собрано сигналов: {result['signals_count']} "
                f"(источники: {', '.join(result['sources']) or 'нет'})\n\n"
            )
            response_text = header + result["report"]
        except Exception as e:
            logger.error(f"TrendScout process error: {e}")
            response_text = (
                "😔 Не получилось провести исследование — источники или "
                "AI недоступны. Попробуй позже или уточни тему: "
                "например, «тренды AI для малого бизнеса»."
            )

        self.add_to_history("assistant", response_text)

        return AgentResponse(
            content=response_text,
            agent_name=self.name,
            confidence=0.9,
            emotion="деловой, аналитический",
            suggested_actions=[
                "углубиться в конкретную нишу",
                "оценить конкурентов",
                "составить план MVP",
            ],
            context_used={"topic": topic},
        )
