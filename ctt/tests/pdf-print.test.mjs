import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const code = await readFile(new URL('../src/pdf-print.mjs', import.meta.url), 'utf8');
async function setup(t, {blocked = false, count = 2, renderError = false} = {}) {
  const dom = new JSDOM('<!doctype html><head></head><body></body>', {url:'https://example.test/'}), win = dom.window;
  let printed = 0, disposed = 0, closed = false, received, revoked = 0, renders = 0;
  win.print = () => { printed++; }; win.focus = () => {};
  Object.defineProperty(win, 'closed', {get: () => closed});
  win.close = () => { closed = true; };
  const rules = [], sheet = {cssRules: rules, insertRule(rule) {rules.push(rule);}};
  const originalCreate = win.document.createElement.bind(win.document);
  win.document.createElement = name => {
    const element = originalCreate(name);
    if (name === 'link') {
      Object.defineProperty(element, 'sheet', {value: sheet});
      setTimeout(() => element.dispatchEvent(new win.Event('load')), 0);
    }
    if (name === 'canvas') element.toBlob = callback => callback(new Blob(['PNG']));
    if (name === 'img') Object.defineProperty(element, 'src', {set(value) {
      this.setAttribute('src', value); setTimeout(() => this.dispatchEvent(new win.Event('load')), 0);
    }});
    return element;
  };
  let created = 0; const blobs = new Map(), revokedUrls = [];
  class LocalURL extends URL {static createObjectURL(blob) {const url = `blob:local-page-${++created}`; blobs.set(url, blob); return url;} static revokeObjectURL(url) {revoked++; revokedUrls.push(url);}}
  const context = vm.createContext({window:{open:() => blocked ? null : win}, URL:LocalURL, Blob, Uint8Array, DOMException, AbortController, setTimeout, setInterval, clearInterval});
  const visual = new vm.SyntheticModule(['openPdfVisual'], function() {
    this.setExport('openPdfVisual', async (source, options) => {
      received = {source, options};
      return {pageCount:count, async dispose() {disposed++;}, async renderPage(number, canvas, {scale}) {
        renders++; if (renderError) throw new Error('Broken PDF page');
        const width = number === 1 ? 500 : 700, height = number === 1 ? 700 : 500;
        canvas.width = width * scale; canvas.height = height * scale;
        return {width, height};
      }};
    });
  }, {context});
  await visual.link(() => {}); await visual.evaluate();
  const module = new vm.SourceTextModule(code, {context, initializeImportMeta(meta) {meta.url = 'https://example.test/pdf-print.mjs';}, importModuleDynamically:async () => visual});
  await module.link(() => {}); await module.evaluate();
  t.after(() => dom.window.document.defaultView.close());
  return {prepare:module.namespace.preparePdfPrintWindow, win, rules, blobs, revokedUrls, state:() => ({printed,disposed,closed,received,revoked,renders})};
}
test('print uses final PDF only, preserves mixed page sizes and offers print retry', async t => {
  const env = await setup(t), data = new Uint8Array([1,2,3]), handle = env.prepare();
  await handle.print(data, {title:'Application'});
  const {received,printed,disposed} = env.state();
  assert.equal(received.source.data, data); assert.equal(received.options.generated, true);
  assert.equal(printed,1); assert.equal(disposed,1);
  assert.equal(env.win.document.querySelectorAll('main img').length,2);
  assert.equal(env.win.document.querySelectorAll('main button, main textarea, main canvas').length,0);
  assert.equal(env.win.document.querySelectorAll('style, [style]').length,0);
  assert.equal(env.win.document.querySelector('link').href,'https://example.test/pdf-print.css');
  assert.ok(env.rules.some(rule => /size: 500pt 700pt/.test(rule)));
  assert.ok(env.rules.some(rule => /size: 700pt 500pt/.test(rule)));
  env.win.document.querySelector('button').click(); assert.equal(env.state().printed,2);
  handle.close(); assert.equal(env.state().revoked,3); assert.equal(env.state().closed,true);
});
test('blocked popup and canceled print give explicit failure without printing', async t => {
  const blocked = await setup(t,{blocked:true}); assert.throws(() => blocked.prepare(),/Allow the print window/);
  const env = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(env.prepare().print(new Uint8Array([1]),{signal:controller.signal}),{name:'AbortError'});
  assert.equal(env.state().printed,0); assert.equal(env.state().closed,true);
});
test('render failures and page limits close incomplete windows without printing', async t => {
  for (const options of [{renderError:true},{count:101}]) {
    const env = await setup(t,options);
    await assert.rejects(env.prepare().print(new Uint8Array([1])),/Broken PDF page|100 pages/);
    assert.equal(env.state().printed,0); assert.equal(env.state().closed,true); assert.equal(env.state().disposed,1);
    if (options.count) assert.equal(env.state().renders,0);
  }
});

test('download retains the exact final PDF and a safe filename until the print window closes', async t => {
  const env = await setup(t), data = new Uint8Array([37, 80, 68, 70, 45, 49]), expected = data.slice(), handle = env.prepare();
  const download = env.win.document.querySelector('a');
  assert.equal(download.hidden, true);
  await handle.print(data, {title:'Заявление.pdf'});
  assert.equal(download.hidden, false);
  assert.equal(download.textContent, 'Download PDF');
  assert.equal(download.download, 'Заявление-filled.pdf');
  const pdf = env.blobs.get(download.href);
  assert.equal(pdf.type, 'application/pdf');
  data.fill(0);
  assert.deepEqual(new Uint8Array(await pdf.arrayBuffer()), expected);
  assert.equal(env.state().revoked, 0);
  env.win.dispatchEvent(new env.win.Event('afterprint'));
  assert.equal(env.state().revoked, 0, 'closing the print dialog must not invalidate Download PDF');
  env.win.dispatchEvent(new env.win.Event('unload'));
  assert.equal(env.state().revoked, 3);
  assert.ok(env.revokedUrls.includes(download.href));
  handle.close();
  assert.equal(env.state().revoked, 3, 'cleanup is idempotent');
});
