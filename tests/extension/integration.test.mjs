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
        const scripts = [...dom.window.document.scripts].map(s => s.getAttribute('src'));
        assert.deepEqual(new Set(scripts), new Set(['office.js', 'transport.js', 'app.js']));
        assert.ok(scripts.indexOf('office.js') < scripts.indexOf('app.js'));
        assert.ok(scripts.indexOf('transport.js') < scripts.indexOf('app.js'));
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
  const errors = [], network = [], workers = [], requests = [], downloads = [], clipboard = [], navigations = [];
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
      Object.defineProperty(window.navigator, 'clipboard', {value: {
        writeText: async value => { clipboard.push(value); },
      }});
      window.open = url => { navigations.push(String(url)); return null; };
      window.Element.prototype.scrollIntoView = () => {};
      const blobs = new Map();
      window.URL.createObjectURL = blob => { const id = `blob:test-${blobs.size}`; blobs.set(id, blob); return id; };
      window.URL.revokeObjectURL = id => blobs.delete(id);
      window.HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloads.push({name: this.download, blob: blobs.get(this.href)});
        else navigations.push(this.href);
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
    assert.deepEqual(navigations, [], 'The office assistant must not open mail clients or external pages');
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
  return {$, dom, requests, downloads, clipboard, result, file};
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

async function askOffice(p, question) {
  const before = p.$('office-transcript').textContent;
  assert.equal(p.$('office-send').disabled, false, 'A completed report enables questions');
  p.$('office-question').value = question;
  p.$('office-form').dispatchEvent(new p.dom.window.Event('submit', {bubbles: true, cancelable: true}));
  await until(() => p.$('office-transcript').textContent !== before);
  return p.$('office-transcript').textContent.slice(before.length);
}

for (const target of ['firefox', 'chrome']) {
  test(`${target}: office explains actual demo/control results and exports only a requested draft`, async t => {
    const p = await page(t, target), {$} = p;
    $('demo').click();
    await p.result();
    assert.equal($('office-panel').hidden, false);
    assert.ok($('office-summary').textContent.length > 40, 'Completed report has an automatic explanation');
    assert.match($('office-summary').textContent, /2/);
    assert.match($('office-summary').textContent, /1/);
    const equality = await askOffice(p, 'Почему совпали?');
    assert.match(equality, /10\.00/);
    assert.match(equality, /числ|десятич/i);
    assert.match(equality, /непровер|не провер|не оцен/i);

    await p.file('left', order, 'order_office.csv');
    await p.file('right', confirmation, 'supplier_confirmation.csv');
    await p.result();
    const comparisons = p.requests.length;
    const prices = await askOffice(p, 'Что с ценами?');
    for (const value of ['OFF-003', '189.00', '199.00', 'OFF-008', '88.50', '92.00']) assert.ok(prices.includes(value), value);
    assert.doesNotMatch(prices, /OFF-001|OFF-004/);
    const missing = await askOffice(p, 'Что отсутствует?');
    assert.match(missing, /OFF-012/);
    assert.match(missing, /OFF-013/);
    assert.equal(p.requests.length, comparisons, 'Office questions use the existing verified report');
    assert.deepEqual(p.downloads, []);
    assert.deepEqual(p.clipboard, []);
    await askOffice(p, 'Подготовь письмо');
    assert.equal($('office-draft-section').hidden, false);
    const draft = $('office-draft').value;
    for (const value of ['order_office.csv', 'supplier_confirmation.csv', 'OFF-001', 'OFF-003', 'OFF-004', 'OFF-008', 'OFF-012', 'OFF-013']) assert.ok(draft.includes(value), value);
    assert.match(draft, /Здравствуйте/);
    assert.deepEqual(p.downloads, [], 'Preparing a draft does not download or send it');
    assert.deepEqual(p.clipboard, [], 'Preparing a draft does not copy it automatically');
    $('office-copy').click();
    await until(() => p.clipboard.length === 1);
    assert.equal(p.clipboard[0], draft);
    $('office-download').click();
    assert.equal(p.downloads.length, 1);
    assert.match(p.downloads[0].name, /\.txt$/);
    assert.equal(await p.downloads[0].blob.text(), draft);
    assert.equal(p.requests.length, comparisons, 'Draft actions perform no additional comparison or network request');
  });
}

test('office evidence actions clear filters and navigate to a key beyond the first 25 rows', async t => {
  const p = await page(t, 'firefox'), {$} = p;
  const rows = Array.from({length: 31}, (_, i) => [`P-${String(i).padStart(3, '0')}`, '10']);
  await p.file('left', 'sku,price\n' + rows.map(r => r.join(',')).join('\n') + '\n', 'prices-a.csv');
  await p.file('right', 'sku,price\n' + rows.map(([key, value], i) => `${key},${i === 29 ? '12' : value}`).join('\n') + '\n', 'prices-b.csv');
  await p.result();
  assert.equal($('result-rows').children.length, 25);
  $('totals').querySelector('[data-category="matched"]').click();
  $('search').value = 'no-such-key';
  $('search').dispatchEvent(new p.dom.window.Event('input'));
  assert.equal($('record-range').textContent, '0 позиций');
  await askOffice(p, 'Покажи P-029');
  const action = [...$('office-transcript').querySelectorAll('.office-action')].find(b => b.dataset.key === 'P-029');
  assert.ok(action, 'Answer offers an exact evidence action');
  action.click();
  assert.equal($('search').value, '');
  assert.equal($('totals').querySelector('[data-category="all"]').getAttribute('aria-pressed'), 'true');
  assert.equal($('page-info').textContent, 'Страница 2 из 2');
  assert.equal(p.dom.window.document.activeElement.dataset.index, '29');
  assert.match(p.dom.window.document.activeElement.textContent, /P-029/);
  assert.deepEqual([...p.dom.window.document.activeElement.querySelectorAll('mark')].map(n => n.textContent), ['10', '12']);
});

test('office raw exact-key questions preserve significant surrounding whitespace', async t => {
  const p = await page(t, 'firefox'), {$} = p;
  await p.file('left', 'sku,qty\n001,1\n 001 ,9\n', 'keys-a.csv');
  await p.file('right', 'sku,qty\n001,1\n 001 ,8\n', 'keys-b.csv');
  await p.result();
  const comparison = p.requests.filter(request => request.path === '/api/compare').at(-1);
  assert.equal(comparison.payload.strip, false, 'Whitespace is significant under these rules');
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map(n => n.textContent), ['2', '1', '0', '0', '1']);
  const response = await askOffice(p, ' 001 ');
  assert.ok(response.includes('Позиция " 001 "'), 'Answer must describe the raw key, not the trimmed matched key');
  assert.match(response, /Есть изменения/);
  assert.match(response, /"9"/);
  assert.match(response, /"8"/);
  const actions = [...$('office-transcript').querySelectorAll('.office-action')];
  assert.equal(actions.length, 1);
  assert.equal(actions[0].dataset.key, ' 001 ');
  assert.equal(actions[0].dataset.category, 'changed');
  actions[0].click();
  const evidence = p.dom.window.document.activeElement;
  assert.equal(evidence.dataset.index, '1');
  assert.equal(evidence.dataset.category, 'changed');
  assert.equal(evidence.querySelector('.before .record-title strong').textContent, 'sku:  001 ');
  assert.deepEqual([...evidence.querySelectorAll('mark')].map(n => n.textContent), ['9', '8']);
});

test('changing rules or a source invalidates office answers, drafts and retained evidence actions', async t => {
  const p = await page(t, 'firefox'), {$} = p;
  $('demo').click();
  await p.result();
  await askOffice(p, 'Покажи DS-200');
  await askOffice(p, 'Подготовь письмо');
  const staleAction = [...$('office-transcript').querySelectorAll('.office-action')].find(b => b.dataset.key === 'DS-200');
  assert.ok(staleAction);
  $('strip').checked = true;
  $('strip').dispatchEvent(new p.dom.window.Event('change', {bubbles: true}));
  assert.equal($('results').hidden, true);
  assert.equal($('office-draft-section').hidden, true);
  assert.equal($('office-draft').value, '');
  assert.doesNotMatch($('office-transcript').textContent, /DS-200/);
  assert.doesNotMatch($('office-summary').textContent, /DS-200/);
  assert.equal($('office-transcript').querySelector('.office-action'), null);
  $('office-question').value = 'Покажи DS-200';
  $('office-form').dispatchEvent(new p.dom.window.Event('submit', {bubbles: true, cancelable: true}));
  assert.equal($('office-transcript').querySelector('.office-action'), null, 'An invalidated report cannot answer with old evidence');
  staleAction.click();
  $('office-copy').click();
  $('office-download').click();
  assert.equal($('results').hidden, true);
  assert.equal($('result-rows').children.length, 0);
  assert.deepEqual(p.downloads, []);
  assert.deepEqual(p.clipboard, []);

  $('compare').click();
  await p.result();
  $('search').value = 'retain-this-filter';
  $('search').dispatchEvent(new p.dom.window.Event('input'));
  staleAction.click();
  assert.equal($('search').value, 'retain-this-filter', 'Old evidence actions cannot navigate a replacement report');
  await askOffice(p, 'Подготовь письмо');
  assert.notEqual($('office-draft').value, '');
  let finishRead;
  const bytes = Buffer.from('sku,quantity,unit\nCH-100,10,piece\nFRESH-ONLY,2,piece\n');
  Object.defineProperty($('left-file'), 'files', {configurable: true, value: [{
    name: 'fresh.csv', size: bytes.length, arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }),
  }]});
  $('left-file').dispatchEvent(new p.dom.window.Event('change', {bubbles: true}));
  assert.equal($('results').hidden, true, 'Invalidation occurs before the replacement finishes reading');
  assert.equal($('office-draft-section').hidden, true);
  assert.equal($('office-draft').value, '');
  assert.doesNotMatch($('office-transcript').textContent, /DS-200|Здравствуйте/);
  assert.equal($('office-transcript').querySelector('.office-action'), null);
  $('office-copy').click();
  $('office-download').click();
  assert.deepEqual(p.downloads, []);
  assert.deepEqual(p.clipboard, []);
  finishRead(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await p.result();
  assert.match($('document-left-name').textContent, /fresh.csv/);
  assert.equal($('office-draft').value, '', 'Fresh report must not resurrect an earlier draft');
});

test('office user messages, source values and generated drafts remain text', async t => {
  const p = await page(t, 'chrome'), {$} = p;
  const before = '<script>window.officeInjected=true</script>';
  const after = '<img src=x onerror=window.officeInjected=true>';
  await p.file('left', `sku,description\nXSS-001,${before}\n`, 'a.csv');
  await p.file('right', `sku,description\nXSS-001,${after}\n`, 'b.csv');
  await p.result();
  await askOffice(p, 'Покажи XSS-001');
  await askOffice(p, 'Подготовь письмо');
  assert.ok($('office-draft').value.includes(before));
  assert.ok($('office-draft').value.includes(after));
  const userText = '<img src=x onerror=window.officeInjected=true><script>window.officeInjected=true</script>';
  await askOffice(p, userText);
  assert.ok($('office-transcript').textContent.includes(userText));
  assert.equal($('office-panel').querySelector('script,img,iframe'), null);
  assert.equal($('result-rows').querySelector('script,img,iframe'), null);
  assert.equal(p.dom.window.officeInjected, undefined);
});

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
