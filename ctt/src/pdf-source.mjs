/** Strict, bounded PDF text-layer import. No rendering, OCR or external resources. */
import {getDocument} from './pdf-reader-vendor.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100, MAX_BLOCKS = 2000, MAX_CHARS = 500000, MAX_ITEMS = 100000;
const MAX_MS = 15000;
const fail = message => { throw new Error(`PDF: ${message}`); };
const LINK_NOTE = "PDF: link destinations are not compared or opened. Edited PDF downloads do not retain clickable links; the unchanged original keeps its links.";
// PDF.js normalizes link actions and can omit chained actions from its public
// annotation data. Check the original dictionaries before accepting any link.
async function linkValidator(raw) {
  const {PDFDocument, PDFName} = await import('./pdf-vendor.mjs');
  const source = await PDFDocument.load(raw, {updateMetadata: false, throwOnInvalidObject: true});
  const lookup = (dict, key) => source.context.lookup(dict.get(PDFName.of(key)));
  const has = (dict, key) => dict.has(PDFName.of(key));
  const allowed = new Set(['Type', 'Subtype', 'Rect', 'Border', 'BS', 'C', 'H', 'QuadPoints', 'F', 'P', 'NM', 'M', 'StructParent', 'Contents', 'A']);
  return (pageNumber, expectedCount) => {
    const page = source.getPages()[pageNumber - 1]?.node;
    const annots = page && lookup(page, 'Annots');
    if (!annots || typeof annots.size !== 'function' || annots.size() !== expectedCount || expectedCount > 2000) return false;
    for (let index = 0; index < annots.size(); index++) {
      const annotation = source.context.lookup(annots.get(index));
      if (!annotation || typeof annotation.keys !== 'function' || String(lookup(annotation, 'Subtype')) !== '/Link') return false;
      if (annotation.keys().some(key => !allowed.has(key.decodeText()))) return false;
      const action = lookup(annotation, 'A');
      if (!action || typeof action.keys !== 'function' || String(lookup(action, 'S')) !== '/URI') return false;
      if (action.keys().some(key => !['Type', 'S', 'URI'].includes(key.decodeText()))) return false;
      if (has(action, 'Type') && String(lookup(action, 'Type')) !== '/Action') return false;
      const uri = lookup(action, 'URI');
      if (!uri || typeof uri.decodeText !== 'function' || uri instanceof PDFName) return false;
      const value = uri.decodeText();
      if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/u.test(value)) return false;
      try { if (!['http:', 'https:'].includes(new URL(value).protocol)) return false; } catch { return false; }
    }
    return true;
  };
}
class NoCanvas {
  create() { fail("rendering pages while reading text is not supported."); }
  destroy() {}
}
class NoFilter { destroy() {} }
class NoExternalData {
  async fetch() { fail("external fonts and character maps are not loaded. Prepare a PDF with embedded Unicode fonts."); }
}
// PDF.js can end a Form XObject without hasEOL. Keep source order and exact
// strings, but do not concatenate physically separate lines or distant columns.
// Font changes alone are not boundaries: one word may use several font runs.
function geometry(item) {
  const t = item.transform;
  if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite) || !Number.isFinite(item.width)) return null;
  const advanceScale = Math.hypot(t[0], t[1]), em = Math.hypot(t[2], t[3]);
  if (!advanceScale || !em) return null;
  return {x: t[4], y: t[5], ux: t[0] / advanceScale, uy: t[1] / advanceScale, em, width: Math.abs(item.width), dir: item.dir};
}
function separate(previous, current) {
  if (!previous || !current) return true;
  // Vertical writing has a different advance axis; retain its existing hasEOL
  // boundaries rather than applying horizontal-width assumptions to it.
  if (previous.dir === 'ttb' || current.dir === 'ttb') return previous.dir !== current.dir;
  const alignment = previous.ux * current.ux + previous.uy * current.uy;
  if (alignment < 0.999) return true;
  const dx = current.x - previous.x, dy = current.y - previous.y;
  const em = Math.max(previous.em, current.em);
  if (Math.abs(dx * previous.uy - dy * previous.ux) > Math.max(0.5, em * 0.5)) return true;
  const along = dx * previous.ux + dy * previous.uy;
  // Interval distance works for either RTL or LTR source order. Small overlaps,
  // baseline jitter and nearby styled/superscript runs remain in the same line.
  const gap = Math.max(along - previous.width, -along - current.width);
  return gap > em * 2;
}
// Coordinates use the displayed page (including its crop box and rotation).
// They only locate an existing text run; comparison still uses its exact string.
function visualRect(item, style, viewport) {
  const g = geometry(item);
  if (!g || !item.str.length) return null;
  const t = item.transform, ascent = Number.isFinite(style?.ascent) ? style.ascent : 0.9;
  const descent = Number.isFinite(style?.descent) ? style.descent : -0.2;
  const vx = t[2] / g.em, vy = t[3] / g.em;
  const points = [0, g.width].flatMap(distance => [descent, ascent].map(height => viewport.convertToViewportPoint(
    g.x + g.ux * distance + vx * g.em * height,
    g.y + g.uy * distance + vy * g.em * height
  )));
  const x = Math.min(...points.map(point => point[0])), y = Math.min(...points.map(point => point[1]));
  const end = viewport.convertToViewportPoint(g.x + g.ux, g.y + g.uy), start = viewport.convertToViewportPoint(g.x, g.y);
  const emEnd = viewport.convertToViewportPoint(g.x + t[2], g.y + t[3]);
  return {x, y, width: Math.max(...points.map(point => point[0])) - x, height: Math.max(...points.map(point => point[1])) - y,
    fontSize: Math.hypot(emEnd[0] - start[0], emEnd[1] - start[1]), angle: Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI};
}
const NOTES = [
  "PDF: only the extracted text layer is compared. Formatting, graphics, signatures, metadata, and visual page matches are not checked.",
  "PDF: the PDF.js output order is preserved. Separate lines and widely spaced columns are further separated by their coordinates; column reading order may differ from the visual layout. \"Line\" means a block of extracted text on the specified page.",
  "PDF: case and extracted characters are preserved without additional normalization. PDF.js reconstructs spaces; block boundaries use its line breaks and text geometry. Exact preservation of original spacing and paragraphs is not guaranteed.",
  "PDF: images were not compared. Text inside images is not recognized, even if the same page has a text layer.",
  "PDF: any page without usable text stops the entire comparison. Forms, comments, attachments, layers, and protected documents are not supported. OCR is not performed."
];

export async function readPdfBytes(raw) {
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES) fail("a nonempty file of no more than 2 MiB is required.");
  if (!new TextDecoder('latin1').decode(raw.subarray(0, 1024)).includes('%PDF-')) fail("the document signature was not found.");
  const started = Date.now();
  const checkTime = () => { if (Date.now() - started > MAX_MS) fail("reading took too long. Split the document into smaller files."); };
  let loading, timer;
  try {
    loading = getDocument({
      data: raw.slice(), stopAtErrors: true, isEvalSupported: false,
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      useWasm: false, enableXfa: false, disableAutoFetch: true,
      disableStream: true, disableRange: true, verbosity: 0,
      CanvasFactory: NoCanvas, FilterFactory: NoFilter, BinaryDataFactory: NoExternalData
    });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PDF: reading took too long. Split the document into smaller files.")), MAX_MS); });
    return await Promise.race([(async () => {
      const doc = await loading.promise;
      checkTime();
      if (!Number.isInteger(doc.numPages) || doc.numPages < 1 || doc.numPages > MAX_PAGES) fail("1 to 100 pages are supported.");
      const [{info}, permissions, attachments, fields, layers] = await Promise.all([
        doc.getMetadata(), doc.getPermissions(), doc.getAttachments(), doc.getFieldObjects(), doc.getOptionalContentConfig()
      ]);
      if (permissions !== null || info.EncryptFilterName) fail("protected and encrypted documents are not supported. Save an unencrypted copy.");
      if (info.IsAcroFormPresent || info.IsXFAPresent || fields && Object.keys(fields).length) fail("document forms and fields are not supported. Prepare a plain text copy.");
      if (attachments && Object.keys(attachments).length) fail("document attachments are not supported. Check them separately.");
      if (layers && [...layers].length) fail("document layers are not supported. Prepare a plain text copy.");
      const blocks = [];
      let chars = 0, items = 0, link_count = 0, validateLinks;
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        checkTime();
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({scale: 1});
        const annotations = await page.getAnnotations({intent: 'any'});
        if (annotations.length) {
          const unsupported = () => fail(`Page ${pageNumber}: only ordinary HTTP(S) links are supported. Comments, forms, and other annotations or actions are not supported. Prepare a copy without them.`);
          if (annotations.some(annotation => annotation.annotationType !== 2)) unsupported();
          validateLinks ||= await linkValidator(raw);
          checkTime();
          if (!validateLinks(pageNumber, annotations.length)) unsupported();
          link_count += annotations.length;
        }
        const reader = page.streamTextContent({disableNormalization: true, includeMarkedContent: false}).getReader();
        let text = '', line = 0, pageHasText = false, streamDone = false, previous, rects = [];
        const styles = Object.create(null);
        const flush = () => {
          previous = undefined;
          if (!text.length) return;
          if (blocks.length >= MAX_BLOCKS) fail("more than 2,000 lines were extracted. Split the document into smaller files.");
          line++;
          blocks.push({record: blocks.length + 1, text, location: `Page ${pageNumber} · line ${line}`, page: pageNumber, line,
            visual: {page: pageNumber, width: viewport.width, height: viewport.height, rects}});
          if (text.trim()) pageHasText = true;
          text = '';
          rects = [];
        };
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) { streamDone = true; break; }
            checkTime();
            Object.assign(styles, value.styles);
            for (const item of value.items) {
              if (++items > MAX_ITEMS) fail("too many text blocks. Split the document into smaller files.");
              if (typeof item.str !== 'string') fail(`Page ${pageNumber}: unsupported text block.`);
              for (const char of item.str) {
                const cp = char.codePointAt(0);
                if (cp === 0xfffd || cp >= 0xd800 && cp <= 0xdfff || cp >= 0xe000 && cp <= 0xf8ff || cp >= 0xf0000 && cp <= 0xffffd || cp >= 0x100000 && cp <= 0x10fffd || cp < 32 && ![9, 10, 13].includes(cp)) fail(`Page ${pageNumber}: the text contains unusable Unicode characters. Another text copy or OCR is required.`);
                if (++chars > MAX_CHARS) fail("more than 500,000 characters were extracted. Split the document into smaller files.");
              }
              if (item.str.trim()) {
                const current = geometry(item);
                if (previous !== undefined && separate(previous, current)) flush();
                previous = current;
              }
              text += item.str;
              const rect = visualRect(item, styles[item.fontName], viewport);
              if (rect) rects.push(rect);
              if (item.hasEOL) flush();
            }
          }
          flush();
        } finally {
          if (!streamDone) await reader.cancel(new Error("PDF: reading stopped after a validation error.")).catch(() => {});
          reader.releaseLock();
          page.cleanup();
        }
        if (!pageHasText) fail(`Page ${pageNumber}: no usable text layer was found. Empty pages and scans are not supported; scans require OCR.`);
      }
      return {blocks, notes: [...NOTES, ...(link_count ? [LINK_NOTE] : [])], page_count: doc.numPages, ...(link_count ? {link_count} : {})};
    })(), timeout]);
  } catch (error) {
    const message = String(error?.message || '');
    if (message.startsWith('PDF:')) throw new Error(message);
    if (error?.name === 'PasswordException') fail("password-protected documents are not supported. Save an unencrypted copy.");
    fail("could not read the entire document. The file is damaged or uses an unsupported structure; prepare another text copy.");
  } finally {
    clearTimeout(timer);
    await loading?.destroy().catch(() => {});
  }
}
