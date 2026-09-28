/** Full, local PDF page rendering and bounded edits of existing text areas. */
import {getDocument} from './pdf-reader-vendor.mjs';
import {PDFDocument, fontkit, rgb} from './pdf-vendor.mjs';
import fontBase64 from './pdf-font.mjs';

const MAX_BYTES = 2 * 1024 * 1024, MAX_PIXELS = 16_000_000;
const fail = message => { throw new Error(`PDF: ${message}`); };
const abort = signal => { if (signal?.aborted) throw new DOMException('Отменено', 'AbortError'); };
class NoExternalData {
  async fetch() { fail('для этой страницы нужны внешние шрифты или данные. Сохраните PDF со встроенными шрифтами.'); }
}
function bytes(source) {
  if (typeof source?.data !== 'string' || source.data.length > Math.ceil(MAX_BYTES / 3) * 4) fail('поддерживается файл до 2 МиБ.');
  let raw;
  try { raw = Uint8Array.from(atob(source.data), value => value.charCodeAt(0)); } catch { fail('не удалось прочитать файл.'); }
  if (!raw.length || raw.length > MAX_BYTES) fail('поддерживается непустой файл до 2 МиБ.');
  return raw;
}
export function pdfBlockRects(block) {
  return (block?.source_blocks || [block]).flatMap(part => {
    const visual = part?.visual;
    if (!visual || !(visual.width > 0) || !(visual.height > 0)) return [];
    return visual.rects.map(rect => ({page: visual.page, x: rect.x / visual.width, y: rect.y / visual.height,
      width: rect.width / visual.width, height: rect.height / visual.height}));
  });
}
/** Validation shared by preview and export; never truncate an overflowing edit. */
export function planPdfEdits(edits, pageNumber, font) {
  const plans = [];
  for (const edit of edits) {
    if (edit.text === edit.block?.text) continue;
    if (typeof edit.text !== 'string' || edit.text.length > 500000) fail('некорректный текст исправления.');
    const visual = edit.block?.visual;
    if (!visual?.rects?.length) fail('для добавления или переноса фрагментов сохраните текстовую редакцию.');
    if (visual.page !== pageNumber) continue;
    if (visual.rects.some(rect => ![rect.x, rect.y, rect.width, rect.height, rect.fontSize, rect.angle].every(Number.isFinite) || rect.width < 0 || rect.height <= 0 || Math.abs(rect.angle) > 1)) fail('повёрнутый текст пока можно сохранить только в текстовой редакции.');
    const x = Math.min(...visual.rects.map(rect => rect.x)), y = Math.min(...visual.rects.map(rect => rect.y));
    const right = Math.max(...visual.rects.map(rect => rect.x + rect.width)), bottom = Math.max(...visual.rects.map(rect => rect.y + rect.height));
    if (x < 0 || y < 0 || right > visual.width || bottom > visual.height) fail('фрагмент выходит за границы страницы.');
    let size = Math.min(...visual.rects.map(rect => rect.fontSize));
    if (/\r|\n/.test(edit.text)) fail('новый абзац не помещается в прежнюю строку. Сохраните текстовую редакцию.');
    const naturalWidth = font.widthOfTextAtSize(edit.text, size);
    if (naturalWidth > right - x) size *= (right - x) / naturalWidth;
    if (size < Math.min(...visual.rects.map(rect => rect.fontSize)) * 0.8) fail('новый текст не помещается. Сократите его или сохраните текстовую редакцию.');
    plans.push({x, y, width: right - x, height: bottom - y, size, text: edit.text, page: pageNumber});
  }
  return plans;
}
let measurePromise, screenFontPromise;
async function measureFont() {
  return measurePromise ||= (async () => {
    const document = await PDFDocument.create();
    document.registerFontkit(fontkit);
    return document.embedFont(Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)), {subset: true, features: {liga: false}});
  })();
}
async function screenFont() {
  if (!screenFontPromise) screenFontPromise = (async () => {
    const face = new FontFace('KristinaPdfRevision', Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)));
    await face.load(); document.fonts.add(face);
  })().catch(error => { screenFontPromise = undefined; throw error; });
  return screenFontPromise;
}
function samplePatch(context, plan, scale, canvas) {
  const x = Math.max(0, Math.floor(plan.x * scale) - 2), y = Math.max(0, Math.floor(plan.y * scale) - 2);
  const width = Math.min(canvas.width - x, Math.ceil(plan.width * scale) + 4);
  const height = Math.min(canvas.height - y, Math.ceil(plan.height * scale) + 4);
  const {data} = context.getImageData(x, y, width, height);
  const colorAt = (cx, cy) => Array.from(data.subarray((cy * width + cx) * 4, (cy * width + cx) * 4 + 3));
  const background = colorAt(0, 0), distance = color => Math.max(...color.map((value, i) => Math.abs(value - background[i])));
  const samples = [];
  for (let index = 0; index < width; index += Math.max(1, Math.floor(width / 24))) samples.push(colorAt(index, 0), colorAt(index, height - 1));
  for (let index = 0; index < height; index += Math.max(1, Math.floor(height / 12))) samples.push(colorAt(0, index), colorAt(width - 1, index));
  if (samples.some(color => distance(color) > 35)) fail('под текстом неоднородный фон. Для этой правки сохраните текстовую редакцию.');
  let foreground = [0, 0, 0], contrast = 0;
  for (let index = 0; index < data.length; index += 4) {
    const color = Array.from(data.subarray(index, index + 3)), delta = distance(color);
    if (delta > contrast) { foreground = color; contrast = delta; }
  }
  return {...plan, patch: {x, y, width, height}, background, foreground};
}
async function paintPlans(canvas, plans, scale, {text = true} = {}) {
  const context = canvas.getContext('2d');
  // Validate every background before touching the canvas.
  const sampled = plans.map(plan => samplePatch(context, plan, scale, canvas));
  if (text && sampled.some(plan => plan.text)) await screenFont();
  for (const plan of sampled) {
    context.fillStyle = `rgb(${plan.background.join(',')})`;
    context.fillRect(plan.patch.x, plan.patch.y, plan.patch.width, plan.patch.height);
    if (text && plan.text) {
      context.fillStyle = `rgb(${plan.foreground.join(',')})`;
      context.font = `${plan.size * scale}px KristinaPdfRevision`;
      context.fontKerning = 'none'; context.textBaseline = 'alphabetic';
      context.fillText(plan.text, plan.x * scale, (plan.y + plan.height * 0.8) * scale);
    }
  }
  return sampled;
}

export async function openPdfVisual(source, {signal} = {}) {
  abort(signal);
  const loading = getDocument({data: bytes(source), stopAtErrors: true, isEvalSupported: false,
    disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useWasm: false, enableXfa: false, disableAutoFetch: true,
    disableStream: true, disableRange: true, verbosity: 0, BinaryDataFactory: NoExternalData});
  let disposed = false;
  const tasks = new Set();
  const dispose = async () => { if (disposed) return; disposed = true; signal?.removeEventListener('abort', cancelled); for (const task of tasks) task.cancel(); await loading.destroy(); };
  const cancelled = () => { void dispose().catch(() => {}); };
  signal?.addEventListener('abort', cancelled, {once: true});
  try {
    const doc = await loading.promise;
    abort(signal);
    if (doc.numPages < 1 || doc.numPages > 100) fail('поддерживается от 1 до 100 страниц.');
    return {pageCount: doc.numPages, rects: pdfBlockRects, dispose,
      async renderPage(pageNumber, canvas, {scale = 1, edits = [], eraseOnly = false} = {}) {
        abort(signal); if (disposed) fail('просмотр уже закрыт.');
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) fail('страница не найдена.');
        if (!Number.isFinite(scale) || scale <= 0 || scale > 4) fail('неподдерживаемый масштаб страницы.');
        const page = await doc.getPage(pageNumber), viewport = page.getViewport({scale});
        if (viewport.width * viewport.height > MAX_PIXELS) fail('страница слишком большая для отображения.');
        const plans = edits.length ? planPdfEdits(edits, pageNumber, await measureFont()) : [];
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const task = page.render({canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)', annotationMode: 0});
        tasks.add(task);
        try { await task.promise; abort(signal); const painted = await paintPlans(canvas, plans, scale, {text: !eraseOnly});
          return {width: viewport.width / scale, height: viewport.height / scale, painted};
        } finally { tasks.delete(task); page.cleanup(); }
      }
    };
  } catch (error) { await dispose().catch(() => {}); throw error; }
}

/** A flattened copy: original pixels plus corrections, never original hidden text. */
export async function renderPdfRevision(source, edits, {signal, blocks} = {}) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 2000) fail('для сохранения нужен полный текст документа. Повторите сравнение.');
  const ordered = blocks.slice().sort((a, b) => a.record - b.record), originals = new Map(ordered.map(block => [block.record, block]));
  if (originals.size !== ordered.length || ordered.some((block, index) => block.record !== index + 1 || typeof block.text !== 'string' || !block.visual?.rects?.length)) fail('для сохранения нужен полный текст документа. Повторите сравнение.');
  const replacements = new Map();
  for (const edit of edits) {
    if (!originals.has(edit.block?.record) || originals.get(edit.block.record).text !== edit.block.text || replacements.has(edit.block.record)) fail('для добавления или переноса фрагментов сохраните текстовую редакцию.');
    replacements.set(edit.block.record, edit.text);
  }
  const viewer = await openPdfVisual(source, {signal});
  try {
    const output = await PDFDocument.create(); output.registerFontkit(fontkit);
    const font = await output.embedFont(Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)), {subset: true, features: {liga: false}});
    let imageBytes = 0;
    // Validate edits with missing coordinates even if the document has no matching page.
    for (const edit of edits) if (edit.text !== edit.block?.text && (!edit.block?.visual || edit.block.visual.page < 1 || edit.block.visual.page > viewer.pageCount)) fail('для добавления фрагментов сохраните текстовую редакцию.');
    for (let pageNumber = 1; pageNumber <= viewer.pageCount; pageNumber++) {
      abort(signal);
      const canvas = document.createElement('canvas');
      try {
        const {width, height} = await viewer.renderPage(pageNumber, canvas, {scale: 2, edits});
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось сохранить страницу.')), 'image/png'));
        imageBytes += blob.size;
        if (imageBytes > 32 * 1024 * 1024) fail('исправленный документ слишком большой. Сохраните текстовую редакцию или разделите документ.');
        const image = await output.embedPng(await blob.arrayBuffer()), page = output.addPage([width, height]);
        page.drawImage(image, {x: 0, y: 0, width, height});
        // Regenerate the complete text layer, including unchanged text. The old
        // source PDF is never embedded, so replaced words cannot survive hidden.
        for (const block of ordered.filter(block => block.visual.page === pageNumber)) {
          const text = replacements.has(block.record) ? replacements.get(block.record) : block.text;
          if (!text) continue;
          const rect = block.visual.rects[0], angle = -rect.angle;
          page.drawText(text, {x: rect.x, y: height - rect.y - rect.height * 0.8,
            size: rect.fontSize, font, color: rgb(0, 0, 0), opacity: 0,
            rotate: {type: 'degrees', angle}});
        }
      } finally { canvas.width = canvas.height = 0; }
    }
    abort(signal); return output.save();
  } finally { await viewer.dispose(); }
}
