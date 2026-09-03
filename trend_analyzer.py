"""
Trend Analyzer — LLM-анализ собранных сигналов спроса

Превращает сырые сигналы (Hacker News, Reddit, GitHub) в структурированный
отчёт: кластеры пользовательских запросов, боли и идеи монетизируемых
стартапов. Отчёты сохраняются в data/trend_reports/.
"""

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from trend_collector import Signal
from trend_scout_prompt import ANALYSIS_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

REPORTS_DIR = Path(__file__).parent / "data" / "trend_reports"


def build_analysis_prompt(signals: List[Signal], topic: str = "") -> str:
    """Собрать user-промпт из сигналов"""
    lines = [s.as_line() for s in signals[:80]]  # ограничиваем размер промпта
    topic_line = f"Фокус анализа: «{topic}»\n\n" if topic else ""
    return (
        f"{topic_line}Сигналы за последнюю неделю "
        f"({len(lines)} шт., отсортированы по популярности):\n\n"
        + "\n".join(lines)
        + "\n\nПроанализируй сигналы и составь отчёт по формату."
    )


def format_raw_digest(signals: List[Signal], top_n: int = 20) -> str:
    """Отчёт без LLM — просто дайджест сильнейших сигналов"""
    if not signals:
        return "📡 Не удалось собрать сигналы: источники недоступны."
    lines = ["📡 **Сырой дайджест сигналов спроса** (LLM-анализ недоступен):\n"]
    for s in signals[:top_n]:
        lines.append(f"- {s.as_line()}\n  {s.url}")
    return "\n".join(lines)


class TrendAnalyzer:
    """LLM-анализатор сигналов спроса"""

    def __init__(self, ai_client=None):
        # Ленивая инициализация: без DEEPSEEK_API_KEY работаем в raw-режиме
        self._ai = ai_client

    def _get_ai(self):
        if self._ai is None:
            from ai_client import get_ai_client
            self._ai = get_ai_client()
        return self._ai

    async def analyze(self, signals: List[Signal], topic: str = "") -> str:
        """Проанализировать сигналы, вернуть Markdown-отчёт"""
        if not signals:
            return format_raw_digest(signals)
        try:
            ai = self._get_ai()
            messages = [
                {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                {"role": "user", "content": build_analysis_prompt(signals, topic)},
            ]
            # 4000: тематические отчёты с 3-4 детальными идеями не влезали
            # в 2000 токенов и обрывались до секций «Резерв» и «Вывод»
            report = await ai.chat(messages, temperature=0.4, max_tokens=4000)
            return report
        except Exception as e:
            logger.error(f"Trend analysis LLM error: {e}")
            return format_raw_digest(signals)

    async def close(self):
        if self._ai is not None:
            try:
                await self._ai.close()
            except Exception:
                pass


def save_report(report_md: str, signals: List[Signal], topic: str = "") -> Tuple[str, str]:
    """Сохранить отчёт (.md) и сырые сигналы (.json). Возвращает пути к файлам."""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    md_path = REPORTS_DIR / f"report_{stamp}.md"
    header = f"# Отчёт TrendScout — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
    if topic:
        header += f"\nТема: **{topic}**\n"
    md_path.write_text(header + "\n" + report_md, encoding="utf-8")

    json_path = REPORTS_DIR / f"signals_{stamp}.json"
    payload = {
        "generated_at": datetime.now().isoformat(),
        "topic": topic,
        "signals": [s.to_dict() for s in signals],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    logger.info(f"💾 Report saved: {md_path}")
    return str(md_path), str(json_path)


def get_trend_analyzer() -> TrendAnalyzer:
    return TrendAnalyzer()
