/** Rebuild the pinned, offline PDF.js reader. See extension/PDF-READER-SOURCE.md. */
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencies = resolve(process.argv[2] || '/tmp/kristina-pdf-reader');
const require = createRequire(join(dependencies, 'package.json'));
const {build} = require('esbuild');
const packagePath = dirname(require.resolve('pdfjs-dist/package.json'));
const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
if (metadata.version !== '6.3.289') throw new Error('Expected pdfjs-dist 6.3.289');
if (require('esbuild/package.json').version !== '0.25.12') throw new Error('Expected esbuild 0.25.12');
const scratch = await mkdtemp(join(tmpdir(), 'kristina-pdf-vendor-'));
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Patch must match exactly once: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
try {
  let worker = await readFile(join(packagePath, 'build/pdf.worker.mjs'), 'utf8');
  const display = await readFile(join(packagePath, 'build/pdf.mjs'), 'utf8');
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  if (sha256(worker) !== 'f2870db902eaff8397442c912b69459980ac91f6f4b5ed827167b12cf7057930' || sha256(display) !== '495588717f62303a839e91a5343deebf1b41f52e2f9f6361e73dee6ea6a4355e') throw new Error('Upstream PDF.js source checksum mismatch');
  // The application already owns the real Worker and its message listener.
  worker = replaceOnce(worker, 'if (typeof window === "undefined" && !isNodeJS && typeof self !== "undefined" && typeof self.postMessage === "function" && "onmessage" in self) {\n      this.initializeFromPort(self);\n    }', '/* Kristina: explicit in-process handler; preserve the application Worker listener. */');
  // Fail at actual image operators, including Form XObject recursion; never decode images.
  worker = replaceOnce(worker, 'if (type.name !== "Form") {\n                emptyXObjectCache.set', 'if (type.name === "Image") { throw new FormatError("PDF: изображения и сканы пока не поддерживаются; требуется распознавание или текстовая копия без изображений."); }\n              if (type.name !== "Form") {\n                emptyXObjectCache.set');
  worker = replaceOnce(worker, 'switch (fn | 0) {\n          case OPS.setFont:\n            const fontNameArg', 'switch (fn | 0) {\n          case OPS.endInlineImage:\n          case OPS.paintInlineImageXObject:\n            throw new FormatError("PDF: изображения и сканы пока не поддерживаются; требуется распознавание или текстовая копия без изображений.");\n          case OPS.setFont:\n            const fontNameArg');
  // ErrorFont normally returns no glyphs: that would silently discard source text.
  worker = replaceOnce(worker, 'const font = textState.font;\n      const baseCharSpacing', 'const font = textState.font;\n      if (font.error) { throw new FormatError("PDF: не удалось прочитать шрифт и сопоставить символы Unicode."); }\n      if (font.isType3Font) { throw new FormatError("PDF: графические шрифты Type3 не поддерживаются."); }\n      const baseCharSpacing');
  // Never substitute an unmapped PDF character code as a Unicode character.
  worker = replaceOnce(worker, 'let unicode = this.toUnicode.get(charcode) || charcode;', 'let unicode = this.toUnicode.get(charcode);\n    if (typeof unicode !== "string" || !unicode.length) { throw new FormatError("PDF: отсутствует пригодное сопоставление символов Unicode."); }');
  // Bound decompression before allocating expanded streams (fonts or page content).
  worker = replaceOnce(worker, 'ensureBuffer(requested) {\n    const buffer = this.buffer;', 'ensureBuffer(requested) {\n    if (requested > 32 * 1024 * 1024 || this.minBufferLength > 32 * 1024 * 1024) { throw new FormatError("PDF: распакованный поток превышает 32 МиБ. Разделите документ."); }\n    const buffer = this.buffer;');
  worker = replaceOnce(worker, 'const glyphs = font.charsToGlyphs(chars);\n      const scale =', 'if (chars.length > 500000) { throw new FormatError("PDF: текстовый фрагмент превышает 500000 символов. Разделите документ."); }\n      const glyphs = font.charsToGlyphs(chars);\n      const scale =');
  await writeFile(join(scratch, 'worker.mjs'), worker);
  await writeFile(join(scratch, 'display.mjs'), display);
  await writeFile(join(scratch, 'compat.mjs'), `
if (!Promise.try) Object.defineProperty(Promise, 'try', {configurable: true, writable: true, value: function (callback, ...args) { return new this(resolve => resolve(callback(...args))); }});
if (!Promise.withResolvers) Object.defineProperty(Promise, 'withResolvers', {configurable: true, writable: true, value: function () { let resolve, reject; const promise = new this((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; }});
if (!Uint8Array.prototype.toHex) Object.defineProperty(Uint8Array.prototype, 'toHex', {configurable: true, writable: true, value: function () { return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join(''); }});
if (!Map.prototype.getOrInsertComputed) Object.defineProperty(Map.prototype, 'getOrInsertComputed', {configurable: true, writable: true, value: function (key, callback) { if (this.has(key)) return this.get(key); const value = callback(key); this.set(key, value); return value; }});
if (!Map.prototype.getOrInsert) Object.defineProperty(Map.prototype, 'getOrInsert', {configurable: true, writable: true, value: function (key, value) { if (this.has(key)) return this.get(key); this.set(key, value); return value; }});
`);
  await writeFile(join(scratch, 'entry.mjs'), 'import "./compat.mjs";\nimport {getDocument} from "./display.mjs";\nimport {WorkerMessageHandler} from "./worker.mjs";\nglobalThis.pdfjsWorker = {WorkerMessageHandler};\nexport {getDocument};\n');
  await build({entryPoints: [join(scratch, 'entry.mjs')], outfile: join(root, 'extension/pdf-reader-vendor.mjs'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', banner: {js: '/* PDF.js 6.3.289, Apache-2.0. Modified for offline text extraction; see PDF-READER-SOURCE.md and PDF-READER-LICENSE.txt. */'}});
  await writeFile(join(root, 'extension/PDF-READER-LICENSE.txt'), await readFile(join(packagePath, 'LICENSE')));
} finally {
  await rm(scratch, {recursive: true, force: true});
}
