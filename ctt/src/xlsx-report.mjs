/** Frozen, local XLSX evidence. Never evaluate formulas or round source decimals. */
import {write, utils} from './xlsx-vendor.mjs';
import {MAX_REPORT_BYTES} from './report.mjs';

const MAX_CELLS = 250000, MAX_ROWS = 50000, MAX_CELL_CHARS = 32767;
const labels = {changed: "Differences found", matched: "Checked fields match", only_left: "Only in A", only_right: "Only in B"};
const statuses = {complete: "All items calculated", partial: "Partial calculation — not the full document total", unavailable: "Amount not calculated"};
const tooLarge = () => { throw new RangeError("The XLSX report is too large (limit: 16 MiB, 250,000 cells, 50,000 rows). Split the source lists."); };
const encoder = new TextEncoder();
const text = value => value === null || value === undefined ? '' : String(value);
// SheetJS escapes XML but does not protect literal SpreadsheetML escape syntax.
const cellText = value => text(value).replace(/_x[0-9a-f]{4}_/gi, token => '_x005F_' + token.slice(1));
const location = row => !row ? "Item missing" : `${row.sheet ? row.sheet + ': ' : ''}record ${row.record}${row.cells ? '; ' + Object.values(row.cells).join(', ') : ''}`;

function* sourceRows(report, side) {
  const rows = [];
  for (const category of ['matched', 'changed']) for (const item of report[category]) rows.push(item[side]);
  for (const item of report[`only_${side}`]) rows.push(item.row);
  rows.sort((a, b) => a.record - b.record);
  yield* rows;
}

function* summaryRows(report) {
  yield ["Compare These Texts — comparison results", "Value", 'A', 'B', "Change B − A", "Source A", "Source B"];
  yield ["Comparison scope", "Selected fields are compared. Original values are on the Data A and Data B sheets."];
  for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
    yield [`File ${label}`, report.sources[side].name];
    if (report.sources[side].sheet) yield [`Sheet ${label}`, report.sources[side].sheet, "Other sheets were not checked"];
  }
  for (const key of ['matched', 'changed', 'only_left', 'only_right']) yield [labels[key], report.summary[key]];
  yield ["Data records A", report.summary.left_rows];
  yield ["Data records B", report.summary.right_rows];
  const c = report.commercial;
  if (!c) { yield ["Amount calculation", "Not performed"]; return; }
  yield ["Amount calculation", statuses[c.status]];
  yield ["Items calculated", c.coverage.included];
  yield ["Total items", c.coverage.total];
  yield ["Items excluded", c.coverage.excluded];
  yield ["Quantity changes", c.counts.quantity_changed ?? "Not checked"];
  yield ["Price changes", c.counts.price_changed ?? "Not checked"];
  yield ["Amount calculation scope", c.scope];
  yield ["Missing item", "A zero amount means no contribution to the list total, not a zero quantity or confirmation of delivery."];
  yield ["Currencies", "Totals in different currencies are not added together or converted."];
  for (const message of c.messages) yield ["Explanation", message];
  for (const total of c.totals) yield ["Total for calculated items", total.currency, total.before, total.after, total.delta];
  for (const item of c.items) yield [`Item: ${item.key}`, `${labels[item.category]}; ${item.currency}; ${item.unit}`, item.before, item.after, item.delta, location(item.left), location(item.right)];
  for (const item of c.excluded) for (const reason of item.reasons) yield [`Excluded: ${item.key}`, reason];
}

function* differenceRows(report) {
  yield ["Result", "Key", "Column A", "Column B", "Value A", "Value B", "Record A", "Sheet A", "Cell A", "Record B", "Sheet B", "Cell B"];
  for (const item of report.changed) for (const change of item.changes) yield [labels.changed, item.key, change.left_column, change.right_column, change.before, change.after,
    item.left.record, item.left.sheet, item.left.cells?.[change.left_column], item.right.record, item.right.sheet, item.right.cells?.[change.right_column]];
  for (const side of ['left', 'right']) for (const item of report[`only_${side}`]) {
    const row = item.row;
    yield [labels[`only_${side}`], item.key, '', '', side === 'left' ? "See the Data A sheet" : "Item missing", side === 'right' ? "See the Data B sheet" : "Item missing",
      side === 'left' ? row.record : '', side === 'left' ? row.sheet : '', '', side === 'right' ? row.record : '', side === 'right' ? row.sheet : '', ''];
  }
}

function* dataRows(report, side) {
  const headers = report.sources[side].headers;
  yield ["Source record", "Source sheet", "Source cells (in column order)", ...headers];
  for (const row of sourceRows(report, side)) yield [row.record, row.sheet, row.cells ? headers.map(header => row.cells[header] || '').join(', ') : '', ...headers.map(header => row.values[header])];
}

/** @returns {Uint8Array} A complete, frozen tabular report; never an executable workbook. */
export function renderXlsx(report) {
  if (!report || report.status !== 'complete') throw new Error("The XLSX report is available after the comparison is complete. Clarify the comparison rules first.");
  if (report.kind === 'text') throw new Error("XLSX reports are only available for table comparisons. Use PDF or HTML for text documents.");
  // Check cardinality before constructing sorted row lists or worksheet objects.
  const categories = ['matched', 'changed', 'only_left', 'only_right'];
  for (const category of categories) if (!Array.isArray(report[category]) || report[category].length > MAX_ROWS) tooLarge();
  for (const side of ['left', 'right']) {
    const n = report.matched.length + report.changed.length + report[`only_${side}`].length;
    if (n > MAX_ROWS || !Array.isArray(report.sources?.[side]?.headers) || report.sources[side].headers.length > 200 || (n + 1) * (report.sources[side].headers.length + 3) > MAX_CELLS) tooLarge();
  }
  const sheets = [
    ["Summary", () => summaryRows(report), [36, 70, 28, 28, 28, 40, 40], false],
    ["Differences", () => differenceRows(report), [28, 25, 24, 24, 40, 40, 14, 24, 14, 14, 24, 14], true],
    ["Data A", () => dataRows(report, 'left'), [18, 24, 40, ...report.sources.left.headers.map(() => 26)], true],
    ["Data B", () => dataRows(report, 'right'), [18, 24, 40, ...report.sources.right.headers.map(() => 26)], true],
  ];
  // First pass validates every string and bounds XML/objects before workbook allocation.
  let cells = 0, rows = 0, estimatedBytes = 32768;
  for (const [name, generate] of sheets) for (const row of generate()) {
    if (++rows > MAX_ROWS || (cells += row.length) > MAX_CELLS) tooLarge();
    estimatedBytes += 64;
    for (const value of row) {
      const s = text(value);
      if (s.length > MAX_CELL_CHARS || cellText(s).length > MAX_CELL_CHARS) throw new RangeError(`XLSX: sheet «${name}» contains a value longer than 32,767 characters. Use HTML/JSON or split the data; values have not been truncated.`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/u.test(s)) throw new Error(`XLSX: sheet «${name}» contains a character that is invalid in XML. Use JSON; the original value has not been changed.`);
      estimatedBytes += 96 + encoder.encode(s).byteLength + (s.match(/[&<>"']/g)?.length || 0) * 5 + (s.match(/_x[0-9a-f]{4}_/gi)?.length || 0) * 7;
      if (estimatedBytes > MAX_REPORT_BYTES) tooLarge();
    }
  }
  const book = utils.book_new();
  book.Props = {Title: "Compare These Texts — comparison results", Subject: "Saved values without formulas", Author: "Compare These Texts"};
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
