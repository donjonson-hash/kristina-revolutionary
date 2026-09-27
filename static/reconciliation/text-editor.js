/* A separate, in-memory text revision. Source comparison reports stay immutable. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KristinaTextEditor = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const categories = ['changed', 'only_left', 'only_right', 'matched', 'moved', 'reflow'];
  const MAX_CHARS = 500000, HISTORY_CHARS = 2000000;
  const clone = entries => entries.map(entry => ({...entry}));
  const text = entries => entries.map(entry => entry.text).join('\n');
  function create(report) {
    if (report.kind !== 'text' || report.status !== 'complete') throw new Error('Нужна завершённая проверка текста.');
    const groups = new Map(), sources = {left: [], right: []};
    for (const category of categories) for (const item of report[category] || []) {
      const group = {key: item.key, category, left: [], right: []};
      for (const side of ['left', 'right']) {
        const row = item[side] || (category === `only_${side}` ? item.row : null);
        group[side] = (row ? row.source_blocks || [row] : []).map(block => ({key: item.key, record: block.record, text: block.text}));
        sources[side].push(...group[side]);
      }
      groups.set(item.key, group);
    }
    for (const side of ['left', 'right']) sources[side].sort((a, b) => a.record - b.record);
    const canonical = clone(sources.left), original = clone(sources.right);
    const ranks = new Map(canonical.map(entry => [entry.key, groups.get(entry.key).left[0].record]));
    let draft = clone(original), history = [], coalesce = null;
    const signature = entries => JSON.stringify(entries);
    function commit(next, typingKey = null) {
      if (text(next).length > MAX_CHARS) throw new Error('Редакция слишком велика: максимум 500 000 символов.');
      if (signature(next) === signature(draft)) return;
      if (!typingKey || coalesce !== typingKey) history.push(clone(draft));
      while (history.length > 20 || history.reduce((size, entries) => size + text(entries).length, 0) > HISTORY_CHARS) history.shift();
      draft = next; coalesce = typingKey;
    }
    function groupFor(key) {
      const group = groups.get(key);
      if (!group) throw new Error('Фрагмент не найден.');
      return group;
    }
    function replace(key, entries, relocate = false, typingKey = null) {
      groupFor(key);
      const oldIndex = draft.findIndex(entry => entry.key === key);
      const next = draft.filter(entry => entry.key !== key);
      let index = oldIndex;
      if (relocate || index < 0) {
        const rank = ranks.get(key);
        // Anchor by source A coordinates, never by the report's display order.
        const following = canonical.find(entry => ranks.get(entry.key) > rank && next.some(row => row.key === entry.key));
        if (following) index = next.findIndex(entry => entry.key === following.key);
        else {
          const previous = canonical.findLast(entry => ranks.get(entry.key) < rank && next.some(row => row.key === entry.key));
          index = previous ? next.findLastIndex(entry => entry.key === previous.key) + 1 : next.length;
        }
      }
      next.splice(index, 0, ...clone(entries));
      commit(next, typingKey);
    }
    return {
      text: () => text(draft),
      // TXT's final LF closes the last block; it preserves a final empty block on re-import.
      exportText: () => draft.length ? text(draft) + '\n' : '',
      canonicalText: () => text(canonical),
      get(key) { groupFor(key); const entries = draft.filter(entry => entry.key === key); return entries.length ? text(entries) : null; },
      apply(key) { const group = groupFor(key); replace(key, group.left, group.category === 'moved'); },
      edit(key, value) {
        const group = groupFor(key);
        replace(key, [{key, record: group.right[0]?.record ?? group.left[0]?.record, text: String(value).replace(/\r\n?/g, '\n')}], false, key);
      },
      endEdit() { coalesce = null; },
      applyAll() { commit(clone(canonical)); },
      reset() { commit(clone(original)); },
      undo() { if (history.length) draft = history.pop(); coalesce = null; },
      get canUndo() { return history.length > 0; },
      get changed() { return signature(draft) !== signature(original); },
      get matchesCanonical() { return text(draft) === text(canonical); },
    };
  }
  return {create};
});
