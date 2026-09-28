/** A Word draft whose paragraph identities remain attached to their table rows. */
import {normalizeDocxRowPlan} from './docx-structure.mjs';
const categories = ['changed', 'only_left', 'only_right', 'matched', 'moved', 'reflow'];
const MAX_CHARS = 500000, HISTORY_CHARS = 2000000;
const copy = value => JSON.parse(JSON.stringify(value));
const text = entries => entries.map(entry => entry.text).join('\n');
const signature = value => JSON.stringify(value);
const bad = () => { throw new Error('Сохранённая редакция повреждена.'); };
const unavailable = () => { throw new Error('Этой строки нет в документе. Отмените удаление или перенесите документ целиком.'); };
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const tables = content => content.filter(item => item.type === 'table');
const geometry = content => content.map(item => item.type === 'paragraph' ? 'p' : {index:item.index, columns:item.widths.length, rows:item.rows.map(row => row.cells.map(cell => [cell.column, cell.colSpan, cell.rowSpan, cell.content.length]))});
const editors = new WeakMap();

export function createDocxRowEditor(report, side = 'right', model) {
  if (!['left', 'right'].includes(side) || report?.kind !== 'text' || report.status !== 'complete' || !Array.isArray(model?.content) || !tables(model.content).length) throw new Error('Нужна завершённая проверка Word с таблицами.');
  const otherSide = side === 'left' ? 'right' : 'left', groups = new Map(), sources = {left:[], right:[]};
  for (const category of categories) for (const item of report[category] || []) {
    const group = {key:item.key, left:[], right:[]};
    for (const which of ['left', 'right']) {
      const row = item[which] || (category === `only_${which}` ? item.row : null);
      group[which] = (row ? row.source_blocks || [row] : []).map(block => ({key:item.key, record:block.record, text:block.text}));
      sources[which].push(...group[which]);
    }
    groups.set(item.key, group);
  }
  for (const which of ['left', 'right']) sources[which].sort((a,b) => a.record - b.record);
  const originalEntries = copy(sources[side]), canonical = copy(sources[otherSide]);
  const originals = new Map(originalEntries.map(entry => [entry.record, entry]));
  const originalPlan = {version:1, tables:tables(model.content).map(table => ({table:table.index, rows:table.rows.map((_, i) => ({source:i + 1}))}))};
  let draft, history = [], coalesce = null, revision = 0, nextId = 1;
  function validate(state) {
    if (!exact(state, ['entries', 'rowPlan']) || !Array.isArray(state.entries) || state.entries.length > 2000) bad();
    const plan = state.rowPlan;
    if (!exact(plan, ['version', 'tables']) || plan.version !== 1 || !Array.isArray(plan.tables)) bad();
    const negativeKeys = new Map(), ids = new Set();
    for (const table of plan.tables) {
      if (!exact(table, ['table', 'rows']) || !Number.isSafeInteger(table.table) || !Array.isArray(table.rows) || table.rows.length > 1000) bad();
      for (const row of table.rows) {
        if (Object.hasOwn(row || {}, 'source')) {
          if (!exact(row, ['source']) || !Number.isSafeInteger(row.source)) bad();
        } else {
          if (!exact(row, ['id', 'template', 'records']) || !/^row-(left|right)-[1-9]\d{0,8}$/.test(row?.id || '') || ids.has(row.id) || !Number.isSafeInteger(row.template) || !Array.isArray(row.records)) bad();
          ids.add(row.id);
          row.records.forEach((record, i) => {
            if (!Number.isSafeInteger(record) || record >= 0 || negativeKeys.has(record)) bad();
            negativeKeys.set(record, `${row.id}-${i + 1}`);
          });
        }
      }
    }
    const normalized = normalizeDocxRowPlan(model.content, plan);
    if (normalized.records.length !== state.entries.length) bad();
    const entries = state.entries.map((entry, i) => {
      if (!exact(entry, ['record', 'key', 'text']) || entry.record !== normalized.records[i] || typeof entry.text !== 'string' || /\r/.test(entry.text)) bad();
      const key = entry.record > 0 ? originals.get(entry.record)?.key : negativeKeys.get(entry.record);
      if (!key || entry.key !== key) bad();
      return {key, record:entry.record, text:entry.text};
    });
    if (text(entries).length > MAX_CHARS) throw new Error('Редакция слишком велика: максимум 500 000 символов.');
    return {entries, rowPlan:copy(plan)};
  }
  const original = validate({entries:originalEntries, rowPlan:originalPlan});
  draft = copy(original);
  function minimumNextId(states) {
    let minimum = 1;
    for (const state of states) for (const table of state.rowPlan.tables) for (const row of table.rows) {
      if (row.id?.startsWith(`row-${side}-`)) minimum = Math.max(minimum, Number(row.id.slice(`row-${side}-`.length)) + 1);
    }
    return minimum;
  }
  function commit(state, typingKey = null) {
    const next = validate(state);
    if (signature(next) === signature(draft)) { if (!typingKey) coalesce = null; return; }
    if (!typingKey || coalesce !== typingKey) history.push(copy(draft));
    while (history.length > 20 || history.reduce((size, entry) => size + text(entry.entries).length, 0) > HISTORY_CHARS) history.shift();
    draft = next; nextId = Math.max(nextId, minimumNextId([draft, ...history])); coalesce = typingKey; revision++;
  }
  function replace(key, value, typingKey = null) {
    const own = draft.entries.filter(entry => entry.key === key);
    if (!own.length) unavailable();
    if (value === null) throw new Error('Чтобы убрать строку таблицы, нажмите «Удалить строку». Для восстановления чужой структуры перенесите документ целиком.');
    if (typeof value !== 'string') throw new Error('Текст фрагмента должен быть строкой.');
    if (own.length !== 1) throw new Error('Этот фрагмент содержит несколько абзацев. Измените отдельную ячейку или перенесите документ целиком.');
    commit({...draft, entries:draft.entries.map(entry => entry.key === key ? {...entry, text:value.replace(/\r\n?/g, '\n')} : entry)}, typingKey);
  }
  function selectedRow(tableIndex, currentRow) {
    if (!Number.isSafeInteger(tableIndex) || !Number.isSafeInteger(currentRow)) throw new Error('Строка таблицы не найдена.');
    const table = normalizeDocxRowPlan(model.content, draft.rowPlan).content.find(item => item.type === 'table' && item.index === tableIndex);
    const row = table?.rows[currentRow - 1];
    if (!row) throw new Error('Строка таблицы не найдена.');
    if (!row.mutable) throw new Error('Строки с вертикально объединёнными ячейками пока нельзя добавлять или удалять.');
    return row;
  }
  function sequenceForPlan(plan, additions = new Map()) {
    const existing = new Map(draft.entries.map(entry => [entry.record, entry]));
    return normalizeDocxRowPlan(model.content, plan).records.map(record => additions.get(record) || existing.get(record));
  }
  function nextRowId() {
    nextId = Math.max(nextId, minimumNextId([draft, ...history]));
    if (nextId > 999999999) throw new Error('Достигнут предел новых строк этой редакции. Начните новую проверку.');
    return `row-${side}-${nextId++}`;
  }
  function replaceAll(entries, {rowPlan, content} = {}) {
    if (!Array.isArray(entries)) throw new Error('Нужен список фрагментов документа.');
    let plan = copy(originalPlan), negative = new Map();
    if (rowPlan !== undefined) {
      if (!Array.isArray(content) || signature(geometry(content)) !== signature(geometry(model.content))) throw new Error('У документов разная структура таблиц. Переносите текст по ячейкам.');
      const from = normalizeDocxRowPlan(content, rowPlan);
      if (from.records.length !== entries.length || entries.some((entry, i) => entry?.record !== from.records[i])) throw new Error('Порядок фрагментов не соответствует таблицам исходного документа.');
      plan = copy(rowPlan);
      let nextRecord = -1;
      for (const table of plan.tables) for (const row of table.rows) if (row.id) row.records = row.records.map((record, i) => {
        const entry = entries.find(item => item.record === record);
        if (!entry || entry.key !== `${row.id}-${i + 1}`) bad();
        const mapped = nextRecord--; negative.set(record, mapped); return mapped;
      });
    }
    const positions = new Map();
    const mapped = entries.map(entry => {
      if (!entry || typeof entry.text !== 'string') bad();
      if (entry.record < 0) {
        if (!negative.has(entry.record)) unavailable();
        return {key:entry.key, record:negative.get(entry.record), text:entry.text.replace(/\r\n?/g, '\n')};
      }
      const index = positions.get(entry.key) || 0;
      positions.set(entry.key, index + 1);
      const own = groups.get(entry.key)?.[side]?.[index];
      if (!own) throw new Error('У документов разная структура. Переносите текст по ячейкам.');
      return {...own, text:entry.text.replace(/\r\n?/g, '\n')};
    });
    const expected = normalizeDocxRowPlan(model.content, plan).records;
    if (mapped.length !== expected.length || mapped.some((entry, i) => entry.record !== expected[i])) throw new Error('У документов разная структура. Переносите текст по ячейкам.');
    commit({entries:mapped, rowPlan:plan});
  }
  function copyRowFrom(sourceEditor, key) {
    const source = editors.get(sourceEditor);
    if (!source) throw new Error('Для переноса строки нужны два документа Word с таблицами.');
    if (signature(geometry(source.content)) !== signature(geometry(model.content))) throw new Error('У документов разная структура таблиц. Переносите текст по ячейкам.');
    const from = source.state(), entry = from.entries.find(item => item.key === key);
    const fromTable = from.rowPlan.tables.find(table => table.rows.some(row => row.id && row.records.includes(entry?.record)));
    const fromIndex = fromTable?.rows.findIndex(row => row.id && row.records.includes(entry?.record));
    const row = fromTable?.rows[fromIndex];
    if (!row) throw new Error('Выберите ячейку добавленной строки для переноса.');
    const plan = copy(draft.rowPlan), target = plan.tables.find(table => table.table === fromTable.table);
    const presentTable = plan.tables.find(table => table.rows.some(item => item.id === row.id));
    let present = presentTable?.rows.find(item => item.id === row.id);
    if (present && (presentTable !== target || present.template !== row.template || present.records.length !== row.records.length)) throw new Error('У этой строки другая структура в двух документах. Отмените её изменение перед переносом.');
    if (!present) {
      if (target.rows.length >= 1000) throw new Error('В таблице может быть не больше 1000 строк.');
      if (draft.entries.length + row.records.length > 2000) throw new Error('В документе может быть не больше 2000 текстовых блоков.');
      const identity = item => item.id || `source-${item.source}`;
      const remaining = new Map(target.rows.map((item, index) => [identity(item), index]));
      const before = fromTable.rows.slice(0, fromIndex).reverse().find(item => remaining.has(identity(item)));
      const after = fromTable.rows.slice(fromIndex + 1).find(item => remaining.has(identity(item)));
      if (!before && !after) throw new Error('Не удалось найти место для строки: соседние исходные строки удалены. Отмените удаление и повторите перенос.');
      if (before && after && remaining.get(identity(before)) >= remaining.get(identity(after))) throw new Error('Порядок соседних строк в документах отличается. Отмените изменение порядка перед переносом.');
      const position = after ? remaining.get(identity(after)) : remaining.get(identity(before)) + 1;
      let record = Math.min(0, ...draft.entries.map(item => item.record)) - 1;
      present = {id:row.id, template:row.template, records:row.records.map(() => record--)};
      target.rows.splice(position, 0, present);
    }
    const sourceEntries = new Map(from.entries.map(item => [item.record, item]));
    const additions = new Map(present.records.map((record, index) => [record, {record, key:`${row.id}-${index + 1}`, text:sourceEntries.get(row.records[index]).text}]));
    commit({entries:sequenceForPlan(plan, additions), rowPlan:plan});
    return `${row.id}-1`;
  }
  function rowTextReplacement(sourceEditor, key) {
    const source = editors.get(sourceEditor);
    if (!source) throw new Error('Для переноса строки нужны два документа Word с таблицами.');
    if (signature(geometry(source.content)) !== signature(geometry(model.content))) throw new Error('У документов разная структура таблиц. Переносите текст по ячейкам.');
    const selected = source.originalEntries.filter(entry => entry.key === key);
    const positions = [];
    for (const table of tables(source.content)) for (const row of table.rows) {
      const records = row.cells.flatMap(cell => cell.content.map(paragraph => paragraph.record));
      if (selected.some(entry => records.includes(entry.record))) positions.push({table, row, records});
    }
    if (!positions.length) throw new Error('Выберите ячейку исходной строки таблицы.');
    if (positions.length !== 1 || selected.some(entry => !positions[0].records.includes(entry.record))) throw new Error('Выбранный фрагмент относится к нескольким строкам. Переносите текст по ячейкам.');
    const {table:fromTable, row:fromRow, records:fromRecords} = positions[0];
    const targetTable = tables(model.content).find(table => table.index === fromTable.index);
    const targetRow = targetTable.rows.find(row => row.source === fromRow.source);
    if (!fromRow.mutable || !targetRow.mutable) throw new Error('В этой строке есть вертикально объединённые ячейки. Переносите текст по ячейкам.');
    const from = source.state();
    const exists = state => state.rowPlan.tables.find(table => table.table === fromTable.index)?.rows.some(row => row.source === fromRow.source);
    if (!exists(from) || !exists(draft)) throw new Error('Этой строки нет в одном из документов. Отмените удаление, чтобы перенести её текст.');
    const sourceEntries = new Map(from.entries.map(entry => [entry.record, entry]));
    const targetRecords = targetRow.cells.flatMap(cell => cell.content.map(paragraph => paragraph.record));
    const replacements = new Map(targetRecords.map((record, index) => [record, sourceEntries.get(fromRecords[index]).text]));
    const next = validate({rowPlan:draft.rowPlan, entries:draft.entries.map(entry => replacements.has(entry.record) ? {...entry, text:replacements.get(entry.record)} : entry)});
    return {next, equal:signature(next) === signature(draft), key:draft.entries.find(entry => entry.record === targetRecords[0]).key};
  }
  const api = {
    snapshot: () => ({version:2, side, nextId, entries:copy(draft.entries), rowPlan:copy(draft.rowPlan), history:copy(history)}),
    restore(snapshot) {
      if (!snapshot || ![1,2].includes(snapshot.version) || snapshot.side !== side || !Array.isArray(snapshot.history) || snapshot.history.length > 20) bad();
      const legacy = snapshot.version === 1;
      if (!exact(snapshot, legacy ? ['version','side','entries','history'] : ['version','side','nextId','entries','rowPlan','history'])) bad();
      const next = validate({entries:snapshot.entries, rowPlan:legacy ? originalPlan : snapshot.rowPlan});
      const undo = snapshot.history.map(state => validate(legacy ? {entries:state, rowPlan:originalPlan} : state));
      if (undo.reduce((size, state) => size + text(state.entries).length, 0) > HISTORY_CHARS) bad();
      const minimum = minimumNextId([next, ...undo]);
      if (!legacy && (!Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < minimum || snapshot.nextId > 1000000000)) bad();
      nextId = Math.max(nextId, legacy ? minimum : snapshot.nextId);
      draft = next; history = undo; coalesce = null; revision++;
    },
    get revision() { return revision; },
    entries: () => copy(draft.entries),
    rowPlan: () => copy(draft.rowPlan),
    extraGroups: () => draft.entries.filter(entry => entry.record < 0).map(entry => ({key:entry.key, [side]:{...entry}})),
    text: () => text(draft.entries),
    exportText: () => draft.entries.length ? text(draft.entries) + '\n' : '',
    canonicalText: () => text(canonical),
    get(key) { const found = draft.entries.filter(entry => entry.key === key); return found.length ? text(found) : null; },
    set(key, value) { replace(key, value); },
    edit(key, value) { replace(key, String(value), key); },
    apply(key) { const group = groups.get(key); if (!group) unavailable(); replace(key, group[otherSide].length ? text(group[otherSide]) : null); },
    applyAll() { replaceAll(canonical); },
    replaceAll,
    copyRowFrom,
    rowTextCopyState(sourceEditor, key) {
      try {
        const {equal} = rowTextReplacement(sourceEditor, key);
        return {available:true, equal, reason:equal ? 'Текст этой строки уже совпадает.' : ''};
      } catch (error) {
        return {available:false, equal:false, reason:error.message};
      }
    },
    replaceRowTextFrom(sourceEditor, key) {
      const {next, key:targetKey} = rowTextReplacement(sourceEditor, key);
      commit(next);
      return targetKey;
    },
    insertRow(tableIndex, currentRow, where = 'after') {
      if (!['before', 'after'].includes(where)) throw new Error('Неизвестное положение новой строки.');
      const row = selectedRow(tableIndex, currentRow), plan = copy(draft.rowPlan), target = plan.tables.find(table => table.table === tableIndex);
      const source = target.rows[currentRow - 1], template = source.source || source.template;
      const id = nextRowId(); let nextRecord = Math.min(0, ...draft.entries.map(entry => entry.record)) - 1;
      const records = row.cells.map(() => nextRecord--), additions = new Map(records.map((record, i) => [record, {key:`${id}-${i + 1}`, record, text:''}]));
      target.rows.splice(currentRow - (where === 'before' ? 1 : 0), 0, {id, template, records});
      commit({entries:sequenceForPlan(plan, additions), rowPlan:plan});
      return `${id}-1`;
    },
    deleteRow(tableIndex, currentRow) {
      selectedRow(tableIndex, currentRow);
      const plan = copy(draft.rowPlan), table = plan.tables.find(item => item.table === tableIndex);
      if (table.rows.length === 1) throw new Error('В таблице должна остаться хотя бы одна строка.');
      table.rows.splice(currentRow - 1, 1);
      commit({entries:sequenceForPlan(plan), rowPlan:plan});
    },
    endEdit() { coalesce = null; },
    reset() { commit(copy(original)); },
    undo() { if (history.length) { draft = history.pop(); revision++; } coalesce = null; },
    get canUndo() { return history.length > 0; },
    get structureChanged() { return signature(draft.rowPlan) !== signature(originalPlan); },
    get changed() { return signature(draft) !== signature(original); },
    get matchesCanonical() { return text(draft.entries) === text(canonical); },
  };
  editors.set(api, {content:model.content, originalEntries, state:() => validate(draft)});
  return api;
}
