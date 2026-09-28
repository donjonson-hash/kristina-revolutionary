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
  function create(report, side = 'right') {
    if (!['left', 'right'].includes(side)) throw new Error('Неизвестная сторона документа.');
    const otherSide = side === 'right' ? 'left' : 'right';
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
    const canonical = clone(sources[otherSide]), original = clone(sources[side]);
    const hasTables = report.sources?.[side]?.format === 'docx' && categories.some(category => (report[category] || []).some(item => {
      const block = item[side] || (category === `only_${side}` ? item.row : null);
      return (block?.source_blocks || [block]).some(part => part?.table);
    }));
    function validateTableEntries(entries) {
      if (hasTables && (entries.length !== original.length || entries.some((entry, i) => entry.record !== original[i].record))) throw new Error('В документе с таблицами пока можно менять текст в существующих абзацах и ячейках. Добавление, удаление и перенос абзацев, строк и столбцов пока недоступны.');
    }
    const ranks = new Map(canonical.map(entry => [entry.key, groups.get(entry.key)[otherSide][0].record]));
    let draft = clone(original), history = [], coalesce = null, revision = 0;
    const signature = entries => JSON.stringify(entries);
    function commit(next, typingKey = null) {
      validateTableEntries(next);
      if (text(next).length > MAX_CHARS) throw new Error('Редакция слишком велика: максимум 500 000 символов.');
      if (!typingKey) coalesce = null;
      if (signature(next) === signature(draft)) return;
      if (!typingKey || coalesce !== typingKey) history.push(clone(draft));
      while (history.length > 20 || history.reduce((size, entries) => size + text(entries).length, 0) > HISTORY_CHARS) history.shift();
      draft = next; coalesce = typingKey; revision++;
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
        // Anchor by the opposite source coordinates, never by the report's display order.
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
    function valueEntry(key, value, index = 0) {
      const group = groupFor(key);
      if (typeof value !== 'string') throw new Error('Текст фрагмента должен быть строкой.');
      return {key, record: group[side][index]?.record, text: value.replace(/\r\n?/g, '\n')};
    }
    function targetEntries(entries) {
      if (!Array.isArray(entries)) throw new Error('Нужен список фрагментов документа.');
      const positions = new Map();
      return entries.map(entry => {
        if (!entry || typeof entry !== 'object') throw new Error('Некорректный фрагмент документа.');
        const index = positions.get(entry.key) || 0;
        positions.set(entry.key, index + 1);
        return valueEntry(entry.key, entry.text, index);
      });
    }
    function validatedEntries(entries) {
      const fail = () => { throw new Error('Сохранённая редакция повреждена.'); };
      if (!Array.isArray(entries) || entries.length > sources.left.length + sources.right.length) fail();
      const positions = new Map(), completed = new Set(); let previous;
      const result = entries.map(entry => {
        if (!entry || typeof entry !== 'object' || !groups.has(entry.key) || typeof entry.text !== 'string' || /\r/.test(entry.text)) fail();
        const group = groups.get(entry.key), index = positions.get(entry.key) || 0;
        // A group can move, but its own source blocks cannot be shuffled or borrowed
        // from the other document. New blocks deliberately have no source record.
        if (previous !== entry.key) { if (completed.has(entry.key)) fail(); if (previous !== undefined) completed.add(previous); }
        previous = entry.key;
        if (index >= Math.max(group.left.length, group.right.length) || entry.record !== group[side][index]?.record) fail();
        positions.set(entry.key, index + 1);
        return {key: entry.key, record: entry.record, text: entry.text};
      });
      if (text(result).length > MAX_CHARS) fail();
      validateTableEntries(result);
      return result;
    }
    return {
      snapshot: () => ({version: 1, side, entries: clone(draft), history: history.map(clone)}),
      restore(snapshot) {
        if (!snapshot || snapshot.version !== 1 || snapshot.side !== side || !Array.isArray(snapshot.history) || snapshot.history.length > 20) throw new Error('Сохранённая редакция повреждена.');
        const next = validatedEntries(snapshot.entries), undo = snapshot.history.map(validatedEntries);
        if (undo.reduce((size, entries) => size + text(entries).length, 0) > HISTORY_CHARS) throw new Error('Сохранённая редакция повреждена.');
        draft = next; history = undo; coalesce = null; revision++;
      },
      get revision() { return revision; },
      entries: () => clone(draft),
      text: () => text(draft),
      // TXT's final LF closes the last block; it preserves a final empty block on re-import.
      exportText: () => draft.length ? text(draft) + '\n' : '',
      canonicalText: () => text(canonical),
      get(key) { groupFor(key); const entries = draft.filter(entry => entry.key === key); return entries.length ? text(entries) : null; },
      apply(key) { const group = groupFor(key); replace(key, targetEntries(group[otherSide]), group.category === 'moved'); },
      set(key, value, {relocate = false} = {}) {
        replace(key, value === null ? [] : [valueEntry(key, value)], relocate);
      },
      replaceAll(entries) { commit(targetEntries(entries)); },
      edit(key, value) {
        replace(key, [valueEntry(key, String(value))], false, key);
      },
      endEdit() { coalesce = null; },
      applyAll() { commit(targetEntries(canonical)); },
      reset() { commit(clone(original)); },
      undo() { if (history.length) { draft = history.pop(); revision++; } coalesce = null; },
      get canUndo() { return history.length > 0; },
      get changed() { return signature(draft) !== signature(original); },
      get matchesCanonical() { return text(draft) === text(canonical); },
    };
  }
  return {create};
});
