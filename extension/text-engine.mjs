/** Exact block alignment and bounded word-level differences, without inference. */
import {readTextSource} from './text-source.mjs';
const MAX_WORD_WORK = 1000000, MAX_TOTAL_WORD_WORK = 4000000;
const MAX_TOKENS = 10000, MAX_SEGMENTS = 10000;
const MAX_REFLOW_BLOCKS = 8, MAX_REFLOW_CHARS = 8192, MAX_REFLOW_WORK = 4000000;
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
function frequencies(blocks) {
  const counts = new Map();
  for (const {text} of blocks) counts.set(text, (counts.get(text) || 0) + 1);
  return counts;
}
function aggregate(blocks) {
  return {record: blocks[0].record, text: blocks.map(block => block.text).join('\n'), location: blocks.map(block => block.location).join('; '), source_blocks: blocks};
}
// Discover structural pairs before changed-gap pairing can consume their text.
// Repeated exact blocks remain unclassified: a repeated heading is not evidence
// that a particular occurrence moved. Coordinates, not output order, identify it.
function structure(a, b, anchors, formats) {
  const occupiedA = new Set(anchors.map(pair => pair[0])), occupiedB = new Set(anchors.map(pair => pair[1]));
  const countsA = frequencies(a), countsB = frequencies(b), indexB = new Map(b.map((block, i) => [block.text, i]));
  const starts = new Map(), consumedA = new Set(), consumedB = new Set();
  function add(category, ai, an, bi, bn) {
    const left = a.slice(ai, ai + an), right = b.slice(bi, bi + bn);
    starts.set(ai, {category, left: category === 'reflow' ? aggregate(left) : left[0], right: category === 'reflow' ? aggregate(right) : right[0]});
    for (let i = ai; i < ai + an; i++) { occupiedA.add(i); consumedA.add(i); }
    for (let j = bi; j < bi + bn; j++) { occupiedB.add(j); consumedB.add(j); }
  }
  for (let i = 0; i < a.length; i++) {
    const text = a[i].text, j = indexB.get(text);
    if (text.trim() && !occupiedA.has(i) && j !== undefined && !occupiedB.has(j) && countsA.get(text) === 1 && countsB.get(text) === 1) add('moved', i, 1, j, 1);
  }
  const outcome = {starts, consumedA, consumedB, reflowFallback: false};
  if (!formats.includes('pdf') || occupiedA.size === a.length || occupiedB.size === b.length) return outcome;
  let work = 0;
  // Index all spans, including occupied ones, to reject an otherwise apparent
  // unique pairing when the same joined text occurs elsewhere in either source.
  // DOCX paragraphs are indivisible; only their PDF counterpart can be joined.
  function spans(blocks, occupied, format) {
    const result = new Map(), limit = format === 'docx' ? 1 : MAX_REFLOW_BLOCKS;
    for (let start = 0; start < blocks.length; start++) {
      let text = '', eligible = true;
      for (let length = 1; length <= limit && start + length <= blocks.length; length++) {
        const index = start + length - 1, next = blocks[index].text;
        // Blank blocks have explicit structural meaning and are never folded.
        if (!next.trim()) break;
        if (text.length + (length > 1 ? 1 : 0) + next.length > MAX_REFLOW_CHARS) break;
        text += (length > 1 ? ' ' : '') + next;
        work += text.length;
        if (work > MAX_REFLOW_WORK) return null;
        eligible = eligible && !occupied.has(index);
        const prior = result.get(text);
        if (prior) prior.count++;
        else result.set(text, {start, length, eligible, count: 1});
      }
    }
    return result;
  }
  const aa = spans(a, occupiedA, formats[0]);
  const bb = aa && spans(b, occupiedB, formats[1]);
  if (!aa || !bb) { outcome.reflowFallback = true; return outcome; }
  const candidates = [];
  for (const [text, left] of aa) {
    const right = bb.get(text);
    if (left.count === 1 && left.eligible && right?.count === 1 && right.eligible && (left.length > 1 || right.length > 1)) candidates.push({left, right});
  }
  // Prefer indivisible exact reflows. A larger span enclosing an already exact
  // pair adds no evidence and would turn two independent reflows into one.
  candidates.sort((x, y) => x.left.length + x.right.length - y.left.length - y.right.length || x.left.start - y.left.start || x.right.start - y.right.start);
  const minimal = [], byStart = new Map();
  for (const candidate of candidates) {
    const {left, right} = candidate;
    let contains = false;
    for (let i = left.start; i < left.start + left.length && !contains; i++) {
      contains = (byStart.get(i) || []).some(inner => inner.left.start + inner.left.length <= left.start + left.length && inner.right.start >= right.start && inner.right.start + inner.right.length <= right.start + right.length);
    }
    if (contains) continue;
    minimal.push(candidate);
    if (!byStart.has(left.start)) byStart.set(left.start, []);
    byStart.get(left.start).push(candidate);
  }
  // Overlapping alternative explanations are ambiguous. Keep their original
  // differences instead of selecting a best-looking interpretation.
  const coverA = new Uint16Array(a.length), coverB = new Uint16Array(b.length);
  for (const {left, right} of minimal) {
    for (let i = left.start; i < left.start + left.length; i++) coverA[i]++;
    for (let j = right.start; j < right.start + right.length; j++) coverB[j]++;
  }
  for (const {left, right} of minimal) {
    if (coverA.slice(left.start, left.start + left.length).some(n => n !== 1) || coverB.slice(right.start, right.start + right.length).some(n => n !== 1)) continue;
    add('reflow', left.start, left.length, right.start, right.length);
  }
  return outcome;
}
export async function compareText(payload) {
  const {left, right} = await sources(payload), a = left.blocks, b = right.blocks;
  // Hash/intern complete strings once: matrix comparisons stay constant-time
  // even with many very long repeated paragraphs.
  const intern = new Map(); let token = 0;
  const ids = blocks => blocks.map(block => { if (!intern.has(block.text)) intern.set(block.text, ++token); return intern.get(block.text); });
  const anchors = lcs(ids(a), ids(b), (x, y) => x === y), budget = {used: 0, fallback: 0};
  const structural = structure(a, b, anchors, [left.meta.format, right.meta.format]);
  const result = {schema_version: 1, kind: 'text', status: 'complete', sources: {left: left.meta, right: right.meta}, rules: {mode: 'text', normalization: 'line_endings'}, summary: null, matched: [], changed: [], only_left: [], only_right: []};
  if (left.meta.format === 'pdf' || right.meta.format === 'pdf') result.rules.pdf_text_layer = true;
  let order = 0, i = 0, j = 0;
  function gap(ai, bi) {
    // Exact neighboring anchors bound a changed region; paired unmatched blocks
    // represent textual substitutions, not a claim of semantic equivalence.
    while (i < ai || j < bi) {
      while (i < ai && structural.consumedA.has(i)) {
        const item = structural.starts.get(i++);
        if (item) {
          result[item.category] ||= [];
          result[item.category].push({key: `text-${++order}`, left: item.left, right: item.right});
        }
      }
      while (j < bi && structural.consumedB.has(j)) j++;
      if (i < ai && j < bi) {
        const aa = a[i++], bb = b[j++];
        result.changed.push({key: `text-${++order}`, left: aa, right: bb, segments: segments(aa.text, bb.text, budget)});
      } else if (i < ai) result.only_left.push({key: `text-${++order}`, row: a[i++]});
      else if (j < bi) result.only_right.push({key: `text-${++order}`, row: b[j++]});
    }
  }
  for (const [ai, bi] of anchors) {
    gap(ai, bi); result.matched.push({key: `text-${++order}`, left: a[i++], right: b[j++]});
  }
  gap(a.length, b.length);
  const scope = result.rules.pdf_text_layer
    ? 'Извлечённые фрагменты выровнены по точным совпадениям и порядку. Перенос текста на другую страницу сам по себе не считается изменением текста. Пары различающихся фрагментов не означают смысловую эквивалентность.'
    : 'Абзацы выровнены по точным совпадениям и порядку. Пары различающихся абзацев показывают текстовую замену, а не смысловую эквивалентность.';
  result.sources.left.notes.push(scope); result.sources.right.notes.push(scope);
  const structuralNotes = [];
  if (result.moved) structuralNotes.push('Перемещение означает точное совпадение единственного фрагмента в каждом документе вне основного выравнивания. Исходный порядок восстанавливается по номерам блоков каждого документа.');
  if (result.rules.pdf_text_layer) {
    structuralNotes.push(`Проверка переносов объединяет до ${MAX_REFLOW_BLOCKS} соседних непустых блоков и до ${MAX_REFLOW_CHARS} символов одним пробелом; отдельные абзацы DOCX не объединяются. Совпадение должно быть точным и однозначным. Более длинные и неоднозначные варианты остаются обычными различиями. Исходные блоки сохраняются полностью.`);
    if (structural.reflowFallback) structuralNotes.push('Превышен бюджет проверки переносов строк: распознавание переносов отключено для этой пары документов. Все исходные фрагменты сохранены в обычном сравнении и точных перемещениях.');
  }
  for (const note of structuralNotes) { result.sources.left.notes.push(note); result.sources.right.notes.push(note); }
  if (budget.fallback) {
    const note = `Для ${budget.fallback} пар превышен бюджет подсветки слов: выделен абзац целиком. Текст сохранён полностью.`;
    result.sources.left.notes.push(note); result.sources.right.notes.push(note);
  }
  result.summary = {left_blocks: a.length, right_blocks: b.length, ...Object.fromEntries(['matched', 'changed', 'only_left', 'only_right'].map(name => [name, result[name].length]))};
  for (const category of ['moved', 'reflow']) if (result[category]) result.summary[category] = result[category].length;
  // Input text is capped at 1M characters across sources. The segment cap keeps
  // escaped text+evidence below the existing report budget in typical cases;
  // explicitly reject any pathological serialized expansion.
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16 * 1024 * 1024) fail('Текстовый отчёт превышает 16 МиБ. Разделите документы.');
  return result;
}
