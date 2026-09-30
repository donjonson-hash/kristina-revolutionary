require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { callLLM } = require("./llm");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3456;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4";

// ===== Keyword → topic mapping =====
const TOPIC_MAP = {
  "ai": ["AI-инструменты", "LLM", "автономные агенты", "RAG", "модели-Reasoning"],
  "искусственный интеллект": ["AI-инструменты", "LLM", "автономные агенты"],
  "разработка": ["open source", "dev-tools", "API-first", "микросервисы"],
  "программирование": ["open source", "dev-tools", "no-code", "low-code"],
  "маркетинг": ["SaaS-маркетинг", "контент-маркетинг", "продуктовые метрики", "growth-hacking"],
  "контент": ["контент-маркетинг", "UGC", "видео", "подкасты"],
  "ecommerce": ["e-commerce", "DTC", "маркетплейсы", "конверсия"],
  "маркетплейс": ["e-commerce", "маркетплейсы", "DTC"],
  "дизайн": ["дизайн", "UX/UI", "AI-генерация", "дизайн-системы"],
  "продукт": ["продуктовые метрики", "growth-hacking", "onboarding", "retention"],
  "стартап": ["фандрайзинг", "growth-hacking", "продуктовые метрики", "SaaS-маркетинг"],
  "инвестиции": ["фандрайзинг", "венчур", "крипто", "дефи"],
  "крипто": ["крипто", "дефи", "NFT", "Web3"],
  "web3": ["Web3", "децентрализация", "DAO", "крипто"],
  "образование": ["EdTech", "онлайн-курсы", "AI-репетиторы", "микро-обучение"],
  "здоровье": ["HealthTech", "mental health", "биохакинг", "AI-диагностика"],
  "финансы": ["финтех", "дефи", "AI-трейдинг", "open-banking"],
  "игры": ["геймдев", "AI-NPC", "мобильные игры", "инди"],
};

const DEFAULT_TOPICS = ["AI-инструменты", "no-code", "SaaS-маркетинг", "контент-маркетинг", "open source"];

function probeTopics(niche) {
  const lower = niche.toLowerCase();
  const scored = new Map();
  for (const [keyword, topics] of Object.entries(TOPIC_MAP)) {
    if (lower.includes(keyword)) {
      for (const t of topics) scored.set(t, (scored.get(t) || 0) + 1);
    }
  }
  const sorted = [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const result = sorted.slice(0, 7);
  for (const t of DEFAULT_TOPICS) {
    if (result.length >= 7) break;
    if (!result.includes(t)) result.push(t);
  }
  return result.slice(0, 7);
}

// ===== TrendQueue =====
const SOURCE_MAP = {
  "AI-инструменты": ["artificial", "MachineLearning"],
  "LLM": ["LocalLLaMA", "OpenAI"],
  "автономные агенты": ["AutoGPT", "artificial"],
  "RAG": ["MachineLearning", "artificial"],
  "модели-Reasoning": ["MachineLearning", "artificial"],
  "no-code": ["NoCode", "webdev"],
  "SaaS-маркетинг": ["SaaS", "marketing"],
  "e-commerce": ["ecommerce", "smallbusiness"],
  "контент-маркетинг": ["marketing", "content_marketing"],
  "продуктовые метрики": ["ProductManagement", "SaaS"],
  "open source": ["opensource", "github"],
  "дизайн": ["design", "userexperience"],
  "growth-hacking": ["growthhacking", "SaaS"],
  "фандрайзинг": ["venturecapital", "startups"],
  "крипто": ["CryptoCurrency", "defi"],
  "Web3": ["web3", "CryptoCurrency"],
  "геймдев": ["gamedev", "indiegaming"],
  "HealthTech": ["health", "bioinformatics"],
  "финтех": ["fintech", "personalfinance"],
};

async function fetchReddit(subreddit) {
  try {
    const res = await fetch(`https://www.reddit.com/r/${subreddit}/hot/.json?limit=5`, {
      headers: { "User-Agent": "scout-agent/0.4" }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data?.children || []).map((c) => ({
      title: c.data.title,
      url: "https://reddit.com" + c.data.permalink,
      source: "reddit/r/" + subreddit,
      score: c.data.score || 0,
      fetchedAt: new Date().toISOString(),
    }));
  } catch (e) { return []; }
}

async function fetchHN() {
  try {
    const top = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then((r) => r.json());
    const ids = top.slice(0, 8);
    const items = await Promise.all(ids.map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json())
    ));
    return items.filter(Boolean).map((i) => ({
      title: i.title,
      url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
      source: "hackernews",
      score: i.score || 0,
      fetchedAt: new Date().toISOString(),
    }));
  } catch (e) { return []; }
}

async function collectSignals(topics) {
  const all = [];
  const subs = new Set();
  for (const t of topics) {
    for (const s of (SOURCE_MAP[t] || [])) subs.add(s);
  }
  for (const s of subs) { const posts = await fetchReddit(s); all.push(...posts); }
  const hn = await fetchHN();
  all.push(...hn);
  return all.sort((a, b) => b.score - a.score);
}

// ===== LLM Classification =====
async function classifyWithLLM(signals, topics, niche) {
  if (!OPENAI_KEY) return null;
  const signalText = signals.slice(0, 25).map((s, i) =>
    `${i + 1}. "${s.title}" [${s.source}, score:${s.score}]`
  ).join("\n");

  const prompt = `Ты — персональный тренд-аналитик для ниши: "${niche}".
Темы наблюдения: ${topics.join(", ")}.

Вот сигналы из интернета (title, source, score):
${signalText}

Задача:
1. Выбери максимум 3 сигнала в каждую категорию:
   - rising: горячие тренды, явно вирусное или score > 200, релевантно ниши
   - growing: развивающиеся тренды (score 50–200), потенциал роста
   - noise: не релевантно ниши или слишком низкий score
2. Дай 1 конкретную action-рекомендацию (что делать автору с этим трендом).

Ответ строго в JSON без Markdown:
{
  "rising": [{"title":"...","url":"...","source":"...","score":123,"why":"почему rising"}],
  "growing": [...],
  "noise": [...],
  "action": "строка-рекомендация"
}`;

  try {
    console.log("[llm] calling via https, model:", OPENAI_MODEL);
    const parsed = await callLLM(OPENAI_KEY, OPENAI_MODEL, prompt);
    console.log("[llm] parsed OK, rising:", parsed.rising?.length, "growing:", parsed.growing?.length);
    return {
      rising: parsed.rising || [],
      growing: parsed.growing || [],
      noise: parsed.noise || [],
      action: parsed.action || "Продолжайте наблюдение.",
    };
  } catch (e) {
    console.error("[llm] classify error:", e.message);
    return null;
  }
}

function classifyKeywords(signals, topics) {
  const rising = [], growing = [], noise = [];
  for (const s of signals.slice(0, 20)) {
    const lower = s.title.toLowerCase();
    const relevant = topics.some((t) => lower.includes(t.toLowerCase().split(/[-\s]/)[0]));
    if (!relevant) { noise.push(s); continue; }
    if (s.score > 200) rising.push(s);
    else if (s.score > 50) growing.push(s);
    else noise.push(s);
  }
  return {
    rising: rising.slice(0, 3).map((s) => ({ ...s, why: "score > 200" })),
    growing: growing.slice(0, 3).map((s) => ({ ...s, why: "score 50–200" })),
    noise: noise.slice(0, 3).map((s) => ({ ...s, why: "низкая релевантность" })),
    action: `Обнаружено ${signals.length} сигналов. Топ: «${signals[0]?.title || "—"}» (${signals[0]?.source || ""}, score ${signals[0]?.score || 0}).`,
  };
}

// ===== API =====
app.post("/probe", (req, res) => {
  const { niche } = req.body || {};
  if (!niche || typeof niche !== "string" || niche.trim().length < 3) {
    return res.status(400).json({ error: "niche required (min 3 chars)" });
  }
  res.json({ topics: probeTopics(niche.trim()), niche: niche.trim(), source: "keyword-v0" });
});

app.post("/digest", async (req, res) => {
  const { topics, niche } = req.body || {};
  if (!Array.isArray(topics) || topics.length === 0) {
    return res.status(400).json({ error: "topics array required" });
  }
  const signals = await collectSignals(topics);
  let classified = await classifyWithLLM(signals, topics, niche || "моя ниша");
  const usedLLM = !!classified;
  if (!classified) classified = classifyKeywords(signals, topics);

  res.json({
    id: `digest-${Date.now()}`,
    createdAt: new Date().toISOString(),
    sections: classified,
    meta: { signalsFound: signals.length, sources: [...new Set(signals.map((s) => s.source))], llm: usedLLM },
  });
});

app.get("/health", (_req, res) => res.json({
  ok: true, version: "0.4.0", llm: !!OPENAI_KEY, model: OPENAI_MODEL,
}));

app.listen(PORT, () => console.log(`[scout-server] http://localhost:${PORT}  llm=${!!OPENAI_KEY}  model=${OPENAI_MODEL}`));
