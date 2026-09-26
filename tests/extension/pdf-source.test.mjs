import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readTextSource} from '../../extension/text-source.mjs';
import {compareText, prepareText} from '../../extension/text-engine.mjs';
import {renderTextHtml} from '../../extension/text-report.mjs';
import {PDF_LINES_A, PDF_LINES_B, pdfSource, pdfFixturePair, encryptedPdf} from './pdf-input-fixture.mjs';

const source = (name, raw) => ({name, data: Buffer.from(raw).toString('base64')});
const allPairs = report => ['matched', 'changed', 'only_left', 'only_right']
  .flatMap(category => report[category].map(item => ({...item, category})))
  .sort((a, b) => Number(a.key.slice(5)) - Number(b.key.slice(5)));

test('actual two-page Cyrillic PDF retains every authored line, Unicode, page coordinates and byte hash', async () => {
  const input = await pdfSource('Договор.PDF', PDF_LINES_A);
  const parsed = await readTextSource(input);
  assert.equal(parsed.meta.name, input.name);
  assert.equal(parsed.meta.format, 'pdf');
  assert.equal(parsed.meta.page_count, 2);
  assert.equal(parsed.meta.block_count, 9);
  assert.equal(parsed.meta.sha256, createHash('sha256').update(Buffer.from(input.data, 'base64')).digest('hex'));
  assert.deepEqual(parsed.blocks.map(block => block.text), PDF_LINES_A.flat());
  assert.deepEqual(parsed.blocks.map(block => block.record), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parsed.blocks.map(block => block.page), [1, 1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(parsed.blocks[4].location, 'Страница 1 · строка 5');
  assert.equal(parsed.blocks[5].location, 'Страница 2 · строка 1');
  assert.ok(parsed.meta.notes.length > 0, 'Extraction boundaries are disclosed');
});

test('PDF comparison and HTML retain all input evidence and exact word changes across page boundaries', async () => {
  const input = await pdfFixturePair();
  const prepared = await prepareText(input);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.left.page_count, 2);
  const report = await compareText(input);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.summary, {left_blocks: 9, right_blocks: 9, matched: 5, changed: 3, only_left: 1, only_right: 1});
  const pairs = allPairs(report);
  for (const [side, expected] of [['left', PDF_LINES_A], ['right', PDF_LINES_B]]) {
    const blocks = pairs.map(item => item[side] || (item.category === `only_${side}` ? item.row : null)).filter(Boolean);
    assert.deepEqual(blocks.map(block => block.text), expected.flat());
    for (const item of report.changed) assert.equal(item.segments[side].map(segment => segment.text).join(''), item[side].text);
  }
  assert.deepEqual(report.changed.map(item => item.segments.left.filter(segment => segment.changed).map(segment => segment.text).join('')), ['5', '10', '125000']);
  assert.deepEqual(report.changed.map(item => item.segments.right.filter(segment => segment.changed).map(segment => segment.text).join('')), ['7', '12', '128500']);
  assert.equal(report.only_left[0].row.location, 'Страница 2 · строка 2');
  assert.equal(report.only_right[0].row.location, 'Страница 2 · строка 3');
  const html = renderTextHtml(report);
  for (const expected of ['Страница 1 · строка 3', 'Страница 2 · строка 2', 'Страница 2 · строка 3', '<mark>125000</mark>', '<mark>128500</mark>', 'Ёлка — офис &amp; склад, 125 ₽.', report.sources.left.sha256, report.sources.right.sha256]) assert.ok(html.includes(expected), expected);
});

test('separately positioned font runs on the same baseline remain one complete source line', async () => {
  const input = await pdfSource('runs.pdf', [[['Стоимость: ', '125000', ' рублей.'], ['Ёлка ', '— офис'], 'Конец.']]);
  const parsed = await readTextSource(input);
  assert.deepEqual(parsed.blocks.map(block => block.text), ['Стоимость: 125000 рублей.', 'Ёлка — офис', 'Конец.']);
  assert.deepEqual(parsed.blocks.map(block => block.location), ['Страница 1 · строка 1', 'Страница 1 · строка 2', 'Страница 1 · строка 3']);
});

test('same PDF produces only matches and comparing to independently authored TXT loses no line', async () => {
  const left = await pdfSource('original.pdf', PDF_LINES_A);
  for (const right of [left, source('reference.txt', PDF_LINES_A.flat().join('\n'))]) {
    const report = await compareText({left, right});
    assert.deepEqual(report.summary, {left_blocks: 9, right_blocks: 9, matched: 9, changed: 0, only_left: 0, only_right: 0});
    assert.deepEqual(report.matched.map(item => item.left.text), PDF_LINES_A.flat());
    assert.equal(report.matched[5].left.page, 2);
  }
});

test('malformed and genuinely encrypted PDFs fail explicitly instead of returning empty comparison evidence', async () => {
  await assert.rejects(readTextSource(source('bad.pdf', '%PDF-1.7\nnot a document\n%%EOF')), /PDF/);
  await assert.rejects(readTextSource(encryptedPdf), /парол|зашифров|защищ/i);
});

test('raster-only and mixed text/raster documents never silently report partial extracted text as complete', async () => {
  for (const input of [
    await pdfSource('scan.pdf', [[]], {imagePages: [1]}),
    await pdfSource('mixed.pdf', [['Readable first page'], []], {imagePages: [2]}),
  ]) await assert.rejects(readTextSource(input), /изображени|распознаван/i);
});

test('empty pages and unflattened forms are not silently omitted from an otherwise readable PDF', async () => {
  await assert.rejects(readTextSource(await pdfSource('blank.pdf', [[]])), /Страница 1.*(?:текст|распознаван)/i);
  await assert.rejects(readTextSource(await pdfSource('blank-second.pdf', [['First page text'], []])), /Страница 2.*(?:текст|распознаван)/i);
  await assert.rejects(readTextSource(await pdfSource('form.pdf', [['Main text']], {form: true})), /форм|аннотац/i);
});

test('a genuine document over the page limit is rejected before a partial result is returned', async () => {
  const input = await pdfSource('too-many-pages.pdf', Array.from({length: 101}, (_, i) => [`Page ${i + 1}`]));
  await assert.rejects(readTextSource(input), /100 страниц/);
});

test('ordinary standard-font PDF extracts complete Latin text without requiring an external font', async () => {
  const input = await pdfSource('standard-font.pdf', [['Invoice No. 17', 'Quantity: 10', 'Price: 125000 EUR']], {standardFont: true});
  const parsed = await readTextSource(input);
  assert.deepEqual(parsed.blocks.map(block => block.text), ['Invoice No. 17', 'Quantity: 10', 'Price: 125000 EUR']);
});

test('raster and inline logos preserve all Cyrillic text and page evidence with explicit image scope', async () => {
  for (const options of [{imagePages: [1, 2]}, {inlineImagePages: [1, 2]}]) {
    const parsed = await readTextSource(await pdfSource('logos.pdf', PDF_LINES_A, options));
    assert.deepEqual(parsed.blocks.map(block => block.text), PDF_LINES_A.flat());
    assert.equal(parsed.meta.page_count, 2);
    assert.equal(parsed.blocks[5].location, 'Страница 2 · строка 1');
    assert.equal(parsed.meta.coverage, 'text_layer_only');
    assert.match(parsed.meta.notes.join(' '), /изображения не сравнивались/i);
    assert.match(parsed.meta.notes.join(' '), /Текст внутри изображений не распознаётся/);
  }
});

test('a changed price is detected in PDFs with different image content', async () => {
  const report = await compareText({
    left: await pdfSource('before.pdf', [['Стоимость: 125000 рублей.']], {imagePages: [1]}),
    right: await pdfSource('after.pdf', [['Стоимость: 128500 рублей.']], {inlineImagePages: [1]}),
  });
  assert.equal(report.summary.changed, 1);
  assert.equal(report.changed[0].segments.left.filter(s => s.changed).map(s => s.text).join(''), '125000');
  assert.equal(report.changed[0].segments.right.filter(s => s.changed).map(s => s.text).join(''), '128500');
  assert.match(renderTextHtml(report), /Изображения не сравнивались/);
});

test('identical text with different images is explicitly a text-layer match only', async () => {
  const report = await compareText({
    left: await pdfSource('raster.pdf', [['Цена: 125000']], {imagePages: [1]}),
    right: await pdfSource('inline.pdf', [['Цена: 125000']], {inlineImagePages: [1]}),
  });
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.changed, 0);
  assert.notEqual(report.sources.left.sha256, report.sources.right.sha256);
  for (const side of ['left', 'right']) {
    assert.equal(report.sources[side].coverage, 'text_layer_only');
    assert.match(report.sources[side].notes.join(' '), /изображения не сравнивались/i);
  }
});

test('an inline scan on a later page rejects the entire document with its page number', async () => {
  const input = await pdfSource('inline-scan.pdf', [['Readable text'], []], {inlineImagePages: [2]});
  await assert.rejects(readTextSource(input), /Страница 2.*распознавание/);
});

test('a replacement Unicode character cannot silently become accepted comparison evidence', async () => {
  const input = await pdfSource('invalid-unicode.pdf', [['Цена: 1\ufffd00 рублей.']]);
  await assert.rejects(readTextSource(input), /Unicode|символ|распознаван/i);
});
