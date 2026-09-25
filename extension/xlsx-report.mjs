/** Frozen, local XLSX evidence. Never evaluate formulas or round source decimals. */
import {write, utils} from './xlsx-vendor.mjs';
import {MAX_REPORT_BYTES} from './report.mjs';

const MAX_CELLS = 250000, MAX_ROWS = 50000, MAX_CELL_CHARS = 32767;
const labels = {changed: 'Есть различия', matched: 'Совпали проверенные поля', only_left: 'Только в A', only_right: 'Только в B'};
const statuses = {complete: 'Расчёт по всем позициям', partial: 'Частичный расчёт — не итог всего документа', unavailable: 'Сумма не рассчитана'};
const tooLarge = () => { throw new RangeError('XLSX-отчёт слишком большой (лимит 16 MiB, 250 000 ячеек, 50 000 строк). Разделите исходные списки.'); };
const encoder = new TextEncoder();
const text = value => value === null || value === undefined ? '' : String(value);
// SheetJS escapes XML but does not protect literal SpreadsheetML escape syntax.
const cellText = value => text(value).replace(/_x[0-9a-f]{4}_/gi, token => '_x005F_' + token.slice(1));
const location = row => !row ? 'Нет позиции' : `${row.sheet ? row.sheet + ': ' : ''}запись ${row.record}${row.cells ? '; ' + Object.values(row.cells).join(', ') : ''}`;

function* sourceRows(report, side) {
  const rows = [];
  for (const category of ['matched', 'changed']) for (const item of report[category]) rows.push(item[side]);
  for (const item of report[`only_${side}`]) rows.push(item.row);
  rows.sort((a, b) => a.record - b.record);
  yield* rows;
}

function* summaryRows(report) {
  yield ['Кристина — результат сверки', 'Значение', 'A', 'B', 'Изменение B − A', 'Источник A', 'Источник B'];
  yield ['Формат отчёта', 'Зафиксированный результат: исходные значения и суммы сохранены как текст без формул и пересчёта.'];
  yield ['Область проверки', 'Совпадение относится только к выбранным полям. Полные извлечённые данные находятся на листах «Данные A/B»; исходная вёрстка не воспроизводится.'];
  for (const key of ['matched', 'changed', 'only_left', 'only_right']) yield [labels[key], report.summary[key]];
  yield ['Записей данных A', report.summary.left_rows];
  yield ['Записей данных B', report.summary.right_rows];
  const c = report.commercial;
  if (!c) { yield ['Денежный расчёт', 'Не выполнялся']; return; }
  yield ['Денежный расчёт', statuses[c.status]];
  yield ['Рассчитано позиций', c.coverage.included];
  yield ['Всего позиций', c.coverage.total];
  yield ['Исключено позиций', c.coverage.excluded];
  yield ['Изменение количества', c.counts.quantity_changed ?? 'Не проверено'];
  yield ['Изменение цены', c.counts.price_changed ?? 'Не проверено'];
  yield ['Область денежного расчёта', c.scope];
  yield ['Отсутствующая позиция', 'Ноль в сумме означает отсутствие вклада в список, а не нулевое количество или факт поставки.'];
  yield ['Валюты', 'Итоги разных валют не складываются и не конвертируются.'];
  for (const message of c.messages) yield ['Пояснение', message];
  for (const total of c.totals) yield ['Итог по рассчитанным позициям', total.currency, total.before, total.after, total.delta];
  for (const item of c.items) yield [`Позиция: ${item.key}`, `${labels[item.category]}; ${item.currency}; ${item.unit}`, item.before, item.after, item.delta, location(item.left), location(item.right)];
  for (const item of c.excluded) for (const reason of item.reasons) yield [`Исключена: ${item.key}`, reason];
}

function* differenceRows(report) {
  yield ['Результат', 'Ключ', 'Столбец A', 'Столбец B', 'Значение A', 'Значение B', 'Запись A', 'Лист A', 'Ячейка A', 'Запись B', 'Лист B', 'Ячейка B'];
  for (const item of report.changed) for (const change of item.changes) yield [labels.changed, item.key, change.left_column, change.right_column, change.before, change.after,
    item.left.record, item.left.sheet, item.left.cells?.[change.left_column], item.right.record, item.right.sheet, item.right.cells?.[change.right_column]];
  for (const side of ['left', 'right']) for (const item of report[`only_${side}`]) {
    const row = item.row;
    yield [labels[`only_${side}`], item.key, '', '', side === 'left' ? 'См. лист «Данные A»' : 'Нет позиции', side === 'right' ? 'См. лист «Данные B»' : 'Нет позиции',
      side === 'left' ? row.record : '', side === 'left' ? row.sheet : '', '', side === 'right' ? row.record : '', side === 'right' ? row.sheet : '', ''];
  }
}

function* dataRows(report, side) {
  const headers = report.sources[side].headers;
  yield ['Исходная запись', 'Исходный лист', 'Исходные ячейки (в порядке столбцов)', ...headers];
  for (const row of sourceRows(report, side)) yield [row.record, row.sheet, row.cells ? headers.map(header => row.cells[header] || '').join(', ') : '', ...headers.map(header => row.values[header])];
}

function* ruleRows(report) {
  yield ['Раздел', 'A / параметр', 'B / значение', 'Режим / пояснение'];
  yield ['Ключ сопоставления', ...report.rules.key, 'Идентификатор строки'];
  for (const field of report.rules.fields) yield ['Проверенное поле', ...field];
  yield ['Пробелы по краям', report.rules.strip ? 'Удалялись при сравнении' : 'Учитывались при сравнении', '', 'Исходные значения в книге сохранены без изменений'];
  yield ['Текст', 'С учётом регистра'];
  yield ['Числа', 'Только выбранные числовые поля; без пересчёта единиц и валют'];
  yield ['Номер записи', 'Включает заголовок. Для CSV с переносами внутри ячейки это не номер физической строки.'];
  for (const [side, label, index] of [['left', 'A', 0], ['right', 'B', 1]]) {
    const source = report.sources[side], checked = new Set([report.rules.key[index], ...report.rules.fields.map(field => field[index])]);
    yield [`Источник ${label}`, source.name];
    yield [`SHA-256 ${label}`, source.sha256];
    yield [`Записей ${label}`, source.row_count];
    if (source.sheet) yield [`Выбранный лист ${label}`, source.sheet, '', 'Другие листы не проверялись'];
    for (const note of source.notes || []) yield [`Особенность ${label}`, note];
    for (const header of source.headers) if (!checked.has(header)) yield [`Не проверялось ${label}`, header, '', 'Значения сохранены на листе данных'];
  }
}

/** @returns {Uint8Array} A complete, frozen tabular report; never an executable workbook. */
export function renderXlsx(report) {
  if (!report || report.status !== 'complete') throw new Error('XLSX-отчёт доступен после завершения сверки. Сначала уточните правила сравнения.');
  if (report.kind === 'text') throw new Error('XLSX-отчёт доступен только для сверки таблиц. Для текстовых документов используйте PDF или HTML.');
  // Check cardinality before constructing sorted row lists or worksheet objects.
  const categories = ['matched', 'changed', 'only_left', 'only_right'];
  for (const category of categories) if (!Array.isArray(report[category]) || report[category].length > MAX_ROWS) tooLarge();
  for (const side of ['left', 'right']) {
    const n = report.matched.length + report.changed.length + report[`only_${side}`].length;
    if (n > MAX_ROWS || !Array.isArray(report.sources?.[side]?.headers) || report.sources[side].headers.length > 200 || (n + 1) * (report.sources[side].headers.length + 3) > MAX_CELLS) tooLarge();
  }
  const sheets = [
    ['Сводка', () => summaryRows(report), [36, 70, 28, 28, 28, 40, 40], false],
    ['Различия', () => differenceRows(report), [28, 25, 24, 24, 40, 40, 14, 24, 14, 14, 24, 14], true],
    ['Данные A', () => dataRows(report, 'left'), [18, 24, 40, ...report.sources.left.headers.map(() => 26)], true],
    ['Данные B', () => dataRows(report, 'right'), [18, 24, 40, ...report.sources.right.headers.map(() => 26)], true],
    ['Правила', () => ruleRows(report), [28, 70, 40, 70], true],
  ];
  // First pass validates every string and bounds XML/objects before workbook allocation.
  let cells = 0, rows = 0, estimatedBytes = 32768;
  for (const [name, generate] of sheets) for (const row of generate()) {
    if (++rows > MAX_ROWS || (cells += row.length) > MAX_CELLS) tooLarge();
    estimatedBytes += 64;
    for (const value of row) {
      const s = text(value);
      if (s.length > MAX_CELL_CHARS || cellText(s).length > MAX_CELL_CHARS) throw new RangeError(`XLSX: лист «${name}» содержит значение длиннее 32 767 символов. Используйте HTML/JSON или разделите данные; значения не обрезались.`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/u.test(s)) throw new Error(`XLSX: лист «${name}» содержит символ, недопустимый в XML. Используйте JSON; исходное значение не изменялось.`);
      estimatedBytes += 96 + encoder.encode(s).byteLength + (s.match(/[&<>"']/g)?.length || 0) * 5 + (s.match(/_x[0-9a-f]{4}_/gi)?.length || 0) * 7;
      if (estimatedBytes > MAX_REPORT_BYTES) tooLarge();
    }
  }
  const book = utils.book_new();
  book.Props = {Title: 'Кристина — результат сверки', Subject: 'Зафиксированные значения без формул', Author: 'Кристина'};
  for (const [name, generate, widths, filter] of sheets) {
    const sheet = {}, colNames = widths.map((_, i) => utils.encode_col(i));
    let count = 0, columns = 0;
    for (const row of generate()) {
      count++; columns = Math.max(columns, row.length);
      row.forEach((value, column) => { sheet[`${colNames[column]}${count}`] = {t: 's', v: cellText(value), z: '@'}; });
    }
    sheet['!ref'] = `A1:${utils.encode_col(columns - 1)}${count}`;
    sheet['!cols'] = widths.map(wch => ({wch}));
    if (filter && count > 1) sheet['!autofilter'] = {ref: sheet['!ref']};
    utils.book_append_sheet(book, sheet, name);
  }
  const output = new Uint8Array(write(book, {bookType: 'xlsx', type: 'array', compression: true, bookSST: false}));
  if (output.byteLength > MAX_REPORT_BYTES) tooLarge();
  return output;
}
