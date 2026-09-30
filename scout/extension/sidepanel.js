const API_BASE = "http://127.0.0.1:3456";

const SUGGESTED_TOPICS = [
  "AI-инструменты", "no-code", "SaaS-маркетинг", "e-commerce",
  "контент-маркетинг", "продуктовые метрики", "open source", "дизайн",
];
let selectedTopics = new Set();
let probedTopics = [];

function go(id) {
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function renderChips() {
  const box = document.getElementById("chips");
  if (!box) return;
  box.innerHTML = "";
  const source = probedTopics.length ? probedTopics : SUGGESTED_TOPICS;
  for (const t of source) {
    const el = document.createElement("button");
    el.className = "chip" + (selectedTopics.has(t) ? " on" : "");
    el.textContent = t;
    el.onclick = () => { selectedTopics.has(t) ? selectedTopics.delete(t) : selectedTopics.add(t); renderChips(); };
    box.appendChild(el);
  }
}

async function probeNiche() {
  const niche = document.getElementById("niche").value.trim();
  const hint = document.getElementById("probeHint");
  if (!niche) { hint.className = "hint err"; hint.textContent = "Сначала опишите нишу"; return; }
  hint.className = "hint"; hint.textContent = "Подбираю темы...";
  try {
    const res = await fetch(API_BASE + "/probe", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Scout-Client": "1" },
      body: JSON.stringify({ niche }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!Array.isArray(data.topics) || data.topics.length > 7 ||
        data.topics.some(t => typeof t !== "string" || !t || t.length > 100)) throw new Error("Invalid topics");
    probedTopics = data.topics;
    selectedTopics = new Set(probedTopics.slice(0, 5));
    renderChips();
    hint.className = "hint"; hint.textContent = "Найдено " + probedTopics.length + " тем — выбрано топ-5. Можно отредактировать.";
    go("step2");
  } catch (e) {
    hint.className = "hint err"; hint.textContent = "Сервер недоступен (npm start в scout/server). Загружены темы по умолчанию.";
    probedTopics = [];
    selectedTopics = new Set(SUGGESTED_TOPICS.slice(0, 3));
    renderChips();
    go("step2");
  }
}

async function finishOnboarding() {
  const niche = document.getElementById("niche").value.trim();
  if (!niche) { document.getElementById("niche").focus(); return; }
  try {
    await storage.saveProfile({
      niche, topics: [...selectedTopics],
      frequency: document.getElementById("frequency").value,
      quietHours: { from: document.getElementById("quietFrom").value, to: document.getElementById("quietTo").value },
    });
  } catch (error) {
    document.getElementById("profileError").textContent = error.message;
    return;
  }
  document.getElementById("profileError").textContent = "";
  await renderDigest();
}

async function requestDigest() {
  const btn = document.querySelector('[data-action="generate"]');
  const oldText = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "Генерирую..."; btn.disabled = true; }
  try {
    const result = await chrome.runtime.sendMessage({ type: "SCOUT_GENERATE_NOW", force: true });
    await renderDigest();
    if (!result?.ok) document.getElementById("digestStatus").textContent =
      result?.reason === "busy" ? "Генерация уже выполняется. Попробуйте позже." : "Дайджест не обновлён. Проверьте настройки и сервер.";
  } catch (e) {
    document.getElementById("digestStatus").textContent = "Не удалось связаться с расширением. Откройте панель заново.";
  } finally {
    if (btn) { btn.textContent = oldText; btn.disabled = false; }
  }
}

const TAGS = {
  rising: ["🔺 Новое", "rising"],
  growing: ["📈 Развивается", "growing"],
  noise: ["🔕 Шум", "noise"],
  action: ["💡 Действие", "action"],
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function renderDigest() {
  const profile = await storage.getProfile();
  if (!profile.onboarded) { renderChips(); go("step1"); return; }
  const { digests, lastError, notificationError } = await chrome.storage.local.get(["digests", "lastError", "notificationError"]);
  document.getElementById("digestStatus").textContent = lastError || notificationError || "";
  const box = document.getElementById("digestContent");
  go("digest");
  if (!digests || !digests.length) {
    box.innerHTML = '<p class="empty">Дайджестов пока нет — нажми «Проверить сейчас».</p>';
    return;
  }
  const d = digests[0];
  box.innerHTML = '<p class="meta">Последний: ' + new Date(d.createdAt).toLocaleString("ru-RU") +
    ' · ниша: ' + escapeHtml(d.profile?.niche || "профиль старого дайджеста не сохранён") + '</p>';
  for (const [key, [title, cls]] of Object.entries(TAGS)) {
    const items = d.sections[key] || [];
    const sec = document.createElement("div");
    sec.className = "section";
    sec.innerHTML = '<span class="tag ' + cls + '">' + title + '</span>';
    if (key === "action") {
      const text = typeof items === "string" ? items : (items[0] ? items[0].title : "—");
      sec.innerHTML += '<div class="card"><p>' + escapeHtml(text) + '</p></div>';
    } else {
      for (const it of items) {
        const href = safeHttpUrl(it.url);
        const url = href ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer" style="color:#4a7dff;text-decoration:none">↗</a> ' : "";
        const why = it.why || (it.source ? it.source + (it.score ? " · score: " + it.score : "") : "");
        sec.innerHTML += '<div class="card"><h3>' + url + escapeHtml(it.title) + '</h3><p>' + escapeHtml(why) + '</p></div>';
      }
    }
    box.appendChild(sec);
  }
}

async function resetOnboarding() {
  const profile = await storage.getProfile();
  document.getElementById("niche").value = profile.niche;
  document.getElementById("frequency").value = profile.frequency;
  document.getElementById("quietFrom").value = profile.quietHours.from;
  document.getElementById("quietTo").value = profile.quietHours.to;
  selectedTopics = new Set(profile.topics);
  probedTopics = profile.topics || [];
  renderChips(); go("step1");
}

// === инициализация обработчиков ===
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "go") go(btn.dataset.target);
  else if (action === "finish") finishOnboarding();
  else if (action === "generate") requestDigest();
  else if (action === "reset") resetOnboarding();
  else if (action === "probe") probeNiche();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["digests", "lastError", "notificationError"].some(key => changes[key])) {
    renderDigest().catch(() => {});
  }
});
renderDigest().catch(() => {});
