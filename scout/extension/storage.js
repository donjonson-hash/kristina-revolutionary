/**
 * NicheStore — профиль ниши и состояние в chrome.storage.local.
 * Неделя 1: только структура и обёртки; сбор сигналов — неделя 3.
 */
const DEFAULT_PROFILE = {
  niche: "",            // свободный текст: кто пользователь, что продаёт/публикует
  topics: [],           // 3–5 тем для наблюдения
  frequency: "daily",   // daily | every_3_days
  quietHours: { from: "22:00", to: "08:00" },
  onboarded: false,
};

const DEFAULT_CLAIM = {
  active: false,
  claimedAt: null,
  kind: null,           // "digest"
};

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
  /** Заявка на проактивность — singleton, как в dialogue-модели Кристины.
   *  true = заявка взята, false = уже занято или блокировка. */
  async tryClaim(kind) {
    const claim = await this.getClaim();
    if (claim.active) return false;
    await chrome.storage.local.set({
      claim: { active: true, claimedAt: Date.now(), kind },
    });
    return true;
  },
  async releaseClaim() {
    await chrome.storage.local.set({ claim: DEFAULT_CLAIM });
  },
};

// Экспорт для тестов в node (в расширении не используется)
if (typeof module !== "undefined") {
  module.exports = { DEFAULT_PROFILE, DEFAULT_CLAIM };
}
