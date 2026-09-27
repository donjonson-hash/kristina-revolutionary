/**
 * Service Worker Scout — проактивность по правилам dialogue-модели:
 * cooldown 12ч между дайджестами, quiet hours, singleton-claim.
 * Неделя 1: каркас — дайджест пока заглушка, генерация (бэкенд) — неделя 4.
 */

const DIGEST_ALARM = "scout-digest";
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 часов между дайджестами

function inQuietHours(quietHours, now = new Date()) {
  const [fromH, fromM] = quietHours.from.split(":").map(Number);
  const [toH, toM] = quietHours.to.split(":").map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  // интервал может переходить через полночь (22:00 → 08:00)
  return from > to ? cur >= from || cur < to : cur >= from && cur < to;
}

async function maybeGenerateDigest() {
  const profile = await storage.getProfile();
  if (!profile.onboarded) return;

  if (inQuietHours(profile.quietHours)) {
    console.log("[scout] quiet hours — пропускаю");
    return;
  }

  const { lastDigestAt } = await chrome.storage.local.get("lastDigestAt");
  if (lastDigestAt && Date.now() - lastDigestAt < COOLDOWN_MS) {
    console.log("[scout] cooldown ещё не истёк");
    return;
  }

  // claim → generate → mark sent (паттерн dialogue_state.py)
  if (!(await storage.tryClaim("digest"))) {
    console.log("[scout] claim занят — другой цикл уже работает");
    return;
  }
  try {
    // Неделя 4: здесь fetch к бэкенду /digest с профилем ниши
    const digest = {
      id: `digest-${Date.now()}`,
      createdAt: new Date().toISOString(),
      sections: {
        rising: [{ title: "Сигнал #1 (заглушка)", why: "пока без бэкенда" }],
        growing: [],
        noise: [],
        action: "Подключи бэкенд на неделе 4 — здесь будет рекомендация.",
      },
    };
    const digests = (await chrome.storage.local.get("digests")).digests || [];
    digests.unshift(digest);
    await chrome.storage.local.set({ digests: digests.slice(0, 30), lastDigestAt: Date.now() });
    await storage.releaseClaim();

    chrome.notifications?.create({
      type: "basic",
      title: "Scout: дайджест по вашей нише готов",
      message: "Откройте панель, чтобы посмотреть.",
    });
    console.log("[scout] дайджест сгенерирован (заглушка)");
  } catch (e) {
    await storage.releaseClaim();
    console.error("[scout] ошибка генерации:", e);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ claim: { active: false, claimedAt: null, kind: null } });
  // ежедневная проверка; точное время суток учитываем в maybeGenerateDigest
  await chrome.alarms.create(DIGEST_ALARM, { periodInMinutes: 24 * 60 });
  console.log("[scout] installed, alarm создан");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DIGEST_ALARM) maybeGenerateDigest();
});

// Ручной триггер из панели (кнопка «Проверить сейчас»)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCOUT_GENERATE_NOW") {
    maybeGenerateDigest().then(() => sendResponse({ ok: true }));
    return true; // async sendResponse
  }
});
