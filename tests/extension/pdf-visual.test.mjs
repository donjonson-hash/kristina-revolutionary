import test from 'node:test';
import assert from 'node:assert/strict';
import {readTextSource} from '../../extension/text-source.mjs';
import {pdfBlockRects, planPdfEdits, openPdfVisual} from '../../extension/pdf-visual.mjs';
import {layoutPdf} from './pdf-layout-fixture.mjs';
import {PDFDocument, fontkit} from '../../extension/pdf-vendor.mjs';
import fontBase64 from '../../extension/pdf-font.mjs';

const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
const font = await pdf.embedFont(Buffer.from(fontBase64, 'base64'), {subset: true});

test('PDF hotspots locate original heading and styled line on the real page, retaining all text runs', async () => {
  const source = await layoutPdf('page.pdf', [[{text: 'ЗАГОЛОВОК', x: 48, y: 790, size: 16}, {text: ['Сто', 'имость: 125 ₽.'], x: 48, y: 750}]]);
  const {blocks} = await readTextSource(source);
  assert.equal(blocks[0].text, 'ЗАГОЛОВОК');
  assert.equal(blocks[1].text, 'Стоимость: 125 ₽.');
  const [heading, line] = blocks.map(block => block.visual);
  assert.equal(heading.width, 595); assert.equal(heading.height, 842); assert.equal(heading.page, 1);
  assert.equal(heading.rects[0].x, 48);
  assert.ok(heading.rects[0].y < 52 && heading.rects[0].y + heading.rects[0].height > 52);
  assert.equal(heading.rects[0].fontSize, 16);
  assert.equal(line.rects.length, 2);
  assert.ok(Math.abs(line.rects[0].x + line.rects[0].width - line.rects[1].x) < 0.1);
  const normalized = pdfBlockRects(blocks[0])[0];
  assert.equal(normalized.x, 48 / 595); assert.equal(normalized.page, 1);
  assert.ok(normalized.y > 0 && normalized.height < .1);
});

test('multi-page reflow hotspots retain original pages and rotated text locations', async () => {
  const {blocks} = await readTextSource(await layoutPdf('pages.pdf', [
    [{text: 'Первый фрагмент', x: 48, y: 770}], [{text: 'Поворот', x: 100, y: 300, angle: 90}]
  ]));
  assert.deepEqual(pdfBlockRects({source_blocks: blocks}).map(rect => rect.page), [1, 2]);
  assert.ok(Math.abs(blocks[1].visual.rects[0].angle + 90) < .01);
  assert.throws(() => planPdfEdits([{block: blocks[1], text: 'Правка'}], 2, font), /повёрнутый/);
});

test('PDF editing accepts a numeric correction and removal but refuses silent overflow and unknown insertion', async () => {
  const {blocks: [block]} = await readTextSource(await layoutPdf('price.pdf', [[{text: 'Стоимость: 125000 рублей.', x: 48, y: 770}]]));
  const correction = planPdfEdits([{block, text: 'Стоимость: 128000 рублей.'}], 1, font);
  assert.equal(correction.length, 1); assert.equal(correction[0].text, 'Стоимость: 128000 рублей.');
  assert.equal(correction[0].x, 48); assert.equal(correction[0].size, 12);
  assert.equal(planPdfEdits([{block, text: ''}], 1, font)[0].text, '');
  assert.deepEqual(planPdfEdits([{block, text: block.text}], 1, font), []);
  assert.deepEqual(planPdfEdits([{block, text: 'Стоимость: 128000 рублей.'}], 2, font), []);
  assert.throws(() => planPdfEdits([{block, text: 'Значительно более длинный текст, который не может поместиться в исходную область.'}], 1, font), /не помещается/);
  assert.throws(() => planPdfEdits([{block, text: 'Первая строка\nВторая строка'}], 1, font), /абзац/);
  assert.throws(() => planPdfEdits([{text: 'Новый фрагмент'}], 1, font), /добавления/);
});

test('viewer opens source bytes offline, exposes page count, and honours a cancelled load', async () => {
  const source = await layoutPdf('viewer.pdf', [[{text: 'Первая страница.', y: 770}], [{text: 'Вторая страница.', y: 770}]]);
  const viewer = await openPdfVisual(source);
  try { assert.equal(viewer.pageCount, 2); } finally { await viewer.dispose(); }
  await assert.rejects(viewer.renderPage(1, {}), /закрыт/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openPdfVisual(source, {signal: controller.signal}), {name: 'AbortError'});
});
