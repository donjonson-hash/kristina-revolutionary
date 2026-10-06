import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readTextSource} from '../dist/text-source.mjs';
import {compareText} from '../dist/text-engine.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {renderPdfRevision, renderReflowedPdf} from '../dist/pdf-visual.mjs';
import {renderPreservedPdf} from '../dist/pdf-layout.mjs';
import {mountVisualReview} from '../dist/visual-review.mjs';
import editor from '../dist/text-editor.js';
import {PDFDocument, PDFName, fontkit} from '../dist/pdf-vendor.mjs';
import fontBase64 from '../dist/pdf-font.mjs';

// Independent synthetic PDF: no uploaded document or personal data is retained.
function fixture(annotations = [], text = 'Contact support') {
  const content = `BT /F1 14 Tf 50 600 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [${annotations.map((_, i) => `${i + 6} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...annotations,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return {name: 'synthetic-links.pdf', data: Buffer.from(pdf).toString('base64')};
}
const link = (action = '/S /URI /URI (https://example.com/reference)', extra = '') => `<< /Type /Annot /Subtype /Link /Rect [50 595 180 615] /Border [0 0 0] /A << ${action} >> ${extra} >>`;
const fromBytes = bytes => ({name: 'revised.pdf', data: Buffer.from(bytes).toString('base64')});

test('HTTP(S) link PDFs compare visible text only and disclose the omitted destinations', async () => {
  const left = fixture([link()]);
  const right = fixture([link('/S /URI /URI (http://example.org/different)')]);
  const parsed = await readTextSource(left);
  assert.deepEqual(parsed.blocks.map(block => block.text), ['Contact support']);
  assert.equal(parsed.meta.link_count, 1);
  assert.match(parsed.meta.notes.join(' '), /link destinations are not compared or opened/);
  assert.match(parsed.meta.notes.join(' '), /Edited PDF downloads do not retain clickable links/);
  const report = await compareText({left, right});
  assert.equal(report.summary.changed, 0);
  assert.equal(report.summary.matched, 1);
  assert.notEqual(report.sources.left.sha256, report.sources.right.sha256);
  assert.equal((await compareText({left, right: fixture([link()], 'Contact sales')})).summary.changed, 1);
  assert.equal((await readTextSource(fixture())).meta.link_count, undefined);
});

test('email links import as inert text and do not affect comparison', async () => {
  for (const uri of ['mailto:test@example.com', 'MAILTO:test@example.com', 'mailto:test@example.com?subject=Hello%20there']) {
    const source = fixture([link(`/Type /Action /S /URI /URI (${uri})`, '/StructParent 1')]);
    const parsed = await readTextSource(source);
    assert.deepEqual(parsed.blocks.map(block => block.text), ['Contact support']);
    assert.equal(parsed.meta.link_count, 1);
    assert.match(parsed.meta.notes.join(' '), /not compared or opened/);
    assert.equal((await compareText({left: source, right: fixture()})).summary.changed, 0);
  }
});

test('other annotations, unsafe schemes and additional link actions remain unsupported', async () => {
  for (const [name, annotations] of [
    ['comment', ['<< /Type /Annot /Subtype /Text /Rect [50 595 180 615] /Contents (Review) >>']],
    ['mixed link and comment', [link(), '<< /Type /Annot /Subtype /Text /Rect [50 595 180 615] /Contents (Review) >>']],
    ['email chained action', [link('/S /URI /URI (mailto:test@example.com) /Next << /S /JavaScript /JS (noop) >>')]],
    ['email additional action', [link('/S /URI /URI (mailto:test@example.com)', '/AA << /E << /S /JavaScript /JS (noop) >> >>')]],
    ['email control character', [link('/S /URI /URI (mailto:test@example.com\\n)')]],
    ['javascript URI', [link('/S /URI /URI (javascript:alert%281%29)')]],
    ['relative URI', [link('/S /URI /URI (/reference)')]],
    ['file URI', [link('/S /URI /URI (file:///tmp/example)')]],
    ['GoTo', [link('/S /GoTo /D [3 0 R /Fit]')]],
    ['Launch', [link('/S /Launch /F (example.txt)')]],
    ['JavaScript action', [link('/S /JavaScript /JS (app.alert%281%29)')]],
    ['chained action', [link('/S /URI /URI (https://example.com) /Next << /S /JavaScript /JS (noop) >>')]],
    ['additional action', [link(undefined, '/AA << /E << /S /JavaScript /JS (noop) >> >>')]],
    ['alternative destination', [link(undefined, '/Dest [3 0 R /Fit]')]],
  ]) await assert.rejects(readTextSource(fixture(annotations)), /not supported|unsupported/, name);
});

test('PDF editor displays link scope and rebuilt downloads contain no stale link rectangles', async t => {
  const require = createRequire(import.meta.url), {JSDOM} = require('jsdom'), native = require('@napi-rs/canvas');
  const dom = new JSDOM('<main></main>', {pretendToBeVisual: true});
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.DOMMatrix = native.DOMMatrix; globalThis.Path2D = native.Path2D; globalThis.ImageData = native.ImageData;
  globalThis.FontFace = class { constructor(name, bytes) { this.name = name; this.bytes = bytes; } async load() { native.GlobalFonts.register(Buffer.from(this.bytes), this.name); return this; } };
  document.fonts = {add() {}}; window.KristinaTextEditor = editor;
  const canvases = new WeakMap();
  function canvas(el) { let value = canvases.get(el); if (!value || value.width !== el.width || value.height !== el.height) { value = native.createCanvas(el.width, el.height); canvases.set(el, value); } return value; }
  window.HTMLCanvasElement.prototype.getContext = function(type) { const ctx = canvas(this).getContext(type); if (!ctx._wrapped) { const draw = ctx.drawImage.bind(ctx); ctx.drawImage = (image, ...args) => draw(image instanceof window.HTMLCanvasElement ? canvas(image) : image, ...args); ctx._wrapped = true; } return ctx; };
  window.HTMLCanvasElement.prototype.toBlob = function(callback, mime) { canvas(this).toBlob(callback, mime); };
  let view;
  t.after(() => { view?.dispose(); dom.window.close(); for (const key of ['window', 'document', 'DOMMatrix', 'Path2D', 'ImageData', 'FontFace']) delete globalThis[key]; });
  // Embed the same Unicode font used by the renderer so the canvas assertions
  // do not depend on the host's substitute font for unembedded Helvetica.
  const input = await PDFDocument.create(); input.registerFontkit(fontkit);
  const font = await input.embedFont(Buffer.from(fontBase64, 'base64'), {subset: true});
  const page = input.addPage([500, 700]); page.drawText('Contact support', {x: 50, y: 600, size: 14, font});
  input.setTitle('mailto:test@example.com');
  const uri = input.context.lookup(input.context.trailerInfo.Info).get(PDFName.of('Title'));
  page.node.set(PDFName.of('Annots'), input.context.obj([{Type: 'Annot', Subtype: 'Link', Rect: [50, 595, 180, 615], Border: [0, 0, 0], A: {S: 'URI', URI: uri}}]));
  const original = fromBytes(await input.save()), parsed = await readTextSource(original);
  const sources = {left: original, right: original}, report = await compareText(sources);
  for (const single of [false, true]) {
    view = await mountVisualReview(document.querySelector('main'), {report, sources, single});
    const notice = document.querySelector('[data-pdf-link-note="left"]');
    assert.ok(notice && !notice.hidden && !notice.closest('.visual-column').hidden);
    assert.match(notice.textContent, /Link destinations are not compared/);
    assert.match(notice.textContent, /Edited PDF downloads do not retain clickable links/);
    view.dispose(); view = null;
  }
  const blocks = parsed.blocks.map(block => ({...block, key: `section-${block.record}`}));
  const entries = blocks.map(block => ({key: block.key, record: block.record, text: 'Contact sales'}));
  const exports = [
    await renderPdfRevision(original, [{block: blocks[0], text: 'Contact sales'}], {blocks}),
    await renderPreservedPdf(original, entries, {blocks}),
    await renderReflowedPdf(entries),
  ];
  for (const bytes of exports) {
    const loading = getDocument({data: bytes.slice(), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0});
    try { const pdf = await loading.promise; for (let page = 1; page <= pdf.numPages; page++) assert.deepEqual(await (await pdf.getPage(page)).getAnnotations({intent: 'any'}), []); }
    finally { await loading.destroy(); }
    assert.match((await readTextSource(fromBytes(bytes))).blocks.map(block => block.text).join(' '), /Contact sales/);
  }
});
