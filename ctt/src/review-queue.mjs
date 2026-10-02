// Decisions describe exact current content. Editing a reviewed item reopens it.
export function createReviewQueue(initialKeys = [], saved) {
  const tasks = new Map(initialKeys.map(key => [key, null]));
  let current = new Map();
  if (saved !== undefined) {
    if (!saved || saved.version !== 1 || typeof saved.started !== 'boolean' || !Array.isArray(saved.items) || saved.items.length > 1000000) throw new Error("Couldn't restore review progress.");
    const seen = new Set();
    for (const item of saved.items) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || item[0].length > 200 || seen.has(item[0]) || item[1] !== null && (typeof item[1] !== 'string' || item[1].length > 4000000)) throw new Error("Couldn't restore review progress.");
      seen.add(item[0]); tasks.set(item[0], item[1]);
    }
  }
  const reviewed = key => current.has(key) && (!current.get(key).differs || tasks.get(key) === current.get(key).signature);
  return {
    sync(items) {
      current = new Map(items.map(item => [item.key, item]));
      for (const key of tasks.keys()) if (!current.has(key)) tasks.delete(key);
      for (const item of items) {
        if (item.differs && !tasks.has(item.key)) tasks.set(item.key, null);
        if (tasks.get(item.key) != null && tasks.get(item.key) !== item.signature) tasks.set(item.key, null);
      }
    },
    accept(key) { if (!tasks.has(key) || !current.has(key)) return false; tasks.set(key, current.get(key).signature); return true; },
    reopen(key) { if (tasks.has(key)) tasks.set(key, null); },
    reset() { for (const key of tasks.keys()) tasks.set(key, null); },
    has: key => tasks.has(key),
    reviewed,
    pending() { return [...current.keys()].filter(key => tasks.has(key) && !reviewed(key)); },
    next(after) { const keys = [...current.keys()], pending = this.pending(), index = keys.indexOf(after); return pending.find(key => keys.indexOf(key) > index) ?? pending[0] ?? null; },
    progress() { const total = tasks.size, pending = this.pending().length; return {total, reviewed: total - pending, pending}; },
    snapshot(started) { return {version: 1, started, items: [...tasks]}; }
  };
}
