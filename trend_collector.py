"""
Trend Collector — сбор сигналов пользовательского спроса из открытых источников

Источники (без API-ключей):
- Hacker News (Algolia API): популярные истории и Ask HN
- Reddit (публичный JSON): сабреддиты о стартапах и запросах пользователей
- GitHub (Search API): быстрорастущие новые репозитории

Каждый источник опрашивается независимо: падение одного не ломает сбор.
"""

import asyncio
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import aiohttp

logger = logging.getLogger(__name__)

USER_AGENT = "KristinaTrendScout/1.0 (research bot)"
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=15)

# Сабреддиты, где пользователи прямо формулируют запросы и боли
DEFAULT_SUBREDDITS = [
    "SomebodyMakeThis",   # прямые запросы «сделайте мне такой продукт»
    "startups",           # обсуждения проблем и ниш
    "Entrepreneur",       # боли предпринимателей
    "SaaS",               # запросы к SaaS-продуктам
    "sidehustle",         # что люди пытаются монетизировать
]


@dataclass
class Signal:
    """Единица собранной информации — один сигнал спроса"""
    source: str                      # hackernews / reddit / github
    title: str
    url: str
    score: int = 0                   # апвоуты / звёзды
    comments: int = 0
    created_at: str = ""             # ISO-строка
    extra: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return asdict(self)

    def as_line(self) -> str:
        """Компактная строка для LLM-промпта"""
        return f"[{self.source}] ({self.score}↑, {self.comments}💬) {self.title}"


class TrendCollector:
    """Асинхронный сборщик сигналов спроса"""

    def __init__(self, subreddits: Optional[List[str]] = None):
        self.subreddits = subreddits or DEFAULT_SUBREDDITS
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={"User-Agent": USER_AGENT},
                timeout=REQUEST_TIMEOUT,
            )
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def _get_json(self, url: str, params: Optional[Dict] = None) -> Optional[Dict]:
        try:
            session = await self._get_session()
            async with session.get(url, params=params) as response:
                if response.status != 200:
                    logger.warning(f"Trend source {url}: HTTP {response.status}")
                    return None
                return await response.json()
        except Exception as e:
            logger.warning(f"Trend source {url} failed: {e}")
            return None

    # ---------- Hacker News (Algolia) ----------

    async def collect_hackernews(self, topic: str = "", limit: int = 20) -> List[Signal]:
        """Популярные истории + Ask HN за последнюю неделю"""
        week_ago = int((datetime.now() - timedelta(days=7)).timestamp())
        signals: List[Signal] = []

        for tags in ("story", "ask_hn"):
            params = {
                "tags": tags,
                "numericFilters": f"created_at_i>{week_ago}",
                "hitsPerPage": limit,
            }
            if topic:
                params["query"] = topic
            data = await self._get_json("https://hn.algolia.com/api/v1/search", params)
            if not data:
                continue
            for hit in data.get("hits", []):
                title = hit.get("title") or ""
                if not title:
                    continue
                signals.append(Signal(
                    source="hackernews",
                    title=title,
                    url=hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                    score=hit.get("points") or 0,
                    comments=hit.get("num_comments") or 0,
                    created_at=hit.get("created_at") or "",
                    extra={"type": tags},
                ))
        return signals

    # ---------- Reddit (публичный JSON) ----------

    async def collect_reddit(self, topic: str = "", limit: int = 10) -> List[Signal]:
        """Топ постов за неделю из сабреддитов о стартапах и запросах"""
        signals: List[Signal] = []

        async def fetch_sub(sub: str) -> List[Signal]:
            url = f"https://www.reddit.com/r/{sub}/top.json"
            data = await self._get_json(url, {"t": "week", "limit": limit})
            if not data:
                return []
            result = []
            for child in data.get("data", {}).get("children", []):
                post = child.get("data", {})
                title = post.get("title") or ""
                if not title:
                    continue
                if topic and topic.lower() not in (title + post.get("selftext", "")).lower():
                    continue
                result.append(Signal(
                    source="reddit",
                    title=title,
                    url=f"https://www.reddit.com{post.get('permalink', '')}",
                    score=post.get("ups") or 0,
                    comments=post.get("num_comments") or 0,
                    created_at=datetime.fromtimestamp(post.get("created_utc", 0)).isoformat()
                    if post.get("created_utc") else "",
                    extra={"subreddit": sub, "selftext": (post.get("selftext") or "")[:300]},
                ))
            return result

        results = await asyncio.gather(*(fetch_sub(s) for s in self.subreddits))
        for sub_signals in results:
            signals.extend(sub_signals)
        return signals

    # ---------- GitHub (Search API, без ключа) ----------

    async def collect_github(self, topic: str = "", limit: int = 15) -> List[Signal]:
        """Быстрорастущие репозитории, созданные за последний месяц"""
        month_ago = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        query = f"created:>{month_ago} stars:>50"
        if topic:
            query = f"{topic} {query}"
        data = await self._get_json(
            "https://api.github.com/search/repositories",
            {"q": query, "sort": "stars", "order": "desc", "per_page": limit},
        )
        if not data:
            return []
        signals = []
        for repo in data.get("items", []):
            name = repo.get("full_name") or ""
            if not name:
                continue
            description = repo.get("description") or ""
            signals.append(Signal(
                source="github",
                title=f"{name} — {description}"[:200],
                url=repo.get("html_url") or "",
                score=repo.get("stargazers_count") or 0,
                comments=repo.get("open_issues_count") or 0,
                created_at=repo.get("created_at") or "",
                extra={"language": repo.get("language") or ""},
            ))
        return signals

    # ---------- Общий сбор ----------

    async def collect_all(self, topic: str = "", limit_per_source: int = 15) -> List[Signal]:
        """Собрать сигналы из всех источников параллельно"""
        results = await asyncio.gather(
            self.collect_hackernews(topic, limit_per_source),
            self.collect_reddit(topic, limit=max(5, limit_per_source // 3)),
            self.collect_github(topic, limit_per_source),
            return_exceptions=True,
        )
        signals: List[Signal] = []
        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"Collector failed: {result}")
                continue
            signals.extend(result)

        # Сильные сигналы первыми
        signals.sort(key=lambda s: s.score, reverse=True)
        sources = {s.source for s in signals}
        logger.info(f"📡 Collected {len(signals)} signals from {len(sources)} sources")
        return signals


def get_trend_collector() -> TrendCollector:
    return TrendCollector()
