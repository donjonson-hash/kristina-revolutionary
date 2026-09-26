/** Strict, bounded PDF text-layer import. No rendering, OCR or external resources. */
import {getDocument} from './pdf-reader-vendor.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100, MAX_BLOCKS = 2000, MAX_CHARS = 500000, MAX_ITEMS = 100000;
const MAX_MS = 15000;
const fail = message => { throw new Error(`PDF: ${message}`); };
class NoCanvas {
  create() { fail('отрисовка страниц при чтении текста не поддерживается.'); }
  destroy() {}
}
class NoFilter { destroy() {} }
class NoExternalData {
  async fetch() { fail('внешние шрифты и таблицы символов не загружаются. Подготовьте PDF со встроенными шрифтами Unicode.'); }
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
const NOTES = [
  'PDF: сравнивается только извлечённый текстовый слой. Оформление, графика, подписи, метаданные и визуальное совпадение страниц не проверяются.',
  'PDF: порядок выдачи PDF.js сохранён. Раздельные строки и удалённые колонки дополнительно разделяются по координатам; порядок чтения колонок может отличаться от визуального. «Строка» означает фрагмент извлечённого текста на указанной странице.',
  'PDF: регистр и полученные символы сохраняются без дополнительной нормализации. Пробелы восстанавливает PDF.js; границы фрагментов учитывают его переносы и геометрию текста. Точное совпадение исходных пробелов и абзацев не гарантируется.',
  'PDF: изображения не сравнивались. Текст внутри изображений не распознаётся, даже если на той же странице есть текстовый слой.',
  'PDF: любая страница без пригодного текста останавливает всю сверку. Формы, комментарии, вложения, слои и защищённые документы не поддерживаются. Распознавание текста не выполняется.'
];

export async function readPdfBytes(raw) {
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES) fail('ожидается непустой файл размером не более 2 МиБ.');
  if (!new TextDecoder('latin1').decode(raw.subarray(0, 1024)).includes('%PDF-')) fail('не найдена сигнатура документа.');
  const started = Date.now();
  const checkTime = () => { if (Date.now() - started > MAX_MS) fail('чтение заняло слишком много времени. Разделите документ на меньшие части.'); };
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
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF: чтение заняло слишком много времени. Разделите документ на меньшие части.')), MAX_MS); });
    return await Promise.race([(async () => {
      const doc = await loading.promise;
      checkTime();
      if (!Number.isInteger(doc.numPages) || doc.numPages < 1 || doc.numPages > MAX_PAGES) fail('поддерживается от 1 до 100 страниц.');
      const [{info}, permissions, attachments, fields, layers] = await Promise.all([
        doc.getMetadata(), doc.getPermissions(), doc.getAttachments(), doc.getFieldObjects(), doc.getOptionalContentConfig()
      ]);
      if (permissions !== null || info.EncryptFilterName) fail('защищённые и зашифрованные документы не поддерживаются. Сохраните незашифрованную копию.');
      if (info.IsAcroFormPresent || info.IsXFAPresent || fields && Object.keys(fields).length) fail('формы и поля документа не поддерживаются. Подготовьте обычную текстовую копию.');
      if (attachments && Object.keys(attachments).length) fail('вложения документа не поддерживаются. Проверьте их отдельно.');
      if (layers && [...layers].length) fail('слои документа не поддерживаются. Подготовьте обычную текстовую копию.');
      const blocks = [];
      let chars = 0, items = 0;
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        checkTime();
        const page = await doc.getPage(pageNumber);
        if ((await page.getAnnotations({intent: 'any'})).length) fail(`Страница ${pageNumber}: комментарии, ссылки и другие аннотации не поддерживаются. Подготовьте копию без аннотаций.`);
        const reader = page.streamTextContent({disableNormalization: true, includeMarkedContent: false}).getReader();
        let text = '', line = 0, pageHasText = false, streamDone = false, previous;
        const flush = () => {
          previous = undefined;
          if (!text.length) return;
          if (blocks.length >= MAX_BLOCKS) fail('извлечено более 2000 строк. Разделите документ на меньшие части.');
          line++;
          blocks.push({record: blocks.length + 1, text, location: `Страница ${pageNumber} · строка ${line}`, page: pageNumber, line});
          if (text.trim()) pageHasText = true;
          text = '';
        };
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) { streamDone = true; break; }
            checkTime();
            for (const item of value.items) {
              if (++items > MAX_ITEMS) fail('слишком много текстовых фрагментов. Разделите документ.');
              if (typeof item.str !== 'string') fail(`Страница ${pageNumber}: неподдерживаемый текстовый фрагмент.`);
              for (const char of item.str) {
                const cp = char.codePointAt(0);
                if (cp === 0xfffd || cp >= 0xd800 && cp <= 0xdfff || cp >= 0xe000 && cp <= 0xf8ff || cp >= 0xf0000 && cp <= 0xffffd || cp >= 0x100000 && cp <= 0x10fffd || cp < 32 && ![9, 10, 13].includes(cp)) fail(`Страница ${pageNumber}: текст содержит непригодные символы Unicode. Требуется другая текстовая копия или распознавание.`);
                if (++chars > MAX_CHARS) fail('извлечено более 500000 символов. Разделите документ.');
              }
              if (item.str.trim()) {
                const current = geometry(item);
                if (previous !== undefined && separate(previous, current)) flush();
                previous = current;
              }
              text += item.str;
              if (item.hasEOL) flush();
            }
          }
          flush();
        } finally {
          if (!streamDone) await reader.cancel(new Error('PDF: чтение остановлено после ошибки проверки.')).catch(() => {});
          reader.releaseLock();
          page.cleanup();
        }
        if (!pageHasText) fail(`Страница ${pageNumber}: не найден пригодный текстовый слой. Пустые страницы и сканы не поддерживаются; для сканов требуется распознавание.`);
      }
      return {blocks, notes: [...NOTES], page_count: doc.numPages};
    })(), timeout]);
  } catch (error) {
    const message = String(error?.message || '');
    if (message.startsWith('PDF:')) throw new Error(message);
    if (error?.name === 'PasswordException') fail('защищённые паролем документы не поддерживаются. Сохраните незашифрованную копию.');
    fail('не удалось полностью прочитать документ. Файл повреждён или использует неподдерживаемую структуру; подготовьте другую текстовую копию.');
  } finally {
    clearTimeout(timer);
    await loading?.destroy().catch(() => {});
  }
}
