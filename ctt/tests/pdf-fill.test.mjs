import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName, rgb} from '../dist/pdf-vendor.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {renderFilledPdf} from '../dist/pdf-fill.mjs';

const asSource = bytes => ({name: 'synthetic-form.pdf', data: Buffer.from(bytes).toString('base64')});
const field = (extra = {}) => ({id: 'name', page: 1, x: 40, y: 80, width: 240, height: 32, text: 'Иван Петров', fontSize: 12, ...extra});
async function fixture(rotations = [0, 90, 180, 270]) {
  const doc = await PDFDocument.create();
  for (const rotation of rotations) {
    const page = doc.addPage([400, 600]);
    page.setCropBox(10, 20, 370, 550);
    page.setRotation({type: 'degrees', angle: rotation});
    page.drawRectangle({x: 30, y: 30, width: 100, height: 30, color: rgb(.2, .4, .6)});
    page.drawText('Original form label', {x: 50, y: 400, size: 12});

  }
  return asSource(await doc.save());
}

test('filled PDFs keep original artwork and place searchable Cyrillic on rotated cropped pages', async () => {
  const source = await fixture([0, 90, 180, 270]);
  const fields = [0, 1, 2, 3].map(i => field({id: `name-${i}`, page: i + 1}));
  const bytes = await renderFilledPdf(source, fields);
  const loading = getDocument({data: bytes.slice(), isEvalSupported: false, verbosity: 0}), reader = await loading.promise;
  const original = await PDFDocument.load(Buffer.from(source.data, 'base64'));
  const output = await PDFDocument.load(bytes);
  try {
    assert.equal(reader.numPages, 4);
    for (let i = 0; i < 4; i++) {
      const page = await reader.getPage(i + 1), viewport = page.getViewport({scale: 1});
      const content = await page.getTextContent(), text = content.items.find(item => item.str === 'Иван Петров');
      assert.ok(content.items.some(item => item.str === 'Original form label'));
      assert.ok(text, 'Cyrillic remains searchable');
      const [x, y] = viewport.convertToViewportPoint(text.transform[4], text.transform[5]);
      assert.ok(Math.abs(x - 40) < .01);
      assert.ok(y > 80 && y < 96);
      // The baseline remains horizontal in displayed page coordinates.
      const end = viewport.convertToViewportPoint(text.transform[4] + text.transform[0], text.transform[5] + text.transform[1]);
      assert.ok(end[0] > x);
      assert.ok(Math.abs(end[1] - y) < .01);
      const before = original.getPages()[i], after = output.getPages()[i];
      assert.deepEqual(after.getCropBox(), before.getCropBox());
      assert.deepEqual(after.getRotation(), before.getRotation());
      const originalStreams = before.node.Contents().asArray().map(ref => Buffer.from(original.context.lookup(ref).contents));
      const outputStreams = after.node.Contents().asArray().map(ref => Buffer.from(output.context.lookup(ref).contents));
      assert.ok(originalStreams.every(stream => outputStreams.some(candidate => candidate.equals(stream))), 'original artwork streams retained byte for byte');
      assert.equal(after.node.has(PDFName.of('Annots')), false);
    }
  } finally { await loading.destroy(); }
});

test('filling validates page bounds, text fit, unsupported glyphs and cancellation', async () => {
  const source = await fixture([0]);
  for (const [entry, message] of [
    [field({x: -1}), /inside the page/],
    [field({x: 360}), /inside the page/],
    [field({y: 540}), /inside the page/],
    [field({page: 2}), /existing page/],
    [field({width: 5}), /word does not fit/],
    [field({text: 'First line\nSecond line', height: 15}), /vertically/],
    [field({text: '\u{10ffff}'}), /cannot display/],
    [field({text: 'hidden\0text'}), /control characters/],
    [field({fontSize: 1}), /between 6 and 72/],
  ]) await assert.rejects(renderFilledPdf(source, [entry]), message);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(renderFilledPdf(source, [field()], {signal: controller.signal}), {name: 'AbortError'});
});

test('long text wraps into the requested area without erasing preprinted content', async () => {
  const source = await fixture([0]);
  const bytes = await renderFilledPdf(source, [field({width: 120, height: 80, text: 'Иван Петров город Москва улица Лесная'})]);
  const loading = getDocument({data: bytes, verbosity: 0}), reader = await loading.promise;
  try {
    const page = await reader.getPage(1), viewport = page.getViewport({scale: 1});
    const {items} = await page.getTextContent();
    const added = items.filter(item => item.str && item.str !== 'Original form label');
    assert.ok(added.length >= 2);
    assert.equal(added.map(item => item.str).join(' '), 'Иван Петров город Москва улица Лесная');
    for (const item of added) {
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      assert.ok(x >= 40 && x + item.width <= 160.01);
      assert.ok(y >= 80 && y <= 160);
    }
  } finally { await loading.destroy(); }
});

test('generated PDF input supports UserUnit scaling without mutating its bytes', async () => {
  const original = await fixture([90, 0]);
  const doc = await PDFDocument.load(Buffer.from(original.data, 'base64'));
  for (const page of doc.getPages()) page.node.set(PDFName.of('UserUnit'), doc.context.obj(2));
  const data = await doc.save(), before = data.slice();
  const filled = await renderFilledPdf({data}, [field(), field({page: 2})], {generated: true});
  assert.deepEqual(data, before);
  const loading = getDocument({data: filled, verbosity: 0}), reader = await loading.promise;
  try {
    for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
      const page = await reader.getPage(pageNumber), viewport = page.getViewport({scale: 1});
      const {items} = await page.getTextContent(), text = items.find(item => item.str === 'Иван Петров');
      assert.ok(text);
      const [x, y] = viewport.convertToViewportPoint(text.transform[4], text.transform[5]);
      assert.ok(Math.abs(x - 40) < .01);
      assert.ok(y > 80 && y < 96);
    }
  } finally { await loading.destroy(); }
});

test('export omits original clickable links and catalog actions', async () => {
  const content = 'BT /F1 14 Tf 50 600 Td (Form label) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Annot /Subtype /Link /Rect [50 595 180 615] /A << /S /URI /URI (mailto:synthetic@example.com) >> >>',
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = await renderFilledPdf(asSource(Buffer.from(pdf)), [field()]);
  const result = await PDFDocument.load(bytes);
  assert.equal(result.getPages()[0].node.has(PDFName.of('Annots')), false);
  assert.equal(result.catalog.has(PDFName.of('OpenAction')), false);
  assert.equal(result.catalog.has(PDFName.of('AA')), false);
});
