// DOM integration against the real Python service; not a visual browser test.
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {setTimeout: delay} = require('node:timers/promises');

let server, origin;
const root = path.resolve(__dirname, '../..');
async function until(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for UI state');
}

before(async () => {
  const port = await new Promise((resolve) => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.env.PYTHON || 'python3', ['reconciliation_web.py', '--port', String(port)], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  let errors = '';
  server.stderr.on('data', (chunk) => { errors += chunk; });
  server.on('error', (error) => { errors += error.message; });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(errors);
    try { return (await fetch(origin)).ok; } catch { return false; }
  });
});

after(() => { if (server) server.kill(); });

async function page(t) {
  const errors = [], downloads = [], requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = await JSDOM.fromURL(origin, {
    runScripts: 'dangerously', resources: 'usable', virtualConsole,
    beforeParse(window) {
      window.fetch = (url, options = {}) => {
        requests.push({url, payload: options.body ? JSON.parse(options.body) : null});
        return fetch(new URL(url, origin), {...options, headers: {...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin'}});
      };
      window.TextEncoder = TextEncoder;
      window.AbortController = AbortController;
      window.Blob = Blob;
      window.Element.prototype.scrollIntoView = () => {};
      const blobs = new Map();
      window.URL.createObjectURL = (blob) => { const id = `blob:test-${blobs.size}`; blobs.set(id, blob); return id; };
      window.URL.revokeObjectURL = (id) => blobs.delete(id);
      window.HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloads.push({name: this.download, blob: blobs.get(this.href)});
      };
    },
  });
  await until(() => dom.window.document.readyState === 'complete');
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  const document = dom.window.document;
  const $ = (id) => document.getElementById(id);
  function change(id, value) {
    const node = typeof id === 'string' ? $(id) : id;
    if (node.type === 'checkbox') node.checked = value;
    else if (node.tagName === 'SELECT' && ![...node.options].some((o) => o.value === value)) {
      const option = [...node.options].find((o) => o.textContent === value);
      assert.ok(option, `No option ${value}`);
      node.value = option.value;
    } else node.value = value;
    node.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  }
  async function file(side, text, name = `${side}.csv`) {
    const bytes = Buffer.from(text);
    const input = $(side + '-file');
    Object.defineProperty(input, 'files', {configurable: true, value: [{name, size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)}]});
    input.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    await until(() => $(side + '-filename').textContent === name && !$('compare').disabled);
  }
  async function compare() {
    $('compare').click();
    await until(() => !$('results').hidden && !$('compare').disabled);
  }
  return {$, change, file, compare, downloads, requests, window: dom.window};
}

test('demo -> real comparison -> evidence, categories, search and both downloads', async (t) => {
  const p = await page(t), {$} = p;
  $('demo').click();
  await until(() => !$('results').hidden && !$('compare').disabled);
  assert.equal($('settings').open, false, 'demo needs no settings');
  assert.equal($('commercial-summary').hidden, true, 'Legacy Python report has no commercial calculation');
  assert.equal($('office-impact-question').hidden, true);
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map((n) => n.textContent), ['5', '2', '1', '1', '1']);
  assert.match($('result-rows').textContent, /DS-200/);
  assert.match($('result-rows').textContent, /LP-300/);
  assert.equal($('result-rows').querySelector('table'), null);
  assert.match($('result-rows').textContent, /равно как число/);
  const changed = $('result-rows').querySelector('[data-category=changed]');
  assert.deepEqual([...changed.querySelectorAll('mark')].map(n => n.textContent), ['5', '20', '4', '22']);
  $('next-change').click();
  assert.equal(p.window.document.activeElement.dataset.index, changed.dataset.index);
  $('download-json').click();
  $('download-html').click();
  const report = JSON.parse(await p.downloads[0].blob.text());
  assert.equal(report.summary.changed, 2);
  assert.equal(report.sources.left.row_count, 4);
  assert.match(await p.downloads[1].blob.text(), /DS-200/);
  $('totals').querySelector('[data-category="only_left"]').click();
  assert.match($('result-rows').textContent, /OLD-400/);
  $('search').value = 'not-a-key';
  $('search').dispatchEvent(new p.window.Event('input'));
  assert.equal($('record-range').textContent, '0 позиций');
  p.change('strip', true);
  assert.equal($('results').hidden, true, 'editing rules invalidates the previous result');
});

test('uploaded CSVs with different headers, leading zero key, numeric rule and changed input', async (t) => {
  const p = await page(t), {$} = p;
  p.change('delimiter', ';');
  await p.file('left', 'id;qty\r\n001;2\r\n002;3\r\n', 'order.csv');
  await p.file('right', 'sku;amount\n001;2.00\n002;4\n', 'shipment.csv');
  p.change('left-key', 'id'); p.change('right-key', 'sku');
  const row = $('field-mapping').children[0];
  p.change(row.querySelector('.field-target'), 'amount');
  p.change(row.querySelector('.field-mode'), 'number');
  await p.compare();
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map((n) => n.textContent), ['2', '1', '0', '0', '1']);
  $('download-json').click();
  const report = JSON.parse(await p.downloads[0].blob.text());
  assert.equal(report.matched[0].key, '001');
  assert.equal(report.changed[0].changes[0].after, '4');
  await p.file('right', 'sku;amount\n001;2\n002;3\n', 'revised.csv');
  assert.equal($('results').hidden, true, 'old results cannot survive a source replacement');
  assert.equal($('right-key').value, '', 'new sources require confirming the key');
});

test('duplicate keys return clarification without partial result', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'id\nx\nx\n');
  await p.file('right', 'id\nx\n');
  p.change('left-key', 'id'); p.change('right-key', 'id'); p.change('membership', true);
  await p.compare();
  assert.equal($('complete-result').hidden, true);
  assert.equal($('clarification').hidden, false);
  assert.match($('clarification').textContent, /повторяющегося ключа/);
  $('download-json').click();
  const report = JSON.parse(await p.downloads[0].blob.text());
  assert.equal(report.status, 'needs_clarification');
  assert.equal(report.summary, null);
});

test('CSV content is text in the result and cannot create executable DOM nodes', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'id,value\nx,<script>window.injected=true</script>\n');
  await p.file('right', 'id,value\nx,<img src=x onerror=alert(1)>\n');
  p.change('left-key', 'id'); p.change('right-key', 'id');
  await p.compare();
  assert.equal($('result-rows').querySelector('script,img'), null);
  assert.match($('result-rows').textContent, /<script>/);
  assert.equal(p.window.injected, undefined);
});

test('membership results paginate and filtering resets the page', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'id\n' + Array.from({length: 30}, (_, i) => `key-${i}`).join('\n'));
  await p.file('right', 'id\n');
  p.change('left-key', 'id'); p.change('right-key', 'id'); p.change('membership', true);
  await p.compare();
  assert.equal($('result-rows').children.length, 25);
  $('next').click();
  assert.equal($('result-rows').children.length, 5);
  $('search').value = 'key-29';
  $('search').dispatchEvent(new p.window.Event('input'));
  assert.equal($('page-info').textContent, 'Страница 1 из 1');
  assert.match($('result-rows').textContent, /key-29/);
});

test('long column names stay exact in reports without multiplying option text', async (t) => {
  const p = await page(t), {$} = p;
  const longHeader = 'long-' + 'x'.repeat(10000);
  const headers = ['id', longHeader, ...Array.from({length: 19}, (_, i) => `field-${i}`)];
  const source = headers.join(',') + '\n' + ['001', ...Array(20).fill('a')].join(',') + '\n';
  await p.file('left', source);
  await p.file('right', source.replace('001,a', '001,b'));
  const columnOptions = [...$('rules').querySelectorAll('option')];
  assert.ok(Math.max(...columnOptions.map((option) => option.textContent.length)) < 100);
  assert.ok(Math.max(...columnOptions.map((option) => option.value.length)) < 10);
  p.change('left-key', 'id'); p.change('right-key', 'id');
  await p.compare();
  $('download-json').click();
  const report = JSON.parse(await p.downloads[0].blob.text());
  assert.equal(report.changed[0].changes[0].left_column, longHeader);
  assert.equal(report.changed[0].changes[0].after, 'b');
});

test('office files automatically choose article and numeric fields, preserving source order', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'Артикул;Наименование;Количество;Единица;Цена_руб\nOFF-001;Бумага;40;пачка;365.50\nOFF-002;Ручка;10;шт;24.90\n');
  await p.file('right', 'Артикул;Наименование;Количество;Единица;Цена_руб\nOFF-002;Ручка;10.00;шт;24.9\nOFF-001;Бумага;35;пачка;365.50\n');
  assert.equal($('results').hidden, false);
  assert.equal($('settings').open, false);
  assert.equal(p.requests.filter(r => r.url === '/api/prepare').length, 1);
  assert.equal(p.requests.filter(r => r.url === '/api/compare').length, 1);
  const payload = p.requests.find(r => r.url === '/api/compare').payload;
  assert.deepEqual(payload.key, ['Артикул', 'Артикул']);
  assert.deepEqual(payload.fields.filter(f => f[2] === 'number').map(f => f[0]), ['Количество', 'Цена_руб']);
  assert.equal(payload.delimiter, ';');
  assert.match($('result-rows').firstElementChild.textContent, /OFF-001/);
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map(n => n.textContent), ['2', '1', '0', '0', '1']);
  await p.file('right', 'Артикул;Наименование;Количество;Единица;Цена_руб\nOFF-001;Бумага;40;пачка;365.50\nOFF-002;Ручка;10;шт;24.90\n', 'replacement.csv');
  assert.equal($('result-rows').querySelector('mark'), null, 'replacement displays a fresh result');
  assert.match($('document-right-name').textContent, /replacement/);
});

test('ambiguous identifiers ask before comparing; manual no-overlap displays a warning', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'id,sku,qty\n1,A,5\n');
  await p.file('right', 'id,sku,qty\n1,B,4\n');
  assert.equal($('setup-question').hidden, false);
  assert.equal($('results').hidden, true);
  assert.equal(p.requests.filter(r => r.url === '/api/compare').length, 0);
  assert.equal(p.window.document.activeElement.id, 'question-title');
  p.change('left-key', 'sku'); p.change('right-key', 'sku'); $('answer').click();
  await until(() => !$('results').hidden && !$('compare').disabled);
  assert.equal($('no-overlap').hidden, false);
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map(n => n.textContent), ['2', '0', '1', '1', '0']);
});

test('document values preserve whitespace keys, inserted characters and empty cells', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'id,text,empty\n A ,abc,\n');
  await p.file('right', 'id,text,empty\nA,abcd,z\n');
  p.change('left-key', 'id'); p.change('right-key', 'id'); p.change('strip', true); await p.compare();
  const pair = $('result-rows').firstElementChild;
  assert.equal(pair.querySelector('.before .record-title strong').textContent, 'id:  A ');
  assert.deepEqual([...pair.querySelectorAll('.before dd')].map(n => n.textContent), ['abc', '']);
  assert.deepEqual([...pair.querySelectorAll('.after dd')].map(n => n.textContent), ['abcd', 'z']);
  assert.equal(pair.querySelector('.before dd').textContent.includes('∅'), false);
});

test('late file reads cannot overwrite a newer selection or a demo', async (t) => {
  const p = await page(t), {$} = p;
  let finishOld;
  Object.defineProperty($('left-file'), 'files', {configurable: true, value: [{name: 'old.csv', size: 20, arrayBuffer: () => new Promise(resolve => { finishOld = resolve; })}]});
  $('left-file').dispatchEvent(new p.window.Event('change', {bubbles: true}));
  await p.file('left', 'id,qty\nnew,2\n', 'new.csv');
  finishOld(Buffer.from('id,qty\nold,1\n'));
  await delay(20);
  await p.file('right', 'id,qty\nnew,3\n');
  assert.equal($('document-left-name').textContent, 'new.csv');
  assert.match($('result-rows').textContent, /new/);
  assert.doesNotMatch($('result-rows').textContent, /old/);
  let finishAfterDemo;
  Object.defineProperty($('left-file'), 'files', {configurable: true, value: [{name: 'late.csv', size: 20, arrayBuffer: () => new Promise(resolve => { finishAfterDemo = resolve; })}]});
  $('left-file').dispatchEvent(new p.window.Event('change', {bubbles: true}));
  $('demo').click(); await until(() => !$('results').hidden && !$('compare').disabled);
  finishAfterDemo(Buffer.from('id,qty\nold,1\n')); await delay(20);
  assert.equal($('document-left-name').textContent, 'order.csv');
  assert.match($('result-rows').textContent, /CH-100/);
});

test('unmapped source values stay visible and explicitly unverified after manual approval', async (t) => {
  const p = await page(t), {$} = p;
  await p.file('left', 'id,qty,comment\nx,1,private-note\n');
  await p.file('right', 'id,qty\nx,1\n');
  assert.equal($('results').hidden, true);
  assert.equal($('setup-question').hidden, false);
  assert.match($('unmapped-fields').textContent, /comment/);
  await p.compare();
  assert.match($('result-rows').textContent, /private-note/);
  assert.match($('result-rows').textContent, /не проверялось/);
});
