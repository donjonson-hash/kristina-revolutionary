"""
Тесты TrendScout: агент, коллектор (офлайн), анализатор (без LLM)
"""

import asyncio
import sys
import os

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trend_collector import Signal, TrendCollector
from trend_analyzer import build_analysis_prompt, format_raw_digest, TrendAnalyzer
from agents.trend_scout import TrendScoutAgent, extract_topic


def make_signals():
    return [
        Signal(source="hackernews", title="Ask HN: инструмент для учёта подписок?",
               url="https://news.ycombinator.com/item?id=1", score=250, comments=120),
        Signal(source="reddit", title="Somebody make an app for freelancers taxes",
               url="https://reddit.com/r/SomebodyMakeThis/1", score=90, comments=40),
        Signal(source="github", title="acme/ai-notes — AI note taking",
               url="https://github.com/acme/ai-notes", score=1200, comments=15),
    ]


# ---------- Signal ----------

def test_signal_as_line():
    s = make_signals()[0]
    line = s.as_line()
    assert "[hackernews]" in line
    assert "250" in line
    assert "инструмент" in line


def test_signal_to_dict():
    d = make_signals()[1].to_dict()
    assert d["source"] == "reddit"
    assert d["score"] == 90


# ---------- Analyzer (без LLM) ----------

def test_build_analysis_prompt_contains_signals_and_topic():
    prompt = build_analysis_prompt(make_signals(), topic="ai")
    assert "«ai»" in prompt
    assert "[hackernews]" in prompt
    assert "[github]" in prompt
    assert "3 шт." in prompt


def test_format_raw_digest():
    digest = format_raw_digest(make_signals(), top_n=2)
    assert "дайджест" in digest.lower()
    assert digest.count("- [") == 2  # top_n ограничивает


def test_format_raw_digest_empty():
    assert "Не удалось" in format_raw_digest([])


def test_analyzer_falls_back_without_llm():
    """При ошибке LLM анализатор возвращает сырой дайджест, а не падает"""
    class BrokenAI:
        async def chat(self, *a, **kw):
            raise RuntimeError("no api key")

    analyzer = TrendAnalyzer(ai_client=BrokenAI())
    report = asyncio.run(analyzer.analyze(make_signals()))
    assert "дайджест" in report.lower()


# ---------- extract_topic ----------

@pytest.mark.parametrize("text,expected_in", [
    ("исследуй тренды ai для малого бизнеса", "малого"),
    ("найди идеи стартапов про доставку еды", "доставку"),
])
def test_extract_topic(text, expected_in):
    topic = extract_topic(text)
    assert expected_in in topic
    assert "исследуй" not in topic
    assert "стартапов" not in topic or expected_in in topic


# ---------- Агент ----------

class FakeCollector:
    def __init__(self, signals):
        self.signals = signals

    async def collect_all(self, topic="", limit_per_source=15):
        return self.signals

    async def close(self):
        pass


class FakeAnalyzer:
    async def analyze(self, signals, topic=""):
        return f"## Отчёт по {len(signals)} сигналам"


def make_agent(signals=None):
    return TrendScoutAgent(
        collector=FakeCollector(signals if signals is not None else make_signals()),
        analyzer=FakeAnalyzer(),
    )


def test_agent_activation_keywords():
    agent = make_agent()
    assert agent.should_activate("хочу запустить стартап, где найти нишу?") > 0.5
    assert agent.should_activate("как дела?") == 0.0


def test_agent_registered_name():
    agent = make_agent()
    assert agent.name == "TrendScout"


def test_agent_run_research():
    agent = make_agent()
    result = asyncio.run(agent.run_research(save=False))
    assert result["signals_count"] == 3
    assert set(result["sources"]) == {"hackernews", "reddit", "github"}
    assert "Отчёт по 3 сигналам" in result["report"]


def test_agent_process_returns_report():
    agent = make_agent()
    response = asyncio.run(agent.process("исследуй тренды рынка", {"user_id": "u1"}))
    assert response.agent_name == "TrendScout"
    assert "Собрано сигналов: 3" in response.content
    assert response.confidence > 0.5
    # История ведётся
    assert len(agent.conversation_history) == 2


def test_agent_process_survives_broken_collector():
    class ExplodingCollector:
        async def collect_all(self, *a, **kw):
            raise RuntimeError("network down")

        async def close(self):
            pass

    agent = TrendScoutAgent(collector=ExplodingCollector(), analyzer=FakeAnalyzer())
    response = asyncio.run(agent.process("тренды", {"user_id": "u1"}))
    # Не падает: отчёт по нулю сигналов
    assert response.agent_name == "TrendScout"
    assert "0" in response.content


def test_router_integration():
    """Агент регистрируется в роутере и находится по имени"""
    from agents.router import AgentRouter

    router = AgentRouter()
    router.register_agent(make_agent())
    assert "TrendScout" in router.agents
    assert router.set_active_agent("TrendScoutAgent") is True
    assert router.get_active_agent().name == "TrendScout"


# ---------- Методология (trend_scout_prompt) ----------

def test_methodology_prompt_covers_required_channels():
    """Промт содержит алгоритм и все каналы из ТЗ"""
    from trend_scout_prompt import (
        TREND_SCOUT_METHODOLOGY, ANALYSIS_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT,
    )
    for channel in ["Поисковики", "TikTok", "Instagram", "форумы", "GitHub"]:
        assert channel in TREND_SCOUT_METHODOLOGY, f"канал {channel} не описан"
    for step in ["Сбор сигналов", "Извлечение запросов", "Кластеризация",
                 "Скоринг", "Отбор", "Валидация"]:
        assert step in TREND_SCOUT_METHODOLOGY, f"шаг {step} не описан"
    # Полный промт = методология + формат отчёта
    assert TREND_SCOUT_METHODOLOGY in ANALYSIS_SYSTEM_PROMPT
    assert "ФОРМАТ ОТЧЁТА" in ANALYSIS_SYSTEM_PROMPT
    # Краткий промт агента упоминает ключевые каналы
    assert "TikTok" in AGENT_SYSTEM_PROMPT and "Instagram" in AGENT_SYSTEM_PROMPT


def test_agent_uses_methodology_prompt():
    from trend_scout_prompt import AGENT_SYSTEM_PROMPT
    agent = make_agent()
    assert agent.system_prompt == AGENT_SYSTEM_PROMPT


def test_analyzer_system_prompt_is_methodology():
    import trend_analyzer
    from trend_scout_prompt import ANALYSIS_SYSTEM_PROMPT
    assert trend_analyzer.ANALYSIS_SYSTEM_PROMPT == ANALYSIS_SYSTEM_PROMPT


# ---------- Поисковые подсказки ----------

def test_collect_search_suggest_parses_and_dedupes():
    collector = TrendCollector()

    async def fake_get_json(url, params=None):
        seed = params["q"]
        return [seed, [f"{seed} подсказка", "общий запрос"]]

    collector._get_json = fake_get_json
    signals = asyncio.run(collector.collect_search_suggest("тема", limit=50))

    assert signals, "подсказки не собраны"
    assert all(s.source == "search" for s in signals)
    # "общий запрос" повторяется для каждой затравки — должен остаться один
    assert sum(1 for s in signals if s.title == "общий запрос") == 1
    # url ведёт на страницу поиска
    assert signals[0].url.startswith("https://www.google.com/search?q=")


def test_collect_search_suggest_handles_bad_payload():
    collector = TrendCollector()

    async def fake_get_json(url, params=None):
        return {"unexpected": "shape"}

    collector._get_json = fake_get_json
    assert asyncio.run(collector.collect_search_suggest("тема")) == []


def test_collector_source_failure_is_isolated():
    """Падение одного источника не ломает collect_all"""
    collector = TrendCollector()

    async def boom(*a, **kw):
        raise RuntimeError("api down")

    async def ok(*a, **kw):
        return [make_signals()[0]]

    collector.collect_hackernews = ok
    collector.collect_reddit = boom
    collector.collect_github = boom
    collector.collect_search_suggest = boom
    collector.collect_stackexchange = boom

    signals = asyncio.run(collector.collect_all())
    assert len(signals) == 1
    assert signals[0].source == "hackernews"


# ---------- Балансировка источников ----------

def test_balance_by_source_interleaves():
    """GitHub с огромными score не вытесняет остальные каналы из топа"""
    from trend_collector import balance_by_source

    signals = (
        [Signal(source="github", title=f"gh{i}", url="", score=100000 - i) for i in range(10)]
        + [Signal(source="hackernews", title=f"hn{i}", url="", score=500 - i) for i in range(10)]
        + [Signal(source="search", title=f"s{i}", url="", score=10 - i) for i in range(10)]
    )
    balanced = balance_by_source(signals)

    assert len(balanced) == 30
    # В первых шести — все три источника, по кругу
    first_sources = [s.source for s in balanced[:6]]
    assert set(first_sources) == {"github", "hackernews", "search"}
    # Внутри источника порядок по score
    gh = [s for s in balanced if s.source == "github"]
    assert gh[0].score >= gh[1].score >= gh[2].score


def test_balance_by_source_empty():
    from trend_collector import balance_by_source
    assert balance_by_source([]) == []


# ---------- Stack Exchange ----------

def test_collect_stackexchange_parses():
    collector = TrendCollector()

    async def fake_get_json(url, params=None):
        assert "api.stackexchange.com" in url
        return {"items": [
            {"title": "Tool to track &amp; split expenses?", "link": "https://softwarerecs.stackexchange.com/q/1",
             "score": 12, "answer_count": 3, "creation_date": 1756600000, "tags": ["finance", "web-app"]},
            {"title": "", "link": "skip-me"},
        ]}

    collector._get_json = fake_get_json
    signals = asyncio.run(collector.collect_stackexchange("expenses"))

    assert len(signals) == 1
    s = signals[0]
    assert s.source == "stackexchange"
    assert s.title == "Tool to track & split expenses?"  # HTML-сущности раскодированы
    assert s.score == 12 and s.comments == 3


def test_collect_stackexchange_bad_payload():
    collector = TrendCollector()

    async def fake_get_json(url, params=None):
        return ["unexpected"]

    collector._get_json = fake_get_json
    assert asyncio.run(collector.collect_stackexchange()) == []
