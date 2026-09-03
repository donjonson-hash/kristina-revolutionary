"""
Trend Collector — сбор сигналов пользовательского спроса из открытых источников

Источники (без API-ключей):
- Hacker News (Algolia API): популярные истории и Ask HN
- Reddit (публичный JSON): сабреддиты о стартапах и запросах пользователей
- GitHub (Search API): быстрорастущие новые репозитории
- Поисковые подсказки (Google autocomplete, fallback DuckDuckGo)
- Stack Exchange (softwarerecs): прямые запросы «посоветуйте софт»
- App Store (iTunes Search + RSS отзывов): негативные отзывы 1-3★ —
  жалобы платящих пользователей на существующие приложения

Сигналы балансируются между источниками (см. balance_by_source):
шкалы score несравнимы, глобальная сортировка искажала бы выборку.

TikTok и Instagram публичного API не имеют — они входят в методологию
анализа и валидации (см. trend_scout_prompt.py).

Каждый источник опрашивается независимо: падение одного не ломает сбор.
"""

import asyncio
import html
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from itertools import zip_longest
from typing import Dict, List, Optional
from urllib.parse import quote_plus

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
                # content_type=None: suggest-эндпоинты отдают text/javascript
                return await response.json(content_type=None)
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

    # ---------- Поисковые подсказки (Google autocomplete, без ключа) ----------

    # Хвосты-индикаторы боли и намерения из методологии (trend_scout_prompt)
    INTENT_TAILS = ["как", "для", "не работает", "альтернатива", "цена", "app", "tool"]
    # Затравки для общего обзора, когда тема не задана:
    # боль-ориентированные формулировки дают запросы с неудовлетворённым
    # спросом, а не generic-перечни «приложение для рисования»
    DEFAULT_SEEDS = [
        "приложение для", "сервис для", "как автоматизировать",
        "как избавиться от", "устал от", "надоело вручную",
        "инструмент для автоматизации",
        "app for", "tool for", "how to automate",
        "how to get rid of", "tired of manually", "i wish there was an app",
    ]

    async def collect_search_suggest(self, topic: str = "", limit: int = 20) -> List[Signal]:
        """Автодополнение поиска — дословные формулировки массовых запросов"""
        if topic:
            seeds = [topic] + [f"{topic} {tail}" for tail in self.INTENT_TAILS]
        else:
            seeds = self.DEFAULT_SEEDS

        # Провайдеры с одинаковым форматом ответа: ["запрос", ["подсказка", ...]]
        providers = [
            ("https://suggestqueries.google.com/complete/search",
             lambda seed: {"client": "firefox", "q": seed, "hl": "ru"}),
            ("https://duckduckgo.com/ac/",
             lambda seed: {"q": seed, "type": "list"}),
        ]

        async def fetch_seed(seed: str) -> List[Signal]:
            data = None
            for url, make_params in providers:
                data = await self._get_json(url, make_params(seed))
                if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], list):
                    break
                data = None
            if data is None:
                return []
            suggestions = [s for s in data[1] if isinstance(s, str) and s.strip()]
            return [
                Signal(
                    source="search",
                    title=suggestion,
                    url="https://www.google.com/search?q=" + quote_plus(suggestion),
                    # Позиция в подсказках — прокси популярности запроса
                    score=len(suggestions) - idx,
                    extra={"seed": seed},
                )
                for idx, suggestion in enumerate(suggestions)
            ]

        results = await asyncio.gather(*(fetch_seed(s) for s in seeds))
        # Дедупликация по тексту запроса
        seen, signals = set(), []
        for seed_signals in results:
            for signal in seed_signals:
                key = signal.title.lower()
                if key not in seen:
                    seen.add(key)
                    signals.append(signal)
        return signals[:limit]

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

    # ---------- Stack Exchange (Software Recommendations, без ключа) ----------

    async def collect_stackexchange(self, topic: str = "", limit: int = 15,
                                    site: str = "softwarerecs") -> List[Signal]:
        """
        softwarerecs.stackexchange.com — люди прямо просят посоветовать софт
        под задачу: канал прямых запросов пользователей (работает с IP
        дата-центров, в отличие от Reddit).
        """
        week_ago = int((datetime.now() - timedelta(days=14)).timestamp())
        params = {
            "site": site,
            "sort": "votes",
            "order": "desc",
            "fromdate": week_ago,
            "pagesize": limit,
        }
        url = "https://api.stackexchange.com/2.3/questions"
        if topic:
            url = "https://api.stackexchange.com/2.3/search/advanced"
            params["q"] = topic
        data = await self._get_json(url, params)
        if not isinstance(data, dict):
            return []
        signals = []
        for item in data.get("items", []):
            title = html.unescape(item.get("title") or "")
            if not title:
                continue
            signals.append(Signal(
                source="stackexchange",
                title=title,
                url=item.get("link") or "",
                score=item.get("score") or 0,
                comments=item.get("answer_count") or 0,
                created_at=datetime.fromtimestamp(item.get("creation_date", 0)).isoformat()
                if item.get("creation_date") else "",
                extra={"site": site, "tags": (item.get("tags") or [])[:5]},
            ))
        return signals

    # ---------- App Store: негативные отзывы 1-3★ (iTunes RSS, без ключа) ----------

    # Термины для общего обзора, когда тема не задана
    DEFAULT_APP_TERMS = ["productivity", "финансы"]
    APP_COUNTRIES = ("us", "ru")

    async def _find_app_ids(self, term: str, country: str, limit: int = 2) -> List[Dict]:
        """iTunes Search API: топ приложений по запросу"""
        data = await self._get_json(
            "https://itunes.apple.com/search",
            {"term": term, "entity": "software", "country": country, "limit": limit},
        )
        if not isinstance(data, dict):
            return []
        return [
            {"id": r.get("trackId"), "name": r.get("trackName") or ""}
            for r in data.get("results", [])
            if r.get("trackId")
        ]

    async def _fetch_app_reviews(self, app: Dict, country: str, max_reviews: int = 5) -> List[Signal]:
        """RSS свежих отзывов приложения; берём только 1-3★ — карта болей"""
        data = await self._get_json(
            f"https://itunes.apple.com/{country}/rss/customerreviews/"
            f"id={app['id']}/sortBy=mostRecent/json"
        )
        if not isinstance(data, dict):
            return []
        entries = data.get("feed", {}).get("entry", [])
        if isinstance(entries, dict):
            entries = [entries]
        signals = []
        for entry in entries:
            rating_raw = entry.get("im:rating", {}).get("label")
            if rating_raw is None:
                continue  # первая entry — метаданные приложения, не отзыв
            try:
                rating = int(rating_raw)
            except (TypeError, ValueError):
                continue
            if rating > 3:
                continue
            title = (entry.get("title", {}).get("label") or "").strip()
            content = (entry.get("content", {}).get("label") or "").strip()
            text = f"{title} — {content}" if title and content else (title or content)
            if not text:
                continue
            signals.append(Signal(
                source="appstore",
                title=f"{app['name']} ({rating}★): {text[:200]}",
                url=f"https://apps.apple.com/{country}/app/id{app['id']}",
                score=4 - rating,  # вес боли: 1★ → 3, 3★ → 1
                extra={"app": app["name"], "rating": rating, "country": country},
            ))
            if len(signals) >= max_reviews:
                break
        return signals

    async def collect_appstore(self, topic: str = "", limit: int = 15) -> List[Signal]:
        """
        Отзывы 1-3★ на приложения по теме — жалобы платящих пользователей
        на существующие решения (Google Play публичного RSS не имеет).
        """
        terms = [topic] if topic else self.DEFAULT_APP_TERMS

        apps: List[tuple] = []  # (app, country)
        for country in self.APP_COUNTRIES:
            found = await asyncio.gather(*(self._find_app_ids(t, country) for t in terms))
            for app_list in found:
                apps.extend((app, country) for app in app_list)

        review_lists = await asyncio.gather(
            *(self._fetch_app_reviews(app, country) for app, country in apps)
        )
        signals = [s for lst in review_lists for s in lst]
        return signals[:limit]

    # ---------- Общий сбор ----------

    async def collect_all(self, topic: str = "", limit_per_source: int = 15) -> List[Signal]:
        """Собрать сигналы из всех источников параллельно"""
        results = await asyncio.gather(
            self.collect_hackernews(topic, limit_per_source),
            self.collect_reddit(topic, limit=max(5, limit_per_source // 3)),
            self.collect_github(topic, limit_per_source),
            self.collect_search_suggest(topic, limit_per_source),
            self.collect_stackexchange(topic, limit_per_source),
            self.collect_appstore(topic, limit_per_source),
            return_exceptions=True,
        )
        signals: List[Signal] = []
        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"Collector failed: {result}")
                continue
            signals.extend(result)

        balanced = balance_by_source(signals)
        sources = {s.source for s in balanced}
        logger.info(f"📡 Collected {len(balanced)} signals from {len(sources)} sources")
        return balanced


def balance_by_source(signals: List[Signal]) -> List[Signal]:
    """
    Сбалансировать сигналы: сортировка по score внутри источника и
    чередование источников. Шкалы score несравнимы между каналами
    (звёзды GitHub ≫ апвоуты форумов), поэтому глобальная сортировка
    вытесняла бы все каналы, кроме GitHub, из топа промпта для LLM.
    """
    by_source: Dict[str, List[Signal]] = {}
    for signal in signals:
        by_source.setdefault(signal.source, []).append(signal)
    for group in by_source.values():
        group.sort(key=lambda s: s.score, reverse=True)
    return [
        signal
        for batch in zip_longest(*by_source.values())
        for signal in batch
        if signal is not None
    ]


def get_trend_collector() -> TrendCollector:
    return TrendCollector()
