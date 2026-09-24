// DOM integration of the packaged UI, transport and real worker algorithm.
// worker_threads adapts WebWorker events; this is not a visual/browser-engine test.
// Run: node --test tests/extension/integration.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker as NodeWorker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM, requestInterceptor, VirtualConsole} = require('jsdom');
const output = mkdtempSync(path.join(tmpdir(), 'kristina-extension-test-'));
before(() => execFileSync(process.env.PYTHON || 'python3', [
  'scripts/build_reconciliation_extension.py', '--output', output,
], {cwd: root, encoding: 'utf8'}));
after(() => rmSync(output, {recursive: true, force: true}));

// The independently checked 12-row control pair; quoted commas and Cyrillic
// intentionally exercise CSV parsing and UTF-8 rather than a mocked report.
const order = `Артикул,Наименование,Количество,Единица,Цена_руб
OFF-001,"Бумага А4 80 г/м², 500 листов",40,пачка,365.50
OFF-002,Ручка шариковая синяя,100,шт,24.90
OFF-003,Папка-регистратор А4 75 мм,20,шт,189.00
OFF-004,"Скрепки 28 мм, 100 штук",30,упаковка,48.50
OFF-005,Блокнот А5 80 листов,25,шт,112.00
OFF-006,Маркер для доски чёрный,12,шт,79.90
OFF-007,Клей-карандаш 21 г,15,шт,65.00
OFF-008,Скотч прозрачный 48 мм × 66 м,24,рулон,88.50
OFF-009,Конверт С4 белый,50,шт,12.80
OFF-010,Ножницы офисные 21 см,6,шт,245.00
OFF-011,Степлер № 24/6,8,шт,320.00
OFF-012,"Файлы-вкладыши А4, 100 штук",10,упаковка,215.00
`.replaceAll('\n', '\r\n');
const confirmation = `Артикул,Наименование,Количество,Единица,Цена_руб
OFF-011,Степлер № 24/6,8,шт,320.00
OFF-003,Папка-регистратор А4 75 мм,20,шт,199.00
OFF-001,"Бумага А4 80 г/м², 500 листов",35,пачка,365.50
OFF-009,Конверт С4 белый,50,шт,12.80
OFF-005,Блокнот А5 80 листов,25,шт,112.00
OFF-013,"Салфетки для монитора, 100 штук",3,упаковка,290.00
OFF-002,Ручка шариковая синяя,100,шт,24.90
OFF-008,Скотч прозрачный 48 мм × 66 м,20,рулон,92.00
OFF-007,Клей-карандаш 21 г,15,шт,65.00
OFF-004,"Скрепки 28 мм, 100 штук",30,коробка,48.50
OFF-010,Ножницы офисные 21 см,6,шт,245.00
OFF-006,Маркер для доски чёрный,12,шт,79.90
`.replaceAll('\n', '\r\n');

async function until(condition, details = () => '') {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return;
    await delay(25);
  }
  assert.fail('Timed out waiting for UI state: ' + details());
}

function localAsset(directory, value) {
  assert.ok(value && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value), `Non-relative asset: ${value}`);
  const filename = path.resolve(directory, value);
  assert.ok(filename.startsWith(directory + path.sep), `Asset escapes package: ${value}`);
  return filename;
}

for (const target of ['firefox', 'chrome']) {
  test(`${target}: manifest, CSP, archive and packaged relative assets`, () => {
    const directory = path.join(output, target);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
      assert.equal((manifest[key] || []).length, 0, `${key} must be empty`);
    }
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
    const csp = manifest.content_security_policy.extension_pages;
    for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'none'", "worker-src 'self'", "object-src 'none'"]) {
      assert.ok(csp.split(';').map(s => s.trim()).includes(directive), directive);
    }
    assert.doesNotMatch(csp, /https?:|unsafe-inline|unsafe-eval|\*/);
    assert.equal(manifest.action.default_popup, 'launcher.html');
    if (target === 'firefox') assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
    for (const name of ['index.html', 'launcher.html']) {
      const dom = new JSDOM(readFileSync(path.join(directory, name), 'utf8'));
      for (const node of dom.window.document.querySelectorAll('[src],link[href]')) {
        readFileSync(localAsset(directory, node.getAttribute('src') || node.getAttribute('href')));
      }
      assert.equal(dom.window.document.querySelector('script:not([src])'), null, 'No inline executable scripts');
      if (name === 'index.html') {
        assert.deepEqual([...dom.window.document.scripts].map(s => s.getAttribute('src')), ['transport.js', 'app.js']);
      }
      dom.window.close();
    }
    for (const name of readdirSync(directory).filter(n => /\.(?:m?js|css)$/.test(n))) {
      const source = readFileSync(path.join(directory, name), 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        readFileSync(localAsset(directory, match[1]));
      }
      for (const match of source.matchAll(/url\(\s*['"]?([^)'"\s]+)/g)) {
        readFileSync(localAsset(directory, match[1]));
      }
    }
    // Check delivered ZIP contents, not only the unpacked build directory.
    execFileSync(process.env.PYTHON || 'python3', ['-c',
      'import pathlib,sys,zipfile; d=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2]); assert set(z.namelist())=={p.name for p in d.iterdir()}; assert all(z.read(p.name)==p.read_bytes() for p in d.iterdir())',
      directory, path.join(output, `kristina-${target}-${manifest.version}.zip`),
    ]);
  });
}

async function page(t, target) {
  const directory = path.join(output, target);
  const errors = [], network = [], workers = [], requests = [], downloads = [];
  const localResources = {interceptors: [requestInterceptor(request => {
      const parsed = new URL(request.url);
      if (parsed.protocol !== 'file:' || !fileURLToPath(parsed).startsWith(directory + path.sep)) {
        network.push(request.url);
        return new Response('', {status: 403});
      }
      return undefined;
  })]};
  class WebWorker {
    constructor(url, options) {
      assert.equal(options.type, 'module');
      assert.equal(fileURLToPath(url), path.join(directory, 'worker.mjs'));
      this.terminated = false;
      // Use the packaged worker's actual message handler. Only the browser
      // platform event bridge is adapted; no algorithm or API is substituted.
      this.worker = new NodeWorker(`
        const {parentPort, workerData} = require('node:worker_threads');
        globalThis.fetch = (...args) => { parentPort.postMessage({networkAttempt: String(args[0])}); throw Error('Network forbidden'); };
        globalThis.WebSocket = class { constructor(url) { parentPort.postMessage({networkAttempt: String(url)}); throw Error('Network forbidden'); } };
        globalThis.self = {postMessage: data => parentPort.postMessage(data)};
        import(workerData).then(() => {
          if (typeof self.onmessage !== 'function') throw Error('Worker message handler missing');
          parentPort.on('message', data => self.onmessage({data}));
        }).catch(error => { throw error; });
      `, {eval: true, workerData: String(url)});
      workers.push(this);
      this.worker.on('message', data => {
        if (data.networkAttempt) network.push(data.networkAttempt);
        else this.onmessage?.({data});
      });
      this.worker.on('error', error => {
        errors.push(error.message);
        this.onerror?.({preventDefault() {}});
      });
    }
    postMessage(message) { requests.push(message); this.worker.postMessage(message); }
    terminate() { this.terminated = true; return this.worker.terminate(); }
  }
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = await JSDOM.fromFile(path.join(directory, 'index.html'), {
    resources: localResources, runScripts: 'dangerously', virtualConsole,
    beforeParse(window) {
      window.Worker = WebWorker;
      window.TextEncoder = TextEncoder;
      window.AbortController = AbortController;
      window.Blob = Blob;
      window.fetch = (...args) => { network.push(String(args[0])); throw Error('Network forbidden'); };
      window.XMLHttpRequest = class { constructor() { network.push('XMLHttpRequest'); throw Error('Network forbidden'); } };
      window.WebSocket = class { constructor(url) { network.push(String(url)); throw Error('Network forbidden'); } };
      window.navigator.sendBeacon = url => { network.push(String(url)); return false; };
      window.Element.prototype.scrollIntoView = () => {};
      const blobs = new Map();
      window.URL.createObjectURL = blob => { const id = `blob:test-${blobs.size}`; blobs.set(id, blob); return id; };
      window.URL.revokeObjectURL = id => blobs.delete(id);
      window.HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloads.push({name: this.download, blob: blobs.get(this.href)});
      };
    },
  });
  t.after(async () => {
    dom.window.close();
    const allTerminated = workers.every(worker => worker.terminated);
    await Promise.all(workers.map(worker => worker.terminate()));
    assert.ok(allTerminated, 'Transport must terminate completed workers');
    assert.deepEqual(errors, []);
    assert.deepEqual(network, [], 'UI and worker must make no network calls');
  });
  await until(() => dom.window.document.readyState === 'complete');
  const $ = id => dom.window.document.getElementById(id);
  const idle = () => until(() => !$('compare').disabled, () => $('notice').textContent);
  const result = () => until(() => !$('results').hidden && !$('compare').disabled, () => $('notice').textContent);
  async function file(side, text, name) {
    const bytes = Buffer.from(text, 'utf8');
    Object.defineProperty($(side + '-file'), 'files', {configurable: true, value: [{
      name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }]});
    $(side + '-file').dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    await until(() => $(side + '-filename').textContent === name);
    await idle();
  }
  return {$, dom, requests, downloads, result, file};
}

for (const target of ['firefox', 'chrome']) {
  test(`${target}: real worker demo, control CSV uploads, evidence and offline downloads`, async t => {
    const p = await page(t, target), {$} = p;
    $('demo').click();
    await p.result();
    assert.deepEqual([...$('totals').querySelectorAll('strong')].map(n => n.textContent), ['5', '2', '1', '1', '1']);
    assert.match($('result-rows').textContent, /DS-200/);
    assert.match($('result-rows').textContent, /равно как число/);
    assert.equal($('settings').open, false);
    assert.deepEqual(p.requests.map(r => r.path), ['/api/prepare', '/api/compare']);

    await p.file('left', order, 'order_office.csv');
    await p.file('right', confirmation, 'supplier_confirmation.csv');
    await p.result();
    assert.deepEqual([...$('totals').querySelectorAll('strong')].map(n => n.textContent), ['13', '4', '1', '1', '7']);
    assert.match($('result-rows').firstElementChild.textContent, /OFF-001/);
    assert.equal($('result-rows').children.length, 13);
    assert.equal($('setup-question').hidden, true);
    const payload = p.requests.filter(r => r.path === '/api/compare').at(-1).payload;
    assert.deepEqual(Array.from(payload.key), ['Артикул', 'Артикул']);
    assert.deepEqual(Array.from(payload.fields, f => Array.from(f)), [
      ['Наименование', 'Наименование', 'text'], ['Количество', 'Количество', 'number'],
      ['Единица', 'Единица', 'text'], ['Цена_руб', 'Цена_руб', 'number'],
    ]);
    $('download-json').click();
    $('download-html').click();
    assert.deepEqual(p.downloads.map(d => d.name), ['kristina-reconciliation.json', 'kristina-reconciliation.html']);
    const report = JSON.parse(await p.downloads[0].blob.text());
    assert.equal(report.status, 'complete');
    for (const [key, value] of Object.entries({matched: 7, changed: 4, only_left: 1, only_right: 1, left_rows: 12, right_rows: 12})) {
      assert.equal(report.summary[key], value, key);
    }
    assert.equal(report.sources.left.name, 'order_office.csv');
    assert.equal(report.sources.right.name, 'supplier_confirmation.csv');
    assert.deepEqual(report.only_left.map(r => r.key), ['OFF-012']);
    assert.deepEqual(report.only_right.map(r => r.key), ['OFF-013']);
    assert.deepEqual(Object.fromEntries(report.changed.map(row => [row.key, row.changes.map(c => [c.left_column, c.before, c.after])])), {
      'OFF-001': [['Количество', '40', '35']],
      'OFF-003': [['Цена_руб', '189.00', '199.00']],
      'OFF-004': [['Единица', 'упаковка', 'коробка']],
      'OFF-008': [['Количество', '24', '20'], ['Цена_руб', '88.50', '92.00']],
    });
    const html = await p.downloads[1].blob.text();
    const saved = new JSDOM(html);
    assert.match(saved.window.document.body.textContent, /OFF-008/);
    assert.match(saved.window.document.body.textContent, /OFF-012/);
    assert.match(saved.window.document.body.textContent, /OFF-013/);
    assert.equal(saved.window.document.querySelector('script,iframe,link[href],img[src]'), null, 'Saved report is standalone and passive');
    assert.ok(saved.window.document.querySelectorAll('mark').length >= 10, 'Saved report contains highlighted evidence');
    saved.window.close();
    $('totals').querySelector('[data-category="changed"]').click();
    assert.equal($('result-rows').children.length, 4);
    $('search').value = 'OFF-008';
    $('search').dispatchEvent(new p.dom.window.Event('input'));
    assert.equal($('result-rows').children.length, 1);
    assert.deepEqual([...$('result-rows').querySelectorAll('mark')].map(n => n.textContent), ['24', '88.50', '20', '92.00']);
  });
}

test('transport cancellation terminates work and rejects before/after worker creation', async t => {
  const workers = [];
  class ControlledWorker {
    constructor() { this.terminated = 0; workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated++; }
  }
  const filename = path.join(output, 'chrome', 'transport.js');
  const dom = new JSDOM('<!doctype html><script src="transport.js"></script>', {
    url: pathToFileURL(path.join(output, 'chrome', 'index.html')).href,
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  dom.window.Worker = ControlledWorker;
  Object.defineProperty(dom.window.document, 'currentScript', {value: dom.window.document.querySelector('script')});
  dom.window.eval(readFileSync(filename, 'utf8'));
  const transport = dom.window.KristinaTransport;
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(transport.request('/api/compare', {}, {signal: preAborted.signal}), {name: 'AbortError'});
  assert.equal(workers.length, 0);
  const controller = new AbortController();
  const pending = transport.request('/api/compare', {marker: 'cancel'}, {signal: controller.signal});
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  assert.equal(workers.length, 1);
  controller.abort();
  await rejected;
  assert.equal(workers[0].terminated, 1);
  workers[0].onmessage({data: {ok: true, result: 'late response'}});
  assert.equal(workers[0].terminated, 1, 'Late response cannot settle an aborted request again');
});
