/** Логика панели: онбординг → дайджест. */

const SUGGESTED_TOPICS = [
  "AI-инструменты", "no-code", "SaaS-маркетинг", "e-commerce",
  "контент-маркетинг", "продуктовые метрики", "open source", "дизайн",
];

let selectedTopics = new Set();

function go(n) {
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("active"));
  document.getElementById("step" + n).classList.add("active");
}

function renderChips() {
  const box = document.getElementById("chips");
  box.innerHTML = "";
  for (const t of SUGGESTED_TOPICS) {
    const el = document.createElement("button");
    el.className = "chip" + (selectedTopics.has(t) ? " on" : "");
    el.textContent = t;
    el.onclick = () => {
      selectedTopics.has(t) ? selectedTopics.delete(t) : selectedTopics.add(t);
      renderChips();
    };
    box.appendChild(el);
  }
}

async function finishOnboarding() {
  const niche = document.getElementById("niche").value.trim();
  if (!niche) { document.getElementById("niche").focus(); return; }
  await storage.saveProfile({
    niche,
    topics: [...selectedTopics],
    frequency: document.getElementById("frequency").value,
    quietHours: {
      from: document.getElementById("quietFrom").value,
      to: document.getElementById("quietTo").value,
    },
  });
  await renderDigest();
}

async function requestDigest() {
  await chrome.runtime.sendMessage({ type: "SCOUT_GENERATE_NOW" });
  await new Promise((r) => setTimeout(r, 300));
  await renderDigest();
}

const TAGS = {
  rising: ["🔺 Новое", "rising"],
  growing: ["📈 Развивается", "growing"],
  noise: ["🔕 Шум", "noise"],
  action: ["💡 Действие", "action"],
};

async function renderDigest() {
  const profile = await storage.getProfile();
  if (!profile.onboarded) { renderChips(); go(1); return; }

  const { digests } = await chrome.storage.local.get("digests");
  const box = document.getElementById("digestContent");
  go("digest");

  if (!digests || !digests.length) {
    box.innerHTML = '<p class="empty">Дайджестов пока нет — нажми «Проверить сейчас».</p>';
    return;
  }
  const d = digests[0];
  box.innerHTML = `<p class="meta">Последний: ${new Date(d.createdAt).toLocaleString("ru-RU")} · ниша: ${escapeHtml(profile.niche)}</p>`;
  for (const [key, [title, cls]] of Object.entries(TAGS)) {
    const items = d.sections[key] || [];
    const sec = document.createElement("div");
    sec.className = "section";
    sec.innerHTML = `<span class="tag ${cls}">${title}</span>`;
    if (key === "action") {
      sec.innerHTML += `<div class="card"><p>${escapeHtml(items[0]?.title || "—")}</p></div>`;
    } else {
      for (const it of items) {
        sec.innerHTML += `<div class="card"><h3>${escapeHtml(it.title)}</h3><p>${escapeHtml(it.why || "")}</p></div>`;
      }
    }
    box.appendChild(sec);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function resetOnboarding() {
  const profile = await storage.getProfile();
  document.getElementById("niche").value = profile.niche;
  selectedTopics = new Set(profile.topics);
  renderChips();
  go(1);
}

renderDigest();
