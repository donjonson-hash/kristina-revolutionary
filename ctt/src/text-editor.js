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
  const clone = entries => entries.map(entry => ({...entry,...(entry.pdfBox?{pdfBox:{...entry.pdfBox}}:{})}));
  const text = entries => entries.map(entry => entry.text).join('\n');
  function create(report, side = 'right') {
    if (!['left', 'right'].includes(side)) throw new Error("Unknown document side.");
    const otherSide = side === 'right' ? 'left' : 'right';
    if (report.kind !== 'text' || report.status !== 'complete') throw new Error("A completed text comparison is required.");
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
      if (hasTables && (entries.length !== original.length || entries.some((entry, i) => entry.record !== original[i].record))) throw new Error("In documents with tables, you can currently edit text in existing paragraphs and cells. Adding, deleting, and moving paragraphs, rows, or columns is not yet supported.");
    }
    const ranks = new Map(canonical.map(entry => [entry.key, groups.get(entry.key)[otherSide][0].record]));
    let draft = clone(original), history = [], coalesce = null, revision = 0;
    const signature = entries => JSON.stringify(entries);
    function commit(next, typingKey = null) {
      validateTableEntries(next);
      if (text(next).length > MAX_CHARS) throw new Error("This version is too large: maximum 500,000 characters.");
      if (!typingKey) coalesce = null;
      if (signature(next) === signature(draft)) return;
      if (!typingKey || coalesce !== typingKey) history.push(clone(draft));
      while (history.length > 20 || history.reduce((size, entries) => size + text(entries).length, 0) > HISTORY_CHARS) history.shift();
      draft = next; coalesce = typingKey; revision++;
    }
    function groupFor(key) {
      const group = groups.get(key);
      if (!group) throw new Error("Section not found.");
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
      if (typeof value !== 'string') throw new Error("Section text must be a string.");
      const box=draft.find(entry=>entry.key===key)?.pdfBox;
      return {key, record: group[side][index]?.record, text: value.replace(/\r\n?/g, '\n'),...(box?{pdfBox:{...box}}:{})};
    }
    function targetEntries(entries) {
      if (!Array.isArray(entries)) throw new Error("A list of document sections is required.");
      const positions = new Map();
      return entries.map(entry => {
        if (!entry || typeof entry !== 'object') throw new Error("Invalid document section.");
        const index = positions.get(entry.key) || 0;
        positions.set(entry.key, index + 1);
        const result=valueEntry(entry.key, entry.text, index);delete result.pdfBox;return result;
      });
    }
    function validateBox(key, box) {
      const part=groupFor(key)[side];
      if(report.sources?.[side]?.format!=='pdf'||part.length!==1||!box||!['width','height'].every(k=>Number.isFinite(box[k])&&box[k]>0&&box[k]<=20000)||Object.keys(box).some(k=>!['width','height','fontSize'].includes(k))||box.fontSize!==undefined&&(!Number.isFinite(box.fontSize)||box.fontSize<1||box.fontSize>512))throw new Error('Invalid replacement block.');
      return {width:box.width,height:box.height,...(box.fontSize!==undefined?{fontSize:box.fontSize}:{})};
    }
    function validatedEntries(entries) {
      const fail = () => { throw new Error("The saved version is corrupted."); };
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
        return {key: entry.key, record: entry.record, text: entry.text,...(entry.pdfBox?{pdfBox:validateBox(entry.key,entry.pdfBox)}:{})};
      });
      if (text(result).length > MAX_CHARS) fail();
      validateTableEntries(result);
      return result;
    }
    return {
      snapshot: () => ({version: 1, side, entries: clone(draft), history: history.map(clone)}),
      restore(snapshot) {
        if (!snapshot || snapshot.version !== 1 || snapshot.side !== side || !Array.isArray(snapshot.history) || snapshot.history.length > 20) throw new Error("The saved version is corrupted.");
        const next = validatedEntries(snapshot.entries), undo = snapshot.history.map(validatedEntries);
        if (undo.reduce((size, entries) => size + text(entries).length, 0) > HISTORY_CHARS) throw new Error("The saved version is corrupted.");
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
      replaceBlock(key,value,box) {const entry=valueEntry(key,value);entry.pdfBox=validateBox(key,box);replace(key,[entry]);},
      replaceAll(entries) { commit(targetEntries(entries)); },
      updateTexts(patches) {
        if (!Array.isArray(patches)) throw new Error('Invalid text replacements.');
        const next=draft.map(entry=>({...entry})),seen=new Set();
        for (const patch of patches) {
          if (!patch || !Number.isInteger(patch.index) || patch.index<0 || patch.index>=next.length || seen.has(patch.index) || typeof patch.text!=='string' || next[patch.index].text!==patch.before) throw new Error('The document changed. Search again before replacing.');
          seen.add(patch.index);next[patch.index].text=patch.text.replace(/\r\n?/g,'\n');
        }
        commit(next);
      },
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
