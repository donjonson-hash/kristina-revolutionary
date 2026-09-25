import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderPdf, MAX_PDF_CHARACTERS} from '../../extension/pdf-report.mjs';
import {PDFDocument, PDFName, PDFRawStream, decodePDFRawStream} from '../../extension/pdf-vendor.mjs';
import {compare} from '../../extension/engine.mjs';
import {buildCommercialSummary} from '../../extension/commercial-summary.mjs';

async function fixture() {
  const source = (name, rows) => ({name, data: Buffer.from('sku,quantity,unit,price_rub\n' + rows.join('\n')).toString('base64')});
  const report = await compare({
    left: source('Заказ.csv', ['CH-100,10,piece,189', 'DS-200,5,piece,20', 'LP-300,1,piece,100', 'OLD-400,2,piece,20']),
    right: source('Подтверждение.csv', ['CH-100,10,piece,189', 'DS-200,4,piece,22', 'LP-300,1,box,100', 'NEW-500,2,piece,20']),
    key: ['sku', 'sku'], fields: [['quantity', 'quantity', 'number'], ['unit', 'unit', 'text'], ['price_rub', 'price_rub', 'number']],
  });
  report.commercial = buildCommercialSummary(report);
  return report;
}
function textFixture(before = 'Срок 15 дней.', after = 'Срок 20 дней.') {
  const block = (record, text) => ({record, text, location: `Абзац ${record}`});
  return {schema_version: 1, kind: 'text', status: 'complete',
    sources: {left: {name: 'Договор A.docx', sha256: 'a'.repeat(64), format: 'docx', block_count: 2}, right: {name: 'Договор B.txt', sha256: 'b'.repeat(64), format: 'txt', block_count: 2}},
    rules: {mode: 'text', normalization: 'line_endings'}, summary: {matched: 1, changed: 1, only_left: 0, only_right: 0},
    matched: [{key: 'text-1', left: block(1, 'UNCHANGED-BLOCK'), right: block(1, 'UNCHANGED-BLOCK')}],
    changed: [{key: 'text-2', left: block(2, before), right: block(2, after), segments: {left: [{text: before, changed: true}], right: [{text: after, changed: true}]}}],
    only_left: [], only_right: [],
  };
}
// Decode the PDF's actual ToUnicode map and page text operators; no renderer dependency in CI.
async function inspect(bytes) {
  const pdf = await PDFDocument.load(bytes), streams = [], mapping = new Map();
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const stream = new TextDecoder().decode(decodePDFRawStream(object).decode());
    streams.push(stream);
    if (stream.includes('beginbfchar')) for (const entry of stream.matchAll(/<([0-9a-f]{4})>\s+<([0-9a-f]+)>/gi)) {
      const chars = entry[2].match(/.{4}/g).map(code => String.fromCharCode(parseInt(code, 16))).join('');
      mapping.set(entry[1].toUpperCase(), chars);
    }
  }
  const text = streams.filter(stream => stream.includes('BT\n')).flatMap(stream => [...stream.matchAll(/<([0-9a-f]+)> Tj/gi)].map(match => match[1].match(/.{4}/g).map(code => mapping.get(code.toUpperCase()) ?? '�').join(''))).join('\n');
  return {pdf, text, streams};
}

test('native PDF embeds Cyrillic and preserves partial money, evidence, and all difference categories', async () => {
  const report = await fixture(), bytes = await renderPdf(report), {pdf, text, streams} = await inspect(bytes);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.ok(pdf.getPageCount() > 1);
  for (const page of pdf.getPages()) { assert.equal(page.getWidth(), 595.28); assert.equal(page.getHeight(), 841.89); }
  for (const expected of ['Кристина', 'Частичный расчёт: 4 из 5', 'RUB: A 2030 → B 2018; B − A: -12', 'LP-300 — исключено:', 'Единицы A и B различаются', 'OLD-400', 'NEW-500', report.sources.left.sha256, report.sources.right.sha256, 'Совпавшие пары опущены']) assert.ok(text.includes(expected), expected);
  assert.ok(streams.some(stream => stream.includes('beginbfchar')));
  assert.ok([...pdf.context.enumerateIndirectObjects()].some(([, object]) => object.toString().includes('/FontFile2')));
  assert.equal(text.includes('�'), false);
});

test('untrusted input stays literal and never produces actions, annotations, JavaScript, or network access', async () => {
  const report = await fixture(), payload = '<script>alert(1)</script> https://example.org /JavaScript /Launch';
  report.sources.left.name = payload;
  report.only_left[0].row.values.sku = '=HYPERLINK("https://evil.test","open")';
  report.only_left[0].row.sheet = 'Лист 1'; report.only_left[0].row.cells = {sku: 'A5'};
  const {pdf, text} = await inspect(await renderPdf(report));
  assert.ok(text.includes(payload));
  assert.ok(text.includes('=HYPERLINK("https://evil.test","open")'));
  assert.ok(text.includes('лист «Лист 1», строка 5, ячейки A5'));
  for (const key of ['OpenAction', 'AA', 'Names']) assert.equal(pdf.catalog.has(PDFName.of(key)), false);
  for (const page of pdf.getPages()) assert.equal(page.node.Annots()?.size() ?? 0, 0);
});

test('text word segments retain source characters and highlights; invalid segments fail explicitly', async () => {
  const report = textFixture();
  report.sources.left.notes = ['Общее примечание.', 'Только источник A.'];
  report.sources.right.notes = ['Общее примечание.', 'Только источник B.'];
  report.only_left = [{key: 'text-3', row: {record: 3, text: 'Удалённый абзац.', location: 'Абзац 3'}}];
  report.only_right = [{key: 'text-4', row: {record: 3, text: 'Добавленный абзац.', location: 'Абзац 3'}}];
  report.summary.only_left = 1; report.summary.only_right = 1;
  report.changed[0].segments = {left: [{text: 'Срок ', changed: false}, {text: '15', changed: true}, {text: ' дней.', changed: false}], right: [{text: 'Срок ', changed: false}, {text: '20', changed: true}, {text: ' дней.', changed: false}]};
  const {text, streams} = await inspect(await renderPdf(report));
  assert.ok(text.includes('Срок \n15\n дней.')); assert.ok(text.includes('Срок \n20\n дней.'));
  assert.equal(text.includes('UNCHANGED-BLOCK'), false);
  assert.ok(text.includes('Удалённый абзац.')); assert.ok(text.includes('Добавленный абзац.'));
  assert.ok(text.includes('A: сопоставленного блока нет.')); assert.ok(text.includes('B: сопоставленного блока нет.'));
  assert.equal(text.split('Общее примечание.').length - 1, 1);
  assert.ok(text.includes('Пояснения для обоих файлов\nОбщее примечание.'));
  assert.ok(text.includes('Особенности файла A\nТолько источник A.'));
  assert.ok(text.includes('Особенности файла B\nТолько источник B.'));
  assert.ok(streams.some(stream => stream.includes('1 0.9 0.86 rg')));
  assert.ok(streams.some(stream => stream.includes('0.87 0.95 0.89 rg')));
  report.changed[0].segments.left[1].text = '16';
  await assert.rejects(renderPdf(report), /подсветка не соответствует/);
});

test('unsupported glyphs and controls are visibly escaped rather than replaced with empty boxes', async () => {
  const report = textFixture('Табуляция\tНуль\0Новый\r🫨', 'Текст');
  const {text} = await inspect(await renderPdf(report));
  assert.ok(text.includes('Табуляция\\tНуль[U+0000]Новый\\r[U+1FAE8]'));
  assert.equal(text.includes('�'), false);
});

test('long single blocks and unbroken tokens paginate without dropping text', async () => {
  const marker = 'SOURCE-END-0123456789';
  const report = textFixture('Абзац\n'.repeat(100) + 'X'.repeat(4000) + marker, 'Новое');
  const {pdf, text} = await inspect(await renderPdf(report));
  assert.ok(pdf.getPageCount() >= 4);
  assert.ok(text.includes('Продолжение: text-2'));
  assert.ok(text.replaceAll('\n', '').includes(marker));
  assert.equal((text.match(/X/g) || []).length, 4004); // Four X characters in [U+XXXX] explanation.
});

test('incomplete, oversized serialized evidence, rendered text, and page count fail without partial output', async () => {
  await assert.rejects(renderPdf({status: 'needs_clarification'}), /после завершённой сверки/);
  const oversized = textFixture(); oversized.extra = 'я'.repeat(9 * 1024 * 1024);
  await assert.rejects(renderPdf(oversized), /PDF слишком большой/);
  await assert.rejects(renderPdf(textFixture('x'.repeat(MAX_PDF_CHARACTERS), 'x')), /PDF слишком большой/);
  await assert.rejects(renderPdf(textFixture('\n'.repeat(12000), 'x')), /PDF слишком большой/);
});

test('vendored code uses local static imports and contains no dynamic code constructor', async () => {
  const vendor = await readFile(new URL('../../extension/pdf-vendor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(vendor, /\b(?:eval|Function)\s*\(/);
  assert.doesNotMatch(vendor, /\bimport\s*\(/);
});
