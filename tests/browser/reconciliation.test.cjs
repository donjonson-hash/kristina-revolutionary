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
  const errors = [], downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = await JSDOM.fromURL(origin, {
    runScripts: 'dangerously', resources: 'usable', virtualConsole,
    beforeParse(window) {
      window.fetch = (url, options = {}) => fetch(new URL(url, origin), {...options,
        headers: {...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin'}});
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
  return {$, change, file, compare, downloads, window: dom.window};
}

test('demo -> real comparison -> evidence, categories, search and both downloads', async (t) => {
  const p = await page(t), {$} = p;
  $('demo').click();
  await until(() => !$('rules').hidden && !$('compare').disabled);
  await p.compare();
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map((n) => n.textContent), ['2', '1', '1', '1']);
  assert.match($('result-rows').textContent, /DS-200/);
  assert.match($('result-rows').textContent, /LP-300/);
  const evidence = $('result-rows').querySelector('details');
  evidence.open = true;
  await until(() => evidence.querySelector('pre'));
  assert.match(evidence.textContent, /"quantity": "5"/);
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
  assert.equal($('record-range').textContent, '0 записей');
  p.change('strip', true);
  assert.equal($('results').hidden, true, 'editing rules invalidates the previous result');
});

test('uploaded CSVs with different headers, leading zero key, numeric rule and changed input', async (t) => {
  const p = await page(t), {$} = p;
  p.change('delimiter', ';');
  await p.file('left', 'id;qty\r\n001;2\r\n002;3\r\n', 'order.csv');
  await p.file('right', 'sku;amount\n001;2.00\n002;4\n', 'shipment.csv');
  p.change('left-key', 'id'); p.change('right-key', 'sku');
  const row = $('field-mapping').rows[0];
  p.change(row.querySelector('.field-target'), 'amount');
  p.change(row.querySelector('.field-mode'), 'number');
  await p.compare();
  assert.deepEqual([...$('totals').querySelectorAll('strong')].map((n) => n.textContent), ['1', '0', '0', '1']);
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
