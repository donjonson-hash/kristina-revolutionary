/** Add user text above unchanged PDF artwork. Coordinates use PDF.js scale-1 viewports. */
import {PDFDocument, PDFName, fontkit, rgb} from './pdf-vendor.mjs';
import {getDocument} from './pdf-reader-vendor.mjs';
import fontBase64 from './pdf-font.mjs';
import {readPdfBytes} from './pdf-source.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const fail = message => { throw new Error(`PDF: ${message}`); };
const abort = signal => { if (signal?.aborted) throw new DOMException('Canceled', 'AbortError'); };
class NoExternalData { async fetch() { fail('external resources are not supported.'); } }

/** Validate and wrap a field before any output drawing. No silent text truncation. */
export function planPdfFillField(field, viewport, font) {
  if (!field || !['x', 'y', 'width', 'height', 'fontSize'].every(key => Number.isFinite(field[key]))) fail('Choose a valid text area and size.');
  const {x, y, width, height, fontSize} = field;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > viewport.width + .001 || y + height > viewport.height + .001) fail('The text area must stay inside the page.');
  if (fontSize < 6 || fontSize > 72) fail('Choose a text size between 6 and 72.');
  if (typeof field.text !== 'string' || field.text.length > 4000) fail('Use up to 4000 characters in each text area.');
  const text = field.text.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u.test(text)) fail('The text contains unsupported control characters.');
  const supported = new Set(font.getCharacterSet());
  if ([...text].some(char => !/\s/u.test(char) && !supported.has(char.codePointAt(0)))) fail('The chosen font cannot display one of these characters.');
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      if (font.widthOfTextAtSize(word, fontSize) > width + .001) fail('A word does not fit. Widen the text area, reduce the size, or shorten the text.');
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, fontSize) > width + .001) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  const ascent = font.heightAtSize(fontSize, {descender: false});
  const fullHeight = font.heightAtSize(fontSize);
  const lineHeight = Math.max(fontSize * 1.2, fullHeight);
  if (text.trim() && fullHeight + (lines.length - 1) * lineHeight > height + .001) fail('The text does not fit vertically. Enlarge the area, reduce the size, or shorten the text.');
  const [a, b, c, d] = viewport.transform, det = a * d - b * c;
  if (![a, b, c, d, det].every(Number.isFinite) || Math.abs(det) < 1e-8) fail('This page coordinate system is not supported.');
  const unitScale = Math.hypot(a, b);
  return {lines, x, y, ascent, lineHeight, size: fontSize / unitScale,
    rotation: Math.atan2(-b / det, d / det) * 180 / Math.PI};
}

export async function renderFilledPdf(source, fields, {signal, generated = false} = {}) {
  abort(signal);
  let raw;
  if (generated) {
    if (!(source?.data instanceof Uint8Array) || !source.data.length || source.data.length > 64 * 1024 * 1024) fail('The generated PDF is too large.');
    raw = source.data;
  } else {
    if (typeof source?.data !== 'string' || source.data.length > Math.ceil(MAX_BYTES / 3) * 4) fail('A PDF up to 2 MiB is required.');
    try { raw = Uint8Array.from(atob(source.data), char => char.charCodeAt(0)); } catch { fail('Could not read the source PDF.'); }
    if (!raw.length || raw.length > MAX_BYTES) fail('A nonempty PDF up to 2 MiB is required.');
  }
  if (!Array.isArray(fields) || fields.length > 100) fail('Use up to 100 text areas.');
  // Original uploads follow the editor importer. Generated input is only for
  // a previously validated document already rendered by our local PDF editor.
  if (!generated) await readPdfBytes(raw);
  abort(signal);
  const original = await PDFDocument.load(raw, {updateMetadata: false, throwOnInvalidObject: true});
  if (original.getPageCount() < 1 || original.getPageCount() > 100) fail('Use a PDF with 1 to 100 pages.');
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)), {subset: true, features: {liga: false}});
  const pages = await output.copyPages(original, original.getPageIndices());
  for (const page of pages) {
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
    output.addPage(page);
  }
  const loading = getDocument({data: raw.slice(), stopAtErrors: true, isEvalSupported: false,
    disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useWasm: false, enableXfa: false, disableAutoFetch: true, disableStream: true,
    disableRange: true, verbosity: 0, BinaryDataFactory: NoExternalData});
  const cancelled = () => { void loading.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancelled, {once: true});
  try {
    const reader = await loading.promise, plans = [], viewports = new Map();
    for (const field of fields) {
      abort(signal);
      if (!Number.isInteger(field?.page) || field.page < 1 || field.page > pages.length) fail('Choose an existing page for each text area.');
      if (!viewports.has(field.page)) viewports.set(field.page, (await reader.getPage(field.page)).getViewport({scale: 1}));
      const viewport = viewports.get(field.page);
      plans.push({page: pages[field.page - 1], viewport, plan: planPdfFillField(field, viewport, font)});
    }
    for (const {page, viewport, plan} of plans) {
      abort(signal);
      for (const [index, text] of plan.lines.entries()) {
        if (!text) continue;
        const [x, y] = viewport.convertToPdfPoint(plan.x, plan.y + plan.ascent + index * plan.lineHeight);
        page.drawText(text, {x, y, size: plan.size, font, color: rgb(0, 0, 0), rotate: {type: 'degrees', angle: plan.rotation}});
      }
    }
    abort(signal);
    for (const page of pages) page.node.delete(PDFName.of('Annots'));
    const result = await output.save();
    abort(signal);
    return result;
  } finally {
    signal?.removeEventListener('abort', cancelled);
    await loading.destroy();
  }
}
