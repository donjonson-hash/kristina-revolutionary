import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {prepare, compare, inspect} from '../../extension/engine.mjs';
import {renderHtml} from '../../extension/report.mjs';
import office from '../../static/reconciliation/office.js';
import {xlsx, worksheet, source} from './xlsx-fixture.mjs';
const csv = (text, name = 'b.csv') => source(text, name);
const headers = ['Артикул', 'Количество', 'Цена_руб', 'Наименование'];
const a = [headers, ['00123', 10, 10.25, 'Бумага'], ['00124', 3, 20, 'Ручка'], ['00125', 1, 50, 'Папка']];
const b = [headers, ['00124', 3, 20, 'Ручка'], ['00123', 8, 10.25, 'Бумага'], ['00126', 2, 80, 'Книга']];
async function reconcile(left, right) {
  const setup = await prepare({left, right});
  assert.equal(setup.ready, true, setup.question);
  return compare({left, right, delimiter: setup.delimiter, ...setup.rules});
}
test('vendor is exactly the pinned official SheetJS 0.20.3 ESM release', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../../extension/xlsx-vendor.mjs', import.meta.url))).digest('hex'), '1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db');
});
test('XLSX ↔ XLSX: exact values, reordered keys, workbook hash, cell evidence and draft', async () => {
  const raw = xlsx([{name: 'Заказ', rows: a}]);
  const report = await reconcile(source(raw, 'a.xlsx'), source(xlsx([{name: 'Ответ', rows: b}])));
  assert.deepEqual(report.summary, {left_rows: 3, right_rows: 3, matched: 1, changed: 1, only_left: 1, only_right: 1});
  assert.equal(report.sources.left.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(report.changed[0].key, '00123');
  assert.equal(report.changed[0].left.cells['Количество'], 'B2');
  assert.equal(report.changed[0].right.cells['Количество'], 'B3');
  assert.match(renderHtml(report), /Количество · B2/);
  assert.match(office.draftLetter(report).draft, /Заказ.*!B2/);
  assert.match(office.draftLetter(report).draft, /проверен только лист/);
});
for (const delimiter of [',', ';', '\t']) test(`XLSX ↔ CSV auto delimiter ${JSON.stringify(delimiter)} in either order`, async () => {
  const excel = source(xlsx([{name: 'Товары', rows: a}]));
  const text = csv(b.map(row => row.join(delimiter)).join('\n'));
  for (const [left, right] of [[excel, text], [text, excel]]) {
    const report = await reconcile(left, right);
    assert.equal(report.summary.changed, 1); assert.equal(report.summary.matched, 1);
    assert.equal(report.rules.delimiter, delimiter);
  }
});
test('single populated sheet skips empty tabs; multiple tabs including hidden ones require explicit choice', async () => {
  const raw = xlsx([{name: 'Пустой', rows: []}, {name: 'Данные', rows: a}, {name: 'Архив', rows: b, hidden: true}]);
  const right = csv(a.map(row => row.join(',')).join('\n'));
  const setup = await prepare({left: source(raw), right});
  assert.equal(setup.needs_sheet, true);
  assert.deepEqual(setup.sheets.left, [{name: 'Данные', hidden: false}, {name: 'Архив', hidden: true}]);
  await assert.rejects(compare({left: source(raw), right}), /выберите лист/);
  await assert.rejects(prepare({left: source(raw, 'a.xlsx', 'Пустой'), right}), /не найден или пуст/);
  assert.equal((await reconcile(source(raw, 'a.xlsx', 'Данные'), right)).summary.matched, 3);
  assert.equal((await reconcile(source(raw, 'a.xlsx', 'Архив'), right)).summary.changed, 1);
  const single = source(xlsx([{name: 'Пустой', rows: []}, {name: 'Данные', rows: a}]));
  assert.equal((await prepare({left: single, right})).left.sheet, 'Данные');
});
test('text identifiers and simple zero-padded numeric identifiers keep all leading zeros', async () => {
  const left = source(xlsx([{name: 'SKU', rows: [['Артикул', 'Количество'], [{v: 123, style: 1}, 1], ['000000000000000000001', 2]]}]));
  const right = csv('Артикул,Количество\n00123,1\n000000000000000000001,2');
  assert.equal((await reconcile(left, right)).summary.matched, 2);
});
test('sparse rows and offset columns retain actual worksheet addresses and blank cells', async () => {
  // Explicit fixture avoids depending on physical row ordering or !ref dimensions.
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="5"><c r="C5" t="inlineStr"><is><t>Артикул</t></is></c><c r="D5" t="inlineStr"><is><t>Количество</t></is></c><c r="E5" t="inlineStr"><is><t>Описание</t></is></c></row><row r="9" hidden="1"><c r="C9" t="inlineStr"><is><t>00123</t></is></c><c r="D9"><v>1</v></c></row></sheetData></worksheet>`;
  const left = source(xlsx([{name: 'Лист', xml: sheet}]));
  const report = await reconcile(left, csv('Артикул,Количество,Описание\n00123,1,'));
  assert.equal(report.matched[0].left.record, 9);
  assert.equal(report.matched[0].left.cells['Описание'], 'E9');
  assert.equal(report.sources.left.header_cells['Артикул'], 'C5');
});
test('dates use explicit ISO values; boolean and exponent numbers are deterministic', async () => {
  const left = source(xlsx([{name: 'Лист', rows: [['Артикул', 'Дата', 'Флаг', 'Количество'], ['001', {v: 1, style: 2}, true, 1e-7]]}]));
  const report = await reconcile(left, csv('Артикул,Дата,Флаг,Количество\n001,1900-01-01,TRUE,0.0000001'));
  assert.equal(report.summary.matched, 1);
  const shifted = source(xlsx([{name: 'Лист', rows: [['Артикул', 'Дата'], ['001', {v: 0, style: 2}]]}], {date1904: true}));
  assert.equal((await reconcile(shifted, csv('Артикул,Дата\n001,1904-01-01'))).summary.matched, 1);
});
for (const [label, rows, pattern] of [
  ['cached formula', [['Артикул', 'Количество'], ['001', {v: 2, f: '1+1'}]], /формул/],
  ['uncached formula', [['Артикул', 'Количество'], ['001', {f: '1+1', t: 'n'}]], /формул/],
  ['error', [['Артикул', 'Количество'], ['001', {v: '#DIV/0!', t: 'e'}]], /ошибка Excel/],
  ['duplicate headers', [['Артикул', 'Артикул'], ['001', 'x']], /заголовки/],
  ['blank headers', [['Артикул', ''], ['001', 'x']], /заголовки/],
  ['unsafe identifier', [['Артикул', 'Количество'], [1234567890123456, 1]], /идентификатор/],
  ['complex formatted identifier', [['Артикул', 'Количество'], [{v: 123, style: 3}, 1]], /формат/],
  ['Excel fictitious date', [['Артикул', 'Дата'], ['001', {v: 60, style: 2}]], /дата/],
  ['zero date', [['Артикул', 'Дата'], ['001', {v: 0, style: 2}]], /дата/],
]) test(`reject ${label} with actionable explanation`, async () => {
  await assert.rejects(prepare({left: source(xlsx([{name: 'Лист', rows}])), right: csv('Артикул,Количество\n001,1')}), pattern);
});
test('merged cells and macros are rejected', async () => {
  const xml = worksheet(a).replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>');
  await assert.rejects(prepare({left: source(xlsx([{name: 'Лист', xml}])), right: csv('sku,qty\na,1')}), /объединённые/);
  await assert.rejects(prepare({left: source(xlsx(undefined, {entries: {'xl/vbaProject.bin': 'fake'}})), right: csv('sku,qty\na,1')}), /макрос/);
});
test('ZIP rejects truncation, corruption, incorrect sizes and expansion bombs', async () => {
  const raw = xlsx(undefined, {compressed: false});
  const corrupt = Buffer.from(raw); corrupt[80] ^= 1;
  const forged = Buffer.from(raw); const central = forged.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); forged.writeUInt32LE(1, central + 24);
  const bomb = xlsx(undefined, {entries: {'huge.xml': 'x'.repeat(17 * 1024 * 1024)}});
  for (const bytes of [raw.subarray(0, raw.length - 10), corrupt, forged, bomb, Buffer.from('not a zip')]) {
    await assert.rejects(prepare({left: source(bytes), right: csv('sku,qty\na,1')}));
  }
});
test('unsupported extensions, empty books and invalid sheet selections never compare', async () => {
  for (const ext of ['xls', 'xlsb', 'xlsm', 'ods']) await assert.rejects(prepare({left: source(xlsx(), 'a.' + ext), right: csv('sku,qty\na,1')}), /XLSX/);
  await assert.rejects(prepare({left: source(xlsx([{name: 'Empty', rows: []}])), right: csv('sku,qty\na,1')}), /нет заполненных/);
  await assert.rejects(inspect({left: source(xlsx(), 'a.xlsx', 'missing'), right: csv('sku,qty\na,1')}), /лист не найден/);
});
test('malicious sheet names and values remain escaped evidence', async () => {
  const left = source(xlsx([{name: '<img onerror=x>', rows: [['Артикул', 'Описание'], ['001', '<script>alert(1)</script>']]}]));
  const report = await reconcile(left, csv('Артикул,Описание\n001,safe'));
  const html = renderHtml(report);
  assert.ok(html.includes('&lt;img onerror=x&gt;'));
  assert.ok(!html.includes('<script>'));
});
test('row and column limits reject complete worksheets without truncating', async () => {
  const tooManyRows = [['Артикул', 'Количество'], ...Array.from({length: 5001}, (_, i) => [String(i), 1])];
  const tooManyColumns = [Array.from({length: 201}, (_, i) => 'c' + i), Array(201).fill('x')];
  for (const [rows, pattern] of [[tooManyRows, /5000/], [tooManyColumns, /200/]]) await assert.rejects(prepare({left: source(xlsx([{name: 'Лист', rows}])), right: csv('sku,qty\na,1')}), pattern);
});
