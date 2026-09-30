// Shared classic script: loaded by the panel and importScripts in the worker.
const DEFAULT_PROFILE = {
  niche: "", topics: [], frequency: "daily",
  quietHours: { from: "22:00", to: "08:00" }, onboarded: false,
};
function validProfile(profile) {
  const time = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  return typeof profile?.niche === "string" && profile.niche.trim().length >= 3 && profile.niche.length <= 500 &&
    Array.isArray(profile.topics) && profile.topics.length > 0 && profile.topics.length <= 7 &&
    profile.topics.every(t => typeof t === "string" && t.trim() && t.length <= 100 &&
      !["constructor", "__proto__", "prototype"].includes(t.trim())) &&
    ["daily", "every_3_days"].includes(profile.frequency) &&
    time(profile.quietHours?.from) && time(profile.quietHours?.to);
}
function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const storage = {
  async getProfile() {
    const { profile } = await chrome.storage.local.get("profile");
    return { ...DEFAULT_PROFILE, ...(profile || {}) };
  },
  async saveProfile(patch) {
    const profile = { ...(await this.getProfile()), ...patch, onboarded: true };
    if (!validProfile(profile)) throw new Error("Укажите нишу от 3 до 500 символов, 1–7 тем и корректное время.");
    await chrome.storage.local.set({ profile });
    return profile;
  },
};
