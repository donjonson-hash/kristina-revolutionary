/** Exact block alignment and bounded word-level differences, without inference. */
import {readTextSource} from './text-source.mjs';
const MAX_WORD_WORK = 1000000, MAX_TOTAL_WORD_WORK = 4000000;
const MAX_TOKENS = 10000, MAX_SEGMENTS = 10000;
const fail = message => { throw new Error(message); };
async function sources(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Укажите два текстовых файла.');
  return {left: await readTextSource(payload.left), right: await readTextSource(payload.right)};
}
export async function prepareText(payload) {
  const {left, right} = await sources(payload);
  return {kind: 'text', ready: true, left: left.meta, right: right.meta};
}
// At most 2000 blocks per side: ≤4 million cells and ≤16 MiB temporary matrix.
// Prefix/suffix anchors are exact; repeated blocks are aligned deterministically.
function lcs(left, right, equal) {
  const width = right.length + 1, matrix = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i * width + j] = equal(left[i], right[j]) ? 1 + matrix[(i + 1) * width + j + 1] : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const pairs = []; let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (equal(left[i], right[j])) { pairs.push([i++, j++]); }
    else if (matrix[(i + 1) * width + j] >= matrix[i * width + j + 1]) i++;
    else j++;
  }
  return pairs;
}
function tokenize(text) { return text.match(/[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu) || []; }
function segments(left, right, budget) {
  const a = tokenize(left), b = tokenize(right), work = a.length * b.length;
  const fallback = () => { budget.fallback++; return {left: [{text: left, changed: true}], right: [{text: right, changed: true}]}; };
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS || work > MAX_WORD_WORK || budget.used + work > MAX_TOTAL_WORD_WORK) return fallback();
  budget.used += work;
  const intern = new Map(); let id = 0;
  const ids = values => values.map(value => { if (!intern.has(value)) intern.set(value, ++id); return intern.get(value); });
  const anchors = lcs(ids(a), ids(b), (x, y) => x === y), result = {left: [], right: []};
  function append(side, text, changed) {
    if (!text) return;
    const list = result[side], last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text; else list.push({text, changed});
  }
  let i = 0, j = 0;
  for (const [ai, bi] of [...anchors, [a.length, b.length]]) {
    append('left', a.slice(i, ai).join(''), true); append('right', b.slice(j, bi).join(''), true);
    if (ai < a.length) { append('left', a[ai], false); append('right', b[bi], false); }
    i = ai + 1; j = bi + 1;
  }
  if (result.left.length + result.right.length > MAX_SEGMENTS) return fallback();
  return result;
}
export async function compareText(payload) {
  const {left, right} = await sources(payload), a = left.blocks, b = right.blocks;
  // Hash/intern complete strings once: matrix comparisons stay constant-time
  // even with many very long repeated paragraphs.
  const intern = new Map(); let token = 0;
  const ids = blocks => blocks.map(block => { if (!intern.has(block.text)) intern.set(block.text, ++token); return intern.get(block.text); });
  const anchors = lcs(ids(a), ids(b), (x, y) => x === y), budget = {used: 0, fallback: 0};
  const result = {schema_version: 1, kind: 'text', status: 'complete', sources: {left: left.meta, right: right.meta}, rules: {mode: 'text', normalization: 'line_endings'}, summary: null, matched: [], changed: [], only_left: [], only_right: []};
  if (left.meta.format === 'pdf' || right.meta.format === 'pdf') result.rules.pdf_text_layer = true;
  let order = 0, i = 0, j = 0;
  function gap(ai, bi) {
    // Exact neighboring anchors bound a changed region; paired unmatched blocks
    // represent textual substitutions, not a claim of semantic equivalence.
    while (i < ai && j < bi) {
      const aa = a[i++], bb = b[j++];
      result.changed.push({key: `text-${++order}`, left: aa, right: bb, segments: segments(aa.text, bb.text, budget)});
    }
    while (i < ai) result.only_left.push({key: `text-${++order}`, row: a[i++]});
    while (j < bi) result.only_right.push({key: `text-${++order}`, row: b[j++]});
  }
  for (const [ai, bi] of anchors) {
    gap(ai, bi); result.matched.push({key: `text-${++order}`, left: a[i++], right: b[j++]});
  }
  gap(a.length, b.length);
  const scope = result.rules.pdf_text_layer
    ? 'Извлечённые фрагменты выровнены по точным совпадениям и порядку. Перенос текста на другую страницу сам по себе не считается изменением текста. Пары различающихся фрагментов не означают смысловую эквивалентность.'
    : 'Абзацы выровнены по точным совпадениям и порядку. Пары различающихся абзацев показывают текстовую замену, а не смысловую эквивалентность.';
  result.sources.left.notes.push(scope); result.sources.right.notes.push(scope);
  if (budget.fallback) {
    const note = `Для ${budget.fallback} пар превышен бюджет подсветки слов: выделен абзац целиком. Текст сохранён полностью.`;
    result.sources.left.notes.push(note); result.sources.right.notes.push(note);
  }
  result.summary = {left_blocks: a.length, right_blocks: b.length, ...Object.fromEntries(['matched', 'changed', 'only_left', 'only_right'].map(name => [name, result[name].length]))};
  // Input text is capped at 1M characters across sources. The segment cap keeps
  // escaped text+evidence below the existing report budget in typical cases;
  // explicitly reject any pathological serialized expansion.
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16 * 1024 * 1024) fail('Текстовый отчёт превышает 16 МиБ. Разделите документы.');
  return result;
}
