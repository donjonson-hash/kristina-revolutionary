/** Native offline PDF export. Source strings are drawn as text, never actions or links. */
import {PDFDocument, fontkit, rgb} from './pdf-vendor.mjs';
import fontBase64 from './pdf-font.mjs';
import {renderJson, MAX_REPORT_BYTES} from './report.mjs';

export const MAX_PDF_PAGES = 200;
export const MAX_PDF_CHARACTERS = 1_000_000;
const LIMIT = 'PDF слишком большой. Разделите документы или сохраните полный отчёт HTML/JSON.';
const labels = {changed: 'Есть различия', only_left: 'Только в A', only_right: 'Только в B', matched: 'Совпали проверенные поля'};
const INK = rgb(.14, .22, .19), MUTED = rgb(.34, .39, .36);
const COLORS = {left: rgb(1, .90, .86), right: rgb(.87, .95, .89), neutral: rgb(.94, .95, .93)};
const money = value => value === null ? 'не рассчитано' : String(value).replace('.', ',');
const location = row => row ? `${row.sheet ? 'лист «' + row.sheet + '», ' : ''}строка ${row.record}${row.cells ? ', ячейки ' + Object.values(row.cells).join(', ') : ''}` : 'позиции нет';

function contents(report) {
  const sections = []; let characters = 0, currentContext = '';
  function add(text, options = {}) {
    const segments = typeof text === 'string' ? [{text, changed: false}] : text;
    characters += segments.reduce((sum, segment) => sum + segment.text.length, 0);
    if (characters > MAX_PDF_CHARACTERS) throw new RangeError(LIMIT);
    sections.push({segments, size: 10.5, gap: 4, context: currentContext, ...options});
  }
  const heading = text => { currentContext = text; add(text, {size: 14, heading: true, gap: 10}); };
  add('Кристина · отчёт о сверке', {size: 21, gap: 13});
  add('Сравнение выполнено локально. Исходная вёрстка документов не воспроизводится.', {muted: true});
  add(`Изменились: ${report.summary.changed}; только в A: ${report.summary.only_left}; только в B: ${report.summary.only_right}; совпали: ${report.summary.matched}.`);
  add('Совпавшие пары опущены. Полное извлечённое содержимое доступно в HTML/JSON-отчёте. Исходные файлы следует хранить отдельно.', {muted: true});
  add('Красная подсветка — значение A; зелёная — значение B.', {muted: true});
  add(`A: ${report.sources.left.name}`);
  add(`B: ${report.sources.right.name}`);
  if (report.commercial) {
    const summary = report.commercial;
    heading('Количество, цена и сумма');
    const status = {complete: 'Расчёт по всем позициям', partial: 'Частичный расчёт', unavailable: 'Сумма не рассчитана'}[summary.status];
    add(`${status}: ${summary.coverage.included} из ${summary.coverage.total} позиций. Исключено: ${summary.coverage.excluded ?? summary.excluded.length}.`);
    add(`Изменение количества: ${summary.counts.quantity_changed ?? 'не проверено'}; изменение цены: ${summary.counts.price_changed ?? 'не проверено'}.`);
    add(summary.scope, {muted: true});
    for (const total of summary.totals) add(`${total.currency}: A ${money(total.before)} → B ${money(total.after)}; B − A: ${money(total.delta)}.${summary.status === 'partial' ? ' Это не итог всех позиций.' : ''}`, {fill: 'neutral'});
    for (const message of summary.messages) add(message, {muted: true});
  }
  heading('Обнаруженные различия');
  const rows = ['changed', 'only_left', 'only_right'].flatMap(category => report[category].map(item => ({item, category})));
  const record = ({item, category}, side) => item[side]?.record ?? (category === `only_${side}` ? item.row.record : Infinity);
  rows.sort(report.kind === 'text' ? (a, b) => Number(a.item.key.slice(5)) - Number(b.item.key.slice(5)) : (a, b) => record(a, 'left') - record(b, 'left') || record(a, 'right') - record(b, 'right'));
  if (!rows.length) add('Различий по выполненным правилам не обнаружено.');
  for (const {item, category} of rows) {
    const context = `${item.key} · ${labels[category]}`;
    add(context, {size: 12, heading: true, fill: 'neutral', context});
    const only = category !== 'changed';
    if (report.kind === 'text') {
      for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
        const block = only ? (category === `only_${side}` ? item.row : null) : item[side];
        if (!block) { add(`${label}: сопоставленного блока нет.`, {muted: true, context}); continue; }
        add(`${label}: ${block.location} · блок ${block.record}`, {muted: true, context});
        let segments = [{text: block.text, changed: true}];
        if (!only) {
          segments = item.segments?.[side];
          if (!Array.isArray(segments) || segments.some(segment => typeof segment.text !== 'string' || typeof segment.changed !== 'boolean') || segments.map(segment => segment.text).join('') !== block.text) throw new TypeError('PDF: подсветка не соответствует исходному тексту. Повторите сверку.');
        }
        add(segments, {side, context});
        if (block.text === '') add('(Пустой текстовый блок)', {muted: true, context});
      }
    } else if (!only) {
      add(`A: ${location(item.left)}; B: ${location(item.right)}.`, {muted: true, context});
      for (const change of item.changes) {
        add(`A «${change.left_column}» → B «${change.right_column}»`, {context, keepNext: 2});
        add(`A: ${change.before === '' ? '(пустое значение)' : change.before}`, {fill: 'left', context});
        add(`B: ${change.after === '' ? '(пустое значение)' : change.after}`, {fill: 'right', context});
      }
    } else {
      const side = category === 'only_left' ? 'left' : 'right', label = side === 'left' ? 'A' : 'B';
      add(`${label}: ${location(item.row)}. Парной записи нет.`, {muted: true, context});
      for (const column of report.sources[side].headers) add(`${column}${item.row.cells?.[column] ? ' [' + item.row.cells[column] + ']' : ''}: ${item.row.values[column] === '' ? '(пустое значение)' : item.row.values[column]}`, {fill: side, context});
    }
  }
  if (report.commercial) {
    const summary = report.commercial;
    heading('Расчёт по позициям');
    for (const item of summary.items) {
      add(`${item.key}: A ${money(item.before)} → B ${money(item.after)}; B − A: ${money(item.delta)} ${item.currency}.`, {context: 'Расчёт по позициям'});
      add(`A: ${location(item.left)}; B: ${location(item.right)}.`, {muted: true, context: 'Расчёт по позициям'});
    }
    for (const item of summary.excluded) add(`${item.key} — исключено: ${item.reasons.join(' ')}`, {context: 'Исключённые позиции'});
  }
  heading('Правила и границы проверки');
  if (report.kind === 'text') {
    add('Режим: сравнение извлечённого текста. Переводы строк приведены к единому виду; пробелы и регистр учитываются. Это не оценка юридического смысла, достоверности или орфографии. Отсутствие блока означает отсутствие сопоставленного текста, а не установленную причину изменения.');
  } else {
    add(`Ключ: A «${report.rules.key[0]}» ↔ B «${report.rules.key[1]}».`);
    for (const [a, b, mode] of report.rules.fields) add(`A «${a}» ↔ B «${b}» — ${mode === 'number' ? 'число' : 'текст'}.`);
    add(report.rules.strip ? 'Пробелы по краям значений и ключей удалялись перед сравнением.' : 'Пробелы по краям значений и ключей учитывались.');
    const delimiter = report.rules.delimiter;
    const delimiterName = delimiter === '\t' ? 'табуляция' : delimiter === ',' ? 'запятая' : delimiter === ';' ? 'точка с запятой' : `«${delimiter}»`;
    add(`Разделитель CSV/TSV: ${delimiterName}. Текст сравнивается с учётом регистра. Числовые поля сравниваются как десятичные числа; единицы и валюты не пересчитываются.`);
    add('Поля вне правил не проверялись. Номер записи CSV включает заголовок и может отличаться от физической строки при переносах внутри ячейки.');
  }
  heading('Источники');
  for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
    const source = report.sources[side];
    add(`${label}: ${source.name}`);
    add(`SHA-256: ${source.sha256}`, {size: 10, muted: true});
    add(report.kind === 'text' ? `Формат: ${source.format}; текстовых блоков: ${source.block_count}.` : `Строк данных: ${source.row_count}.${source.sheet ? ' Проверен только лист «' + source.sheet + '».' : ''}`, {muted: true});
  }
  const leftNotes = new Set(report.sources.left.notes || []);
  const rightNotes = new Set(report.sources.right.notes || []);
  const commonNotes = [...leftNotes].filter(note => rightNotes.has(note));
  if (commonNotes.length) {
    heading('Пояснения для обоих файлов');
    for (const note of commonNotes) add(note, {muted: true});
  }
  for (const [notes, other, label] of [[leftNotes, rightNotes, 'A'], [rightNotes, leftNotes, 'B']]) {
    const unique = [...notes].filter(note => !other.has(note));
    if (unique.length) {
      heading(`Особенности файла ${label}`);
      for (const note of unique) add(note, {muted: true});
    }
  }
  add('Неподдерживаемые символы и управляющие коды обозначаются [U+XXXX], табуляция — \\t, возврат каретки — \\r. Точные исходные символы сохраняются в JSON.', {muted: true});
  return sections;
}

/** Complete report only; no network, browser printing, or source-derived PDF actions. */
export async function renderPdf(report) {
  if (!report || report.status !== 'complete') throw new TypeError('PDF доступен после завершённой сверки. Сначала уточните параметры.');
  // Same serialized evidence budget as existing HTML/JSON exports, before font work.
  try { renderJson(report); } catch (error) {
    if (error instanceof RangeError) throw new RangeError(LIMIT);
    throw error;
  }
  const sections = contents(report);
  const pdf = await PDFDocument.create();
  pdf.setTitle('Кристина — отчёт о сверке'); pdf.setProducer('Kristina offline reconciliation');
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
    page.drawText('КРИСТИНА / СВЕРКА ДОКУМЕНТОВ', {x: MARGIN, y: HEIGHT - 34, font, size: 9, color: MUTED});
    page.drawLine({start: {x: MARGIN, y: HEIGHT - 43}, end: {x: WIDTH - MARGIN, y: HEIGHT - 43}, thickness: .5, color: rgb(.80, .84, .81)});
    if (context) {
      // Context is a convenience label; full key remains in the report body.
      let label = 'Продолжение: ' + printable(Array.from(context).slice(0, 140).join('')).replaceAll('\n', ' '), truncated = context.length > 140;
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
  newPage();
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index], lines = linesFor(index);
    if (section.heading && y - section.size * 1.45 - 30 < BOTTOM) newPage();
    if (section.keepNext) {
      let height = 0;
      for (let next = index; next <= Math.min(index + section.keepNext, sections.length - 1); next++) height += linesFor(next).length * sections[next].size * 1.45 + sections[next].gap;
      if (height <= TOP - BOTTOM - 19 && y - height < BOTTOM) newPage(section.context);
    }
    for (const line of lines) drawLine(line, section);
    wrapped.delete(index);
    y -= section.gap;
  }
  for (const [index, current] of pdf.getPages().entries()) {
    current.drawText(`Кристина · ${index + 1} / ${pageNumber}`, {x: MARGIN, y: 27, font, size: 9, color: MUTED});
  }
  const result = await pdf.save();
  if (result.byteLength > MAX_REPORT_BYTES) throw new RangeError(LIMIT);
  return result;
}
