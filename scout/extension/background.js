importScripts("storage.js");

const API_BASE = "http://127.0.0.1:3456";
const DIGEST_ALARM = "scout-digest";
const LEASE_MS = 35000;
let activeRun = null;

function intervalMs(profile) {
  return (profile.frequency === "every_3_days" ? 3 : 1) * 24 * 60 * 60 * 1000;
}

function afterQuietHours(profile, timestamp) {
  const date = new Date(timestamp);
  const [fh, fm] = profile.quietHours.from.split(":").map(Number);
  const [th, tm] = profile.quietHours.to.split(":").map(Number);
  const from = fh * 60 + fm, to = th * 60 + tm, current = date.getHours() * 60 + date.getMinutes();
  const quiet = from > to ? current >= from || current < to : current >= from && current < to;
  if (quiet) {
    if (from > to && current >= from) date.setDate(date.getDate() + 1);
    date.setHours(th, tm, 0, 0);
  }
  return date.getTime();
}

function leaseExpiry(claim) {
  return Number.isFinite(claim?.expiresAt) ? claim.expiresAt :
    Number.isFinite(claim?.claimedAt) ? claim.claimedAt + LEASE_MS : 0;
}

async function scheduleNext() {
  const profile = await storage.getProfile();
  if (!profile.onboarded || !validProfile(profile)) {
    await chrome.alarms.clear(DIGEST_ALARM);
    return;
  }
  const state = await chrome.storage.local.get(["lastDigestAt", "retryAt", "claim"]);
  let due = state.retryAt || (state.lastDigestAt ? state.lastDigestAt + intervalMs(profile) : Date.now());
  if (state.claim?.active) due = Math.max(due, leaseExpiry(state.claim));
  due = afterQuietHours(profile, Math.max(Date.now() + 30000, due));
  await chrome.alarms.create(DIGEST_ALARM, { when: due });
}

function validDigest(digest) {
  if (!digest || typeof digest.id !== "string" || !Number.isFinite(Date.parse(digest.createdAt)) ||
      !["complete", "no_data"].includes(digest.meta?.status) ||
      !Number.isSafeInteger(digest.meta.signalsFound) || digest.meta.signalsFound < 0 ||
      typeof digest.sections?.action !== "string" || digest.sections.action.length > 1200) return false;
  return ["rising", "growing", "noise"].every(key =>
    Array.isArray(digest.sections[key]) && digest.sections[key].length <= 3 &&
    digest.sections[key].every(item => item && typeof item.title === "string" &&
      item.title.length <= 1000 && safeHttpUrl(item.url) &&
      typeof item.why === "string" && item.why.length <= 500));
}

async function generateDigest(force) {
  const profile = await storage.getProfile();
  if (!profile.onboarded || !validProfile(profile)) return { ok: false, reason: "profile_required" };
  const state = await chrome.storage.local.get(["lastDigestAt", "retryAt", "claim", "failureCount"]);
  const now = Date.now();
  if (!force && afterQuietHours(profile, now) !== now) return { ok: false, reason: "quiet_hours" };
  if (!force && ((state.retryAt && state.retryAt > now) ||
      (!state.retryAt && state.lastDigestAt && now - state.lastDigestAt < intervalMs(profile)))) {
    return { ok: false, reason: "not_due" };
  }
  if (state.claim?.active && leaseExpiry(state.claim) > now) return { ok: false, reason: "busy" };

  const token = crypto.randomUUID();
  await chrome.storage.local.set({ claim: { active: true, token, claimedAt: now, expiresAt: now + LEASE_MS } });
  try {
    const response = await fetch(API_BASE + "/digest", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Scout-Client": "1" },
      body: JSON.stringify({ topics: profile.topics, niche: profile.niche }),
      signal: AbortSignal.timeout(26000),
    });
    if (!response.ok) throw new Error("backend_error");
    const text = await response.text();
    if (text.length > 64000) throw new Error("invalid_digest");
    const digest = JSON.parse(text);
    if (!validDigest(digest)) throw new Error("invalid_digest");
    const current = await chrome.storage.local.get(["claim", "digests"]);
    if (current.claim?.token !== token || JSON.stringify(await storage.getProfile()) !== JSON.stringify(profile)) {
      return { ok: false, reason: "profile_changed" };
    }
    // Only validated successful results advance lastDigestAt. Errors keep the old digest.
    await chrome.storage.local.set({
      digests: [{ ...digest, profile: { niche: profile.niche, topics: profile.topics } },
        ...(Array.isArray(current.digests) ? current.digests : [])].slice(0, 30),
      lastDigestAt: Date.now(), lastError: null, retryAt: null, failureCount: 0, notificationError: null,
    });
    if (digest.meta.signalsFound > 0) {
      try {
        await chrome.notifications.create({
          type: "basic", iconUrl: chrome.runtime.getURL("icon.png"),
          title: "Scout: дайджест готов", message: "Откройте панель, чтобы посмотреть.",
        });
      } catch {
        await chrome.storage.local.set({ notificationError: "Дайджест сохранён, но уведомление не доставлено." });
      }
    }
    return { ok: true };
  } catch {
    const failureCount = Math.min(6, (Number(state.failureCount) || 0) + 1);
    await chrome.storage.local.set({
      lastError: "Не удалось получить дайджест. Последний успешный результат сохранён.",
      failureCount, retryAt: Date.now() + Math.min(60, 5 * 2 ** (failureCount - 1)) * 60000,
    });
    return { ok: false, reason: "backend_error" };
  } finally {
    const { claim } = await chrome.storage.local.get("claim");
    if (claim?.token === token) await chrome.storage.local.set({ claim: null });
  }
}

function maybeGenerateDigest(force = false) {
  // Acquire synchronously, before the first await. There is one generation owner per worker.
  if (activeRun) return Promise.resolve({ ok: false, reason: "busy" });
  activeRun = generateDigest(force).catch(() => ({ ok: false, reason: "storage_error" }))
    .finally(async () => {
      activeRun = null;
      await scheduleNext().catch(() => {});
    });
  return activeRun;
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await scheduleNext().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { scheduleNext().catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.profile) {
    chrome.storage.local.set({ lastDigestAt: null, retryAt: null, failureCount: 0 })
      .then(scheduleNext).catch(() => {});
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === DIGEST_ALARM) maybeGenerateDigest();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SCOUT_GENERATE_NOW") {
    maybeGenerateDigest(message.force === true).then(sendResponse);
    return true;
  }
});
