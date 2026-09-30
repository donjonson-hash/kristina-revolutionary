const DEFAULT_PROFILE = {
  niche: "", topics: [], frequency: "daily",
  quietHours: { from: "22:00", to: "08:00" }, onboarded: false,
};
const DEFAULT_CLAIM = { active: false, claimedAt: null, kind: null };

const storage = {
  async getProfile() {
    const { profile } = await chrome.storage.local.get("profile");
    return { ...DEFAULT_PROFILE, ...(profile || {}) };
  },
  async saveProfile(patch) {
    const profile = { ...(await this.getProfile()), ...patch, onboarded: true };
    await chrome.storage.local.set({ profile });
    return profile;
  },
  async getClaim() {
    const { claim } = await chrome.storage.local.get("claim");
    return { ...DEFAULT_CLAIM, ...(claim || {}) };
  },
  async tryClaim(kind) {
    const claim = await this.getClaim();
    if (claim.active) return false;
    await chrome.storage.local.set({ claim: { active: true, claimedAt: Date.now(), kind } });
    return true;
  },
  async releaseClaim() {
    await chrome.storage.local.set({ claim: DEFAULT_CLAIM });
  },
};

const DIGEST_ALARM = "scout-digest";
const COOLDOWN_MS = 12 * 60 * 60 * 1000;
const API_BASE = "http://localhost:3456";

function inQuietHours(quietHours, now = new Date()) {
  const [fromH, fromM] = quietHours.from.split(":").map(Number);
  const [toH, toM] = quietHours.to.split(":").map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  return from > to ? cur >= from || cur < to : cur >= from && cur < to;
}

async function fetchDigest(profile) {
  try {
    const res = await fetch(API_BASE + "/digest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: profile.topics, niche: profile.niche }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.error("[scout] /digest error:", e.message);
    return null;
  }
}

async function maybeGenerateDigest(force = false) {
  const profile = await storage.getProfile();
  if (!profile.onboarded) return;
  if (!force && inQuietHours(profile.quietHours)) { console.log("[scout] quiet hours — skip"); return; }

  const { lastDigestAt } = await chrome.storage.local.get("lastDigestAt");
  if (!force && lastDigestAt && Date.now() - lastDigestAt < COOLDOWN_MS) { console.log("[scout] cooldown — skip"); return; }

  if (!(await storage.tryClaim("digest"))) { console.log("[scout] claim busy"); return; }
  try {
    let digest = await fetchDigest(profile);
    if (!digest) {
      digest = {
        id: `digest-${Date.now()}`, createdAt: new Date().toISOString(),
        sections: {
          rising: [{ title: "Сервер недоступен", why: "запустите npm start в scout/server" }],
          growing: [], noise: [],
          action: "Подключите сервер на localhost:3456",
        },
      };
    }
    const digests = (await chrome.storage.local.get("digests")).digests || [];
    digests.unshift(digest);
    await chrome.storage.local.set({ digests: digests.slice(0, 30), lastDigestAt: Date.now() });
    await storage.releaseClaim();
    chrome.notifications?.create({ type: "basic", title: "Scout: digest ready", message: "Open the panel to see it." });
    console.log("[scout] digest generated", digest.meta ? "(live)" : "(fallback)");
  } catch (e) { await storage.releaseClaim(); console.error("[scout] error:", e); }
}

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
  catch (e) { console.warn("[scout] setPanelBehavior:", e.message); }
  await chrome.storage.local.set({ claim: DEFAULT_CLAIM });
  await chrome.alarms.create(DIGEST_ALARM, { periodInMinutes: 24 * 60 });
  console.log("[scout] installed v0.3.1");
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === DIGEST_ALARM) maybeGenerateDigest(); });
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === "SCOUT_GENERATE_NOW") {
    maybeGenerateDigest(msg.force === true).then(() => sendResponse({ ok: true }));
    return true;
  }
});
