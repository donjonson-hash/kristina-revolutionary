#!/usr/bin/env python3
"""
Standalone-запуск агента TrendScout.

Примеры:
    python run_trend_scout.py                       # общий обзор трендов
    python run_trend_scout.py --topic "ai agents"   # фокус на теме
    python run_trend_scout.py --raw                 # без LLM, только дайджест
    python run_trend_scout.py --limit 25            # больше сигналов на источник

Для LLM-анализа нужен DEEPSEEK_API_KEY в .env (без него — сырой дайджест).
Отчёты сохраняются в data/trend_reports/.
"""

import argparse
import asyncio
import logging
import sys

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("trend_scout")


async def run(topic: str, limit: int, raw: bool, no_save: bool) -> int:
    from trend_collector import get_trend_collector
    from trend_analyzer import get_trend_analyzer, format_raw_digest, save_report

    collector = get_trend_collector()
    try:
        signals = await collector.collect_all(topic, limit_per_source=limit)
    finally:
        await collector.close()

    if not signals:
        print("❌ Не удалось собрать ни одного сигнала — проверь доступ к сети.")
        return 1

    if raw:
        report = format_raw_digest(signals, top_n=min(40, len(signals)))
    else:
        analyzer = get_trend_analyzer()
        try:
            report = await analyzer.analyze(signals, topic)
        finally:
            await analyzer.close()

    print("\n" + "=" * 60)
    print(report)
    print("=" * 60 + "\n")

    if not no_save:
        md_path, json_path = save_report(report, signals, topic)
        print(f"💾 Отчёт: {md_path}")
        print(f"💾 Сырые сигналы: {json_path}")

    return 0


def main():
    parser = argparse.ArgumentParser(
        description="TrendScout — сбор запросов пользователей и идеи стартапов"
    )
    parser.add_argument("--topic", default="", help="тема исследования (например: 'ai agents')")
    parser.add_argument("--limit", type=int, default=15, help="сигналов на источник (default: 15)")
    parser.add_argument("--raw", action="store_true", help="без LLM: только дайджест сигналов")
    parser.add_argument("--no-save", action="store_true", help="не сохранять отчёт на диск")
    args = parser.parse_args()

    sys.exit(asyncio.run(run(args.topic, args.limit, args.raw, args.no_save)))


if __name__ == "__main__":
    main()
