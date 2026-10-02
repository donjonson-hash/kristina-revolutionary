/** Native offline PDF export. Source strings are drawn as text, never actions or links. */
import {PDFDocument, fontkit, rgb} from './pdf-vendor.mjs';
import fontBase64 from './pdf-font.mjs';
import {renderJson, MAX_REPORT_BYTES} from './report.mjs';

export const MAX_PDF_PAGES = 200;
export const MAX_PDF_CHARACTERS = 1_000_000;
const LIMIT = "The PDF is too large. Split the documents or save the full HTML/JSON report.";
const labels = {changed: "Differences found", only_left: "Only in A", only_right: "Only in B", moved: "Moved without text changes", reflow: "Line breaks changed", matched: "Checked fields match"};
const INK = rgb(.14, .22, .19), MUTED = rgb(.34, .39, .36);
const COLORS = {left: rgb(1, .90, .86), right: rgb(.87, .95, .89), neutral: rgb(.94, .95, .93)};
const money = value => value === null ? "not calculated" : String(value).replace('.', ',');
const location = row => row ? `${row.sheet ? "sheet «" + row.sheet + '», ' : ''}row ${row.record}${row.cells ? ", cells " + Object.values(row.cells).join(', ') : ''}` : "item missing";

function contents(report) {
  const sections = []; let characters = 0, currentContext = '';
  function add(text, options = {}) {
    const segments = typeof text === 'string' ? [{text, changed: false}] : text;
    characters += segments.reduce((sum, segment) => sum + segment.text.length, 0);
    if (characters > MAX_PDF_CHARACTERS) throw new RangeError(LIMIT);
    sections.push({segments, size: 10.5, gap: 4, context: currentContext, ...options});
  }
  const heading = text => { currentContext = text; add(text, {size: 14, heading: true, gap: 10}); };
  add("Compare These Texts · comparison report", {size: 21, gap: 13});
  add(report.kind === 'text' ? "Text is compared; formatting and images are not checked." : "Selected fields are compared.", {muted: true});
  add(`Changed: ${report.summary.changed}; only in A: ${report.summary.only_left}; only in B: ${report.summary.only_right}; matched: ${report.summary.matched}.`);
  if (report.kind === 'text' && (report.moved?.length || report.reflow?.length)) {
    add(`Separately: moved without text changes — ${report.moved?.length || 0}; groups with changed line breaks — ${report.reflow?.length || 0}.`);
  }
  add("Only differences are shown.", {muted: true});
  add("Red highlights show values from A; green highlights show values from B.", {muted: true});
  add(`A: ${report.sources.left.name}`);
  add(`B: ${report.sources.right.name}`);
  for (const [side, label] of [['left', 'A'], ['right', 'B']]) if (report.sources[side].sheet) add(`${label}: checked only sheet «${report.sources[side].sheet}».`, {muted: true});
  if (report.commercial) {
    const summary = report.commercial;
    heading("Quantity, price, and amount");
    const status = {complete: "All items calculated", partial: "Partial calculation", unavailable: "Amount not calculated"}[summary.status];
    add(`${status}: ${summary.coverage.included} of ${summary.coverage.total} items. Excluded: ${summary.coverage.excluded ?? summary.excluded.length}.`);
    add(`Quantity changes: ${summary.counts.quantity_changed ?? "not checked"}; price changes: ${summary.counts.price_changed ?? "not checked"}.`);
    add(summary.scope, {muted: true});
    for (const total of summary.totals) add(`${total.currency}: A ${money(total.before)} → B ${money(total.after)}; B − A: ${money(total.delta)}.${summary.status === 'partial' ? " This is not the total for all items." : ''}`, {fill: 'neutral'});
    for (const message of summary.messages) add(message, {muted: true});
  }
  heading("Differences found");
  const categories = report.kind === 'text' ? ['changed', 'only_left', 'only_right', 'moved', 'reflow'] : ['changed', 'only_left', 'only_right'];
  const rows = categories.flatMap(category => (report[category] || []).map(item => ({item, category})));
  const record = ({item, category}, side) => item[side]?.record ?? (category === `only_${side}` ? item.row.record : Infinity);
  rows.sort(report.kind === 'text' ? (a, b) => Number(a.item.key.slice(5)) - Number(b.item.key.slice(5)) : (a, b) => record(a, 'left') - record(b, 'left') || record(a, 'right') - record(b, 'right'));
  if (!rows.length) add("No differences found.");
  for (const {item, category} of rows) {
    const context = report.kind === 'text' ? labels[category] : `${item.key} · ${labels[category]}`;
    add(context, {size: 12, heading: true, fill: 'neutral', context});
    const only = category === 'only_left' || category === 'only_right';
    if (report.kind === 'text') {
      if (category === 'moved') {
        if (item.left.text !== item.right.text) throw new TypeError("PDF: the text of a moved block differs. Run the comparison again.");
        add(`A: ${item.left.location}`, {muted: true, context, keepNext: 2});
        add(`B: ${item.right.location}`, {muted: true, context});
        add(item.left.text, {context});
        continue;
      }
      for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
        const block = only ? (category === `only_${side}` ? item.row : null) : item[side];
        if (!block) { add(`${label}: no matching block.`, {muted: true, context}); continue; }
        add(`${label}: ${block.location}`, {muted: true, context, keepNext: 1});
        let segments = [{text: block.text, changed: only}];
        if (category === 'changed') {
          segments = item.segments?.[side];
          if (!Array.isArray(segments) || segments.some(segment => typeof segment.text !== 'string' || typeof segment.changed !== 'boolean') || segments.map(segment => segment.text).join('') !== block.text) throw new TypeError("PDF: highlights do not match the source text. Run the comparison again.");
        }
        add(segments, {side, context});
        if (block.text === '') add("(Empty text block)", {muted: true, context});
      }
    } else if (!only) {
      add(`A: ${location(item.left)}; B: ${location(item.right)}.`, {muted: true, context});
      for (const change of item.changes) {
        add(`A «${change.left_column}» → B «${change.right_column}»`, {context, keepNext: 2});
        add(`A: ${change.before === '' ? "(empty value)" : change.before}`, {fill: 'left', context});
        add(`B: ${change.after === '' ? "(empty value)" : change.after}`, {fill: 'right', context});
      }
    } else {
      const side = category === 'only_left' ? 'left' : 'right', label = side === 'left' ? 'A' : 'B';
      add(`${label}: ${location(item.row)}. No paired record.`, {muted: true, context});
      for (const column of report.sources[side].headers) add(`${column}${item.row.cells?.[column] ? ' [' + item.row.cells[column] + ']' : ''}: ${item.row.values[column] === '' ? "(empty value)" : item.row.values[column]}`, {fill: side, context});
    }
  }
  if (report.commercial) {
    const summary = report.commercial;
    heading("Item calculations");
    for (const item of summary.items) {
      add(`${item.key}: A ${money(item.before)} → B ${money(item.after)}; B − A: ${money(item.delta)} ${item.currency}.`, {context: "Item calculations"});
      add(`A: ${location(item.left)}; B: ${location(item.right)}.`, {muted: true, context: "Item calculations"});
    }
    for (const item of summary.excluded) add(`${item.key} — excluded: ${item.reasons.join(' ')}`, {context: "Excluded items"});
  }
  return sections;
}

/** Complete report only; no network, browser printing, or source-derived PDF actions. */
export async function renderPdf(report) {
  if (!report || report.status !== 'complete') throw new TypeError("PDF is available after a completed comparison. Clarify the settings first.");
  // Same serialized evidence budget as existing HTML/JSON exports, before font work.
  try { renderJson(report); } catch (error) {
    if (error instanceof RangeError) throw new RangeError(LIMIT);
    throw error;
  }
  const sections = contents(report);
  const pdf = await PDFDocument.create();
  pdf.setTitle("Compare These Texts — comparison report"); pdf.setProducer('Kristina offline reconciliation');
  pdf.registerFontkit(fontkit);
  const bytes = Uint8Array.from(atob(fontBase64), character => character.charCodeAt(0));
  const font = await pdf.embedFont(bytes, {subset: true, features: {liga: false}});
  const supported = new Set(font.getCharacterSet());
  let convertedCharacters = 0;
  function printable(text) {
    let output = '';
    for (const char of text) {
      const code = char.codePointAt(0);
      const value = char === '\n' ? char : char === '\t' ? '\\t' : char === '\r' ? '\\r' : (!supported.has(code) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(char)) ? `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]` : char;
      convertedCharacters += value.length;
      if (convertedCharacters > MAX_PDF_CHARACTERS) throw new RangeError(LIMIT);
      output += value;
    }
    return output;
  }
  const WIDTH = 595.28, HEIGHT = 841.89, MARGIN = 42, BOTTOM = 48, TOP = 777;
  const lineWidth = WIDTH - MARGIN * 2 - 8;
  let page, y, pageNumber = 0;
  const widthCache = new Map();
  const width = (char, size) => {
    const key = size + ':' + char;
    if (!widthCache.has(key)) widthCache.set(key, font.widthOfTextAtSize(char, size));
    return widthCache.get(key);
  };
  function newPage(context = '') {
    if (++pageNumber > MAX_PDF_PAGES) throw new RangeError(LIMIT);
    page = pdf.addPage([WIDTH, HEIGHT]); y = TOP;
    page.drawText("CTT / DOCUMENT COMPARISON", {x: MARGIN, y: HEIGHT - 34, font, size: 9, color: MUTED});
    page.drawLine({start: {x: MARGIN, y: HEIGHT - 43}, end: {x: WIDTH - MARGIN, y: HEIGHT - 43}, thickness: .5, color: rgb(.80, .84, .81)});
    if (context) {
      // Context is a convenience label; full key remains in the report body.
      let label = "Continued: " + printable(Array.from(context).slice(0, 140).join('')).replaceAll('\n', ' '), truncated = context.length > 140;
      while (font.widthOfTextAtSize(label, 9) > lineWidth && label.length) { label = Array.from(label).slice(0, -1).join(''); truncated = true; }
      page.drawText(label + (truncated ? '…' : ''), {x: MARGIN, y, font, size: 9, color: MUTED}); y -= 19;
    }
  }
  function drawLine(chars, section) {
    const size = section.size, height = size * 1.45;
    if (y - height < BOTTOM) newPage(section.context);
    let x = MARGIN + 4;
    if (section.fill) page.drawRectangle({x: MARGIN, y: y - 4, width: WIDTH - MARGIN * 2, height, color: COLORS[section.fill]});
    const runs = [];
    for (const char of chars) {
      const previous = runs[runs.length - 1];
      if (previous && previous.changed === char.changed) previous.text += char.text;
      else runs.push({...char});
    }
    for (const run of runs) {
      const advance = font.widthOfTextAtSize(run.text, size);
      if (run.changed && section.side) page.drawRectangle({x, y: y - 3, width: advance, height: size * 1.25, color: COLORS[section.side]});
      if (run.text) page.drawText(run.text, {x, y, size, font, color: section.muted ? MUTED : INK});
      x += advance;
    }
    y -= height;
  }
  // Cache only the current short group. Keep a field label with both values when
  // the group fits a page; long values still paginate instead of being clipped.
  const wrapped = new Map();
  function linesFor(index) {
    if (wrapped.has(index)) return wrapped.get(index);
    const section = sections[index], lines = [];
    let line = [], used = 0;
    const flush = count => {
      lines.push(line.splice(0, count));
      used = line.reduce((sum, char) => sum + width(char.text, section.size), 0);
    };
    for (const segment of section.segments) for (const char of printable(segment.text)) {
      if (char === '\n') { flush(line.length); continue; }
      const advance = width(char, section.size);
      if (line.length && used + advance > lineWidth - 4) {
        let breakAt = -1;
        for (let i = line.length - 1; i >= 0; i--) if (line[i].text === ' ') { breakAt = i + 1; break; }
        flush(breakAt > 0 ? breakAt : line.length);
        if (line.length && used + advance > lineWidth - 4) flush(line.length);
      }
      line.push({text: char, changed: segment.changed}); used += advance;
    }
    if (line.length) flush(line.length);
    wrapped.set(index, lines); return lines;
  }
  // Measure drawing space, excluding the unused gap after the final paragraph.
  function groupHeight(start, end) {
    let height = 0;
    for (let i = start; i <= end; i++) {
      height += linesFor(i).length * sections[i].size * 1.45;
      if (i < end) height += sections[i].gap;
    }
    return height;
  }
  newPage();
  let protectedUntil = -1;
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index], lines = linesFor(index);
    if (index > protectedUntil) {
      let end = index;
      // Follow heading/field groups so a later paragraph cannot strand its heading.
      for (let i = index; i <= end; i++) {
        end = Math.min(sections.length - 1, Math.max(end, i + (sections[i].keepNext || (sections[i].heading ? 1 : 0))));
      }
      const context = section.heading ? '' : section.context;
      const capacity = TOP - BOTTOM - (context ? 19 : 0);
      let height = groupHeight(index, end);
      protectedUntil = end;
      if (height > capacity) {
        height = groupHeight(index, index);
        protectedUntil = index;
        if (section.heading && index + 1 < sections.length) {
          // A very long paragraph may split, but starts beside its heading.
          const next = sections[index + 1];
          height += section.gap + Math.min(2, linesFor(index + 1).length) * next.size * 1.45;
          protectedUntil = index + 1;
        }
      }
      if (height <= capacity && y - height < BOTTOM) newPage(context);
    }
    for (const line of lines) drawLine(line, section);
    wrapped.delete(index);
    y -= section.gap;
  }
  for (const [index, current] of pdf.getPages().entries()) {
    current.drawText(`CTT · ${index + 1} / ${pageNumber}`, {x: MARGIN, y: 27, font, size: 9, color: MUTED});
  }
  const result = await pdf.save();
  if (result.byteLength > MAX_REPORT_BYTES) throw new RangeError(LIMIT);
  return result;
}
