/** Deterministic, offline tabular engine. No network, storage, or model access. */
import {readWorkbook} from './xlsx-source.mjs';
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 5000, MAX_COLUMNS = 200, MAX_FIELD_CHARS = 131072, MAX_ISSUES = 100;
const DELIMITERS = [',', ';', '\t'];
const NUMBER = /^[+-]?[0-9]+(?:\.[0-9]+)?(?![\s\S])/;
// Python str.strip differs from JS trim: Python includes U+001C–001F and
// U+0085, but does not strip U+FEFF. Preserve that contract for identifiers.
const SPACE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const strip = value => value.replace(SPACE, '');
const validNumber = value => NUMBER.test(value);
const aliases = {
  identifier_sku: ['sku', 'артикул'], identifier_id: ['id', 'идентификатор'],
  identifier_product_id: ['product_id'], identifier_code: ['код'],
  identifier_product_code: ['код товара', 'код_товара'],
  quantity: ['qty', 'quantity', 'количество'], price: ['price', 'цена'],
  price_rub: ['price_rub', 'цена_руб'], unit: ['unit', 'единица', 'единица измерения'],
  name: ['name', 'наименование'],
};
const semantics = new Map(Object.entries(aliases).flatMap(([kind, names]) => names.map(name => [name, kind])));
// The complete set of casefold-vs-lowercase differences that can produce
// characters in this finite alias vocabulary (ASCII and Cyrillic).
const folds = new Map([['ſ', 's'], ['ᲀ', 'в'], ['ᲁ', 'д'], ['ᲂ', 'о'], ['ᲃ', 'с'], ['ᲄ', 'т'], ['ᲅ', 'т']]);
const meaning = header => semantics.get(strip(header).toLowerCase().replace(/[ſᲀ-ᲅ]/gu, ch => folds.get(ch)));
const numericKinds = new Set(['quantity', 'price', 'price_rub']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

function bounded(result) {
  // Count incrementally, before JSON.stringify can amplify repeated headers.
  let bytes = 0;
  const encoder = new TextEncoder();
  function add(size) {
    bytes += size;
    if (bytes > MAX_REPORT_BYTES) fail('JSON report exceeds 16 MiB; split the input lists');
  }
  function walk(value, depth = 0) {
    if (value === null || typeof value !== 'object') { add(encoder.encode(JSON.stringify(value)).length); return; }
    const entries = Array.isArray(value) ? value : Object.entries(value);
    add(2);
    entries.forEach((entry, index) => {
      if (index) add(1);
      add(1 + 2 * (depth + 1));
      if (Array.isArray(value)) walk(entry, depth + 1);
      else { walk(entry[0], depth + 1); add(2); walk(entry[1], depth + 1); }
    });
    if (entries.length) add(1 + 2 * depth);
  }
  walk(result);
  add(1); // Python render_json's final newline.
  return result;
}

async function inputs(payload, auto = false) {
  if (!object(payload)) fail('Expected a JSON object');
  const delimiter = own(payload, 'delimiter') ? payload.delimiter : auto ? 'auto' : ',';
  if (![...DELIMITERS, ...(auto ? ['auto'] : [])].includes(delimiter)) fail('delimiter must be comma, semicolon, or tab');
  const sources = {};
  for (const side of ['left', 'right']) {
    const item = payload[side];
    if (!object(item)) fail(`${side}: expected name and base64 data`);
    const {name, data} = item;
    if (typeof name !== 'string' || !strip(name) || [...name].length > 255 || name.includes('\0')) fail(`${side}: name must be a nonblank string of at most 255 characters`);
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)) fail(`${side}: name must contain valid Unicode characters`);
    if (typeof data !== 'string') fail(`${side}: data must be base64 text`);
    if (data.length > 4 * Math.ceil(MAX_SOURCE_BYTES / 3)) fail(`${side}: source exceeds 2 MiB`);
    if (/[^A-Za-z0-9+/=]/.test(data) || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail(`${side}: invalid base64 data`);
    let binary;
    try { binary = atob(data); } catch { fail(`${side}: invalid base64 data`); }
    const raw = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    if (raw.length > MAX_SOURCE_BYTES) fail(`${side}: source exceeds 2 MiB`);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (/\.xlsx$/i.test(name)) {
      sources[side] = {name, sha256, workbook: await readWorkbook(raw, {name, sha256, sheet: item.sheet})};
      continue;
    }
    if (/\.(xls|xlsm|xlsb|ods)$/i.test(name) || raw[0] === 0x50 && raw[1] === 0x4b) fail(`${name}: CSV, TSV, and XLSX are supported. Save the workbook as XLSX.`);
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(raw); }
    catch { fail(`${name}: expected UTF-8 CSV`); }
    if (!text || text.includes('\0')) fail(`${name}: empty source or NUL character in CSV`);
    sources[side] = {name, text, sha256};
  }
  return {delimiter, sources};
}

function source(input, delimiter) {
  if (input.workbook) {
    if (!input.workbook.parsed) fail(`${input.name}: select a sheet to compare.`);
    return input.workbook.parsed;
  }
  const {name, text, sha256} = input;
  let headers, cells = [], chars = [], state = 'start', touched = false;
  const rows = [];
  function append(ch) {
    chars.push(ch);
    if (chars.length > MAX_FIELD_CHARS) fail(`${name}: invalid CSV: field larger than field limit (${MAX_FIELD_CHARS})`);
  }
  function field() { cells.push(chars.join('')); chars = []; state = 'start'; }
  function record() {
    if (touched || cells.length || chars.length) field();
    if (headers === undefined) {
      headers = cells;
      if (!headers.length || headers.some(h => !strip(h))) fail(`${name}: headers must be nonblank`);
      if (headers.length > MAX_COLUMNS) fail(`${name}: more than ${MAX_COLUMNS} columns`);
      if (new Set(headers).size !== headers.length) fail(`${name}: duplicate headers`);
    } else {
      if (rows.length >= MAX_RECORDS) fail(`${name}: more than ${MAX_RECORDS} data records`);
      const number = rows.length + 2;
      if (cells.length !== headers.length) fail(`${name}: record ${number} has ${cells.length} cells; expected ${headers.length}`);
      // defineProperty avoids special setters for __proto__, constructor, etc.
      const values = {};
      headers.forEach((header, index) => Object.defineProperty(values, header, {value: cells[index], enumerable: true, writable: true, configurable: true}));
      rows.push({record: number, values});
    }
    cells = []; chars = []; state = 'start'; touched = false;
  }
  for (let index = 0; index < text.length; index++) {
    const cp = text.codePointAt(index), ch = String.fromCodePoint(cp);
    if (cp > 0xffff) index++;
    if (state === 'quoted') {
      if (ch === '"') state = 'closed'; else append(ch);
      continue;
    }
    if (state === 'closed' && ch === '"') { append(ch); state = 'quoted'; continue; }
    if (ch === delimiter) { touched = true; field(); continue; }
    if (ch === '\r' || ch === '\n') {
      record();
      if (ch === '\r' && text[index + 1] === '\n') index++;
      continue;
    }
    if (state === 'closed') fail(`${name}: unexpected text after a closing CSV quote`);
    touched = true;
    if (ch === '"') {
      if (state !== 'start') fail(`${name}: quote inside an unquoted CSV field`);
      state = 'quoted';
    } else { append(ch); state = 'unquoted'; }
  }
  if (state === 'quoted') fail(`${name}: unterminated quoted CSV field`);
  if (touched || chars.length || cells.length) record();
  if (headers === undefined) fail(`${name}: empty CSV source`);
  return {meta: {name, sha256, headers, row_count: rows.length}, rows};
}

function parseSources(sources, delimiter) {
  const parse = d => Object.fromEntries(Object.entries(sources).map(([side, input]) => [side, source(input, d)]));
  if (Object.values(sources).every(input => input.workbook)) return {delimiter: delimiter === 'auto' ? ',' : delimiter, parsed: parse(',')};
  if (delimiter !== 'auto') return {delimiter, parsed: parse(delimiter)};
  const candidates = [];
  for (const d of DELIMITERS) {
    try { candidates.push({delimiter: d, parsed: parse(d)}); } catch { /* Another supported separator may fit. */ }
  }
  const structured = candidates.filter(item => Object.values(item.parsed).every(s => s.meta.headers.length > 1));
  if (structured.length === 1) return structured[0];
  // Identical interpretation across all separators is valid for one-column CSV.
  if (!structured.length && candidates.length === 3) {
    const first = candidates[0].parsed;
    const identical = item => ['left', 'right'].every(side => {
      const a = first[side], b = item.parsed[side];
      return a.meta.headers.length === b.meta.headers.length && a.meta.headers.every((h, i) => h === b.meta.headers[i])
        && a.rows.length === b.rows.length && a.rows.every((row, i) => a.meta.headers.every(h => row.values[h] === b.rows[i].values[h]));
    });
    if (candidates.every(identical)) return candidates[0];
  }
  if (!candidates.length) fail("Could not read the CSV. Check the UTF-8 encoding and row structure, and select a delimiter in settings.");
  fail("Could not determine a shared CSV delimiter. Select a delimiter in settings; both files must use it.");
}

function mapHeaders(left, right) {
  const rightSet = new Set(right), pairs = new Map(left.filter(h => rightSet.has(h)).map(h => [h, h])), used = new Set(pairs.values());
  const groups = {};
  for (const [side, headers] of [['left', left.filter(h => !pairs.has(h))], ['right', right.filter(h => !used.has(h))]]) {
    groups[side] = new Map();
    for (const header of headers) {
      const kind = meaning(header);
      if (kind) groups[side].set(kind, [...(groups[side].get(kind) || []), header]);
    }
  }
  for (const [kind, names] of groups.left) {
    const other = groups.right.get(kind) || [];
    if (names.length === 1 && other.length === 1) { pairs.set(names[0], other[0]); used.add(other[0]); }
  }
  return {pairs: left.filter(h => pairs.has(h)).map(h => [h, pairs.get(h)]), unmatched: {left: left.filter(h => !pairs.has(h)), right: right.filter(h => !used.has(h))}};
}

export async function inspect(payload) {
  const {sources, delimiter} = await inputs(payload);
  return bounded(Object.fromEntries(Object.entries(sources).map(([side, input]) => {
    const parsed = source(input, delimiter);
    return [side, {...parsed.meta, preview: parsed.rows.slice(0, 5)}];
  })));
}

export async function prepare(payload) {
  const input = await inputs(payload, true);
  if (Object.values(input.sources).some(s => s.workbook && !s.workbook.parsed)) {
    return bounded({needs_sheet: true, ready: false,
      sheets: Object.fromEntries(Object.entries(input.sources).map(([side, s]) => [side, s.workbook?.sheets || []])),
      selected: Object.fromEntries(Object.entries(input.sources).map(([side, s]) => [side, s.workbook?.selected ?? null]))});
  }
  const {parsed, delimiter} = parseSources(input.sources, input.delimiter);
  const {left, right} = parsed, {pairs, unmatched} = mapHeaders(left.meta.headers, right.meta.headers);
  const candidates = pairs.filter(([a, b]) => meaning(a)?.startsWith('identifier_') && meaning(a) === meaning(b));
  let key = null, invalidNumeric = false;
  const questions = [], fields = [];
  if (candidates.length !== 1) questions.push("Select the column that identifies the same item in both files, such as an SKU or ID. " + (candidates.length ? "Several possible identifiers were found." : "No unique identifier was found."));
  else {
    const candidate = candidates[0], values = [left, right].map((s, i) => s.rows.map(row => row.values[candidate[i]]));
    const leftValues = new Set(values[0]);
    if (values.some(side => side.some(value => !strip(value)))) questions.push("The identifier column contains empty values. Fill them in or select a different key in settings.");
    else if (values.some(side => side.length !== new Set(side).size)) questions.push("The identifier column contains duplicate values. Refine the key or remove duplicates before comparing.");
    else if (values.every(side => side.length) && !values[1].some(value => leftValues.has(value))) questions.push("No matching items were found using this identifier. Check the keys in settings; if the lists are completely different, confirm your selection manually.");
    else key = candidate;
  }
  for (const [a, b] of pairs) {
    if (key?.[0] === a && key?.[1] === b) continue;
    let mode = 'text';
    if (numericKinds.has(meaning(a)) && meaning(a) === meaning(b)) {
      mode = 'number';
      if (![[a, left], [b, right]].every(([column, s]) => s.rows.every(row => validNumber(row.values[column])))) invalidNumeric = true;
    }
    fields.push([a, b, mode]);
  }
  if (invalidNumeric) questions.push("Some quantity or price values cannot be read unambiguously as numbers. Check the format in settings: use a decimal point, with no units or thousands separators.");
  if (unmatched.left.length || unmatched.right.length) questions.push("Some columns could not be matched. Map them in settings or explicitly exclude them from the comparison.");
  return bounded({left: {...left.meta, preview: left.rows.slice(0, 5)}, right: {...right.meta, preview: right.rows.slice(0, 5)}, delimiter, rules: {key, fields, strip: false}, ready: !questions.length, question: questions.length ? questions.join(' ') : null, unmatched});
}

function validateRules(key, fields, trim) {
  if (typeof trim !== 'boolean') fail('strip must be a boolean');
  if (key !== null && (!Array.isArray(key) || key.length !== 2 || !key.every(c => typeof c === 'string' && c))) fail('key must contain one exact column name for each source');
  if (fields !== null) {
    if (!Array.isArray(fields)) fail('fields must be a list of (left column, right column, mode)');
    for (const f of fields) if (!Array.isArray(f) || f.length !== 3 || !f.slice(0, 2).every(c => typeof c === 'string' && c) || !['text', 'number'].includes(f[2])) fail("each field needs two column names and mode 'text' or 'number'");
    for (const side of [0, 1]) {
      const selected = [...(key ? [key[side]] : []), ...fields.map(f => f[side])];
      if (selected.length !== new Set(selected).size) fail('key and compared columns must be mapped one-to-one without reuse');
    }
  }
}

function decimal(value) {
  let negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, ''), [whole, part = ''] = unsigned.split('.');
  const integer = whole.replace(/^0+/, '') || '0', fraction = part.replace(/0+$/, '');
  if (integer === '0' && !fraction) negative = false;
  return (negative ? '-' : '') + integer + (fraction ? '.' + fraction : '');
}

// Python repr-like spelling for source evidence messages; data itself stays raw.
function repr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return quote + [...value].map(ch => {
    if (ch === '\\') return '\\\\';
    if (ch === quote) return '\\' + ch;
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    const cp = ch.codePointAt(0);
    if (cp < 32 || (cp >= 127 && cp < 160) || /[\p{Z}\p{C}]/u.test(ch) && ch !== ' ') return cp <= 255 ? `\\x${cp.toString(16).padStart(2, '0')}` : cp <= 65535 ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\U${cp.toString(16).padStart(8, '0')}`;
    return ch;
  }).join('') + quote;
}

export async function compare(payload) {
  const {sources, delimiter} = await inputs(payload);
  const key = payload.key ?? null, fields = payload.fields ?? null, trim = own(payload, 'strip') ? payload.strip : false;
  validateRules(key, fields, trim);
  const left = source(sources.left, delimiter), right = source(sources.right, delimiter);
  const result = {schema_version: 1, status: 'needs_clarification', sources: {left: left.meta, right: right.meta}, rules: {key, fields, strip: trim, delimiter}, questions: [], issues: [], summary: null, matched: [], changed: [], only_left: [], only_right: []};
  const questionSet = new Set(); let suppressed = 0;
  function issue(code, message, details = {}) {
    if (result.issues.length >= MAX_ISSUES) { suppressed++; return; }
    result.issues.push({code, message, ...details});
    if (!questionSet.has(message)) { questionSet.add(message); result.questions.push(message); }
  }
  function incomplete() {
    if (suppressed) result.issues.push({code: 'additional_issues', count: suppressed, message: "Only the first 100 issues are shown. Fix the data and compare again."});
    return bounded(result);
  }
  if (key === null) issue('missing_key', "Select the exact key column name in each source before comparing.");
  if (fields === null) issue('missing_fields', "Select fields and text/number modes, or explicitly compare only which rows are present (fields=[]).");
  for (const [side, parsed, index] of [['left', left, 0], ['right', right, 1]]) {
    for (const column of [...(key ? [key[index]] : []), ...(fields || []).map(f => f[index])]) {
      if (!parsed.meta.headers.includes(column)) issue('missing_column', `Specify an existing column in source ${side} instead of ${repr(column)}.`, {side, column});
    }
  }
  if (result.issues.length) return incomplete();
  const normalize = trim ? strip : value => value, indexes = {}, numeric = new Map();
  for (const [side, parsed, index] of [['left', left, 0], ['right', right, 1]]) {
    const keyed = new Map();
    for (const row of parsed.rows) {
      const value = normalize(row.values[key[index]]);
      if (!strip(value)) issue('empty_key', `Fill in the key in record ${row.record} of source ${side}.`, {side, record: row.record, column: key[index]});
      else if (keyed.has(value)) issue('duplicate_key', `Resolve the duplicate key ${repr(value)} in source ${side}.`, {side, key: value, records: [keyed.get(value).record, row.record]});
      else keyed.set(value, row);
      const rowNumbers = new Map(); numeric.set(row, rowNumbers);
      for (const mapping of fields) {
        if (mapping[2] !== 'number') continue;
        const column = mapping[index], raw = normalize(row.values[column]);
        if (!validNumber(raw)) issue('invalid_number', `Enter a decimal number using digits 0–9 and a decimal point in record ${row.record} of source ${side}, column ${repr(column)}; confirm the units separately.`, {side, record: row.record, column, value: row.values[column]});
        else rowNumbers.set(column, decimal(raw));
      }
    }
    indexes[side] = keyed;
  }
  if (result.issues.length) return incomplete();
  for (const [value, a] of indexes.left) {
    const b = indexes.right.get(value);
    if (!b) { result.only_left.push({key: value, row: a}); continue; }
    const changes = [];
    for (const [ac, bc, mode] of fields) {
      const before = a.values[ac], after = b.values[bc];
      const equal = mode === 'number' ? numeric.get(a).get(ac) === numeric.get(b).get(bc) : normalize(before) === normalize(after);
      if (!equal) changes.push({left_column: ac, right_column: bc, mode, before, after});
    }
    const item = {key: value, left: a, right: b};
    if (changes.length) result.changed.push({...item, changes}); else result.matched.push(item);
  }
  for (const [value, row] of indexes.right) if (!indexes.left.has(value)) result.only_right.push({key: value, row});
  result.status = 'complete';
  result.summary = {left_rows: left.rows.length, right_rows: right.rows.length, ...Object.fromEntries(['matched', 'changed', 'only_left', 'only_right'].map(k => [k, result[k].length]))};
  return bounded(result);
}
