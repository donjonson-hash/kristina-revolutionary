/**
 * NicheStore — классический скрипт для side panel.
 * Background дублирует эту логику inline (ES-модуль не совместим с classic script).
 */
const DEFAULT_PROFILE = {
  niche: "",
  topics: [],
  frequency: "daily",
  quietHours: { from: "22:00", to: "08:00" },
  onboarded: false,
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
