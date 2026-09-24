import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {renderHtml, renderJson, MAX_REPORT_BYTES} from '../../extension/report.mjs';
const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM} = require('jsdom');

function fixture() {
  const leftHeaders = ['id', 'text', 'quantity', 'note'], rightHeaders = ['code', 'description', 'qty', 'note'];
  const row = (record, values) => ({record, values});
  return {
    schema_version: 1, status: 'complete',
    sources: {
      left: {name: 'order.csv', headers: leftHeaders, row_count: 3, sha256: 'a'.repeat(64)},
      right: {name: 'supplier.csv', headers: rightHeaders, row_count: 3, sha256: 'b'.repeat(64)},
    },
    rules: {key: ['id', 'code'], fields: [['text', 'description', 'text'], ['quantity', 'qty', 'number']], strip: true, delimiter: ','},
    summary: {left_rows: 3, right_rows: 3, matched: 1, changed: 1, only_left: 1, only_right: 1},
    questions: [], issues: [],
    matched: [{key: 'same', left: row(2, {id: 'same', text: 'ok', quantity: '10', note: 'unverified A'}),
      right: row(4, {code: 'same', description: 'ok', qty: '10.00', note: 'unverified B'})}],
    changed: [{key: 'A', left: row(3, {id: ' A ', text: 'Доставка 15 дней🙂', quantity: '2', note: ''}),
      right: row(2, {code: 'A', description: 'Доставка 20 дней🙂', qty: '2.0', note: 'other'}),
      changes: [{left_column: 'text', right_column: 'description', before: 'Доставка 15 дней🙂', after: 'Доставка 20 дней🙂', mode: 'text'}]}],
    only_left: [{key: 'old', row: row(4, {id: 'old', text: 'old item', quantity: '1', note: 'source A'})}],
    only_right: [{key: 'new', row: row(3, {code: 'new', description: 'new item', qty: '1', note: 'source B'})}],
  };
}

function document(report) { return new JSDOM(renderHtml(report)).window.document; }

test('paired source documents preserve all values, source order and unverified fields', () => {
  const report = fixture(), doc = document(report);
  assert.deepEqual([...doc.querySelectorAll('.pair .key')].map(n => n.textContent), ['same', 'A', 'old', 'new']);
  assert.deepEqual([...doc.querySelectorAll('.changed mark')].map(n => n.textContent), ['15', '20']);
  for (const category of ['only_left', 'only_right']) {
    const pair = doc.querySelector('.pair.' + category), present = pair.querySelector('.paper:not(.absent)');
    assert.equal(pair.querySelectorAll('.paper.absent').length, 1);
    assert.deepEqual([...present.querySelectorAll('mark')].map(n => n.textContent), [...present.querySelectorAll('dd')].map(n => n.textContent));
    assert.equal(present.querySelectorAll('mark').length, 4);
  }
  const values = [...doc.querySelectorAll('dd')].map(n => n.textContent);
  assert.equal(values.length, 24);
  assert.ok(values.includes(' A ') && values.includes('A'));
  assert.ok(values.includes('Доставка 15 дней🙂') && values.includes('Доставка 20 дней🙂'));
  assert.ok(values.includes('10') && values.includes('10.00') && values.includes(''));
  assert.ok(doc.body.textContent.includes('Совпадает как число'));
  const unchecked = [...doc.querySelectorAll('.field')].filter(n => n.querySelector('dt').textContent === 'note');
  assert.equal(unchecked.filter(n => n.textContent.includes('Не сравнивалось')).length, 4);
  assert.equal(doc.querySelectorAll('.paper .empty').length, 2);
  assert.equal(doc.querySelectorAll('.paper details[open]').length, 6);
  assert.ok(doc.body.textContent.includes(report.sources.left.sha256));
  assert.match(doc.querySelector('style').textContent, /paper\.absent[^}]+repeating-linear-gradient/);
});

test('text insertions, empty cells and emoji never add or split source characters', () => {
  for (const [left, right] of [['abc', 'abcd'], ['', 'added'], ['a🙂b', 'a🙃b'], ['a\nb<>&', 'a\nc<>&']]) {
    const report = fixture(), item = report.changed[0];
    item.left.values.text = left; item.right.values.description = right;
    item.changes[0].before = left; item.changes[0].after = right;
    const doc = document(report), panels = doc.querySelector('.changed').querySelectorAll('.paper');
    assert.equal(panels[0].querySelectorAll('dd')[1].textContent, left);
    assert.equal(panels[1].querySelectorAll('dd')[1].textContent, right);
    assert.ok(![...doc.querySelectorAll('mark')].some(mark => /[\uD800-\uDFFF]/u.test(mark.textContent)));
  }
  const report = fixture(), item = report.changed[0];
  item.left.values.quantity = '125.00'; item.right.values.qty = '126.00';
  item.changes.push({left_column: 'quantity', right_column: 'qty', before: '125.00', after: '126.00', mode: 'number'});
  const doc = document(report), panels = doc.querySelector('.changed').querySelectorAll('.paper');
  assert.equal(panels[0].querySelectorAll('dd')[2].textContent, '125.00');
  assert.equal(panels[0].querySelectorAll('dd')[2].querySelector('mark').textContent, '125.00');
  assert.equal(panels[1].querySelectorAll('dd')[2].textContent, '126.00');
  assert.equal(panels[1].querySelectorAll('dd')[2].querySelector('mark').textContent, '126.00');
});

test('untrusted headers, names, keys and values cannot become markup or resources', () => {
  const report = fixture(), payload = '<script>alert(1)</script><img src="https://example.org/x" onerror="bad()">';
  report.sources.left.name = payload; report.changed[0].key = payload;
  report.changed[0].left.values.text = payload; report.changed[0].changes[0].before = payload;
  const doc = document(report);
  assert.equal(doc.querySelectorAll('script,img,iframe,link,a,form').length, 0);
  assert.ok([...doc.querySelectorAll('dd')].some(node => node.textContent === payload));
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'none'/); assert.match(csp, /connect-src 'none'/);
  assert.equal(doc.querySelectorAll('[onclick],[onerror],[src]').length, 0);
});

test('original numeric and prototype-like column names remain in source order', () => {
  const report = fixture();
  report.sources.left.headers = ['id', '10', '2', '__proto__', 'constructor'];
  report.changed[0].left.values = Object.fromEntries([['id', 'A'], ['10', 'ten'], ['2', 'two'], ['__proto__', 'original'], ['constructor', 'source']]);
  report.changed[0].changes = [];
  report.matched = []; report.only_left = []; report.only_right = [];
  const doc = document(report), panel = doc.querySelector('.paper.left');
  assert.deepEqual([...panel.querySelectorAll('dt')].map(n => n.textContent), report.sources.left.headers);
  assert.deepEqual([...panel.querySelectorAll('dd')].map(n => n.textContent), ['A', 'ten', 'two', 'original', 'source']);
});

test('clarification has questions and escaped evidence but no partial document pairs', () => {
  const report = fixture();
  report.status = 'needs_clarification'; report.summary = null; report.rules.key = null; report.rules.fields = null;
  report.questions = ['Выберите ключ <id>']; report.issues = [{kind: 'duplicate_key', value: '<script>bad()</script>'}];
  const doc = document(report);
  assert.equal(doc.querySelectorAll('.pair,.totals,script').length, 0);
  assert.ok(doc.body.textContent.includes('Выберите ключ <id>'));
  assert.ok(doc.body.textContent.includes('<script>bad()</script>'));
  assert.ok(doc.body.textContent.includes(report.sources.right.sha256));
});

test('JSON round-trip preserves source evidence and includes final newline', () => {
  const report = fixture(), text = renderJson(report);
  assert.deepEqual(JSON.parse(text), report);
  assert.equal(text, JSON.stringify(report, null, 2) + '\n');
});

test('JSON budget counts UTF-8 bytes, punctuation and the trailing newline', () => {
  const overhead = Buffer.byteLength(renderJson({value: ''})), available = MAX_REPORT_BYTES - overhead;
  const value = '🙂'.repeat(Math.floor(available / 4)) + 'x'.repeat(available % 4);
  assert.equal(Buffer.byteLength(renderJson({value})), MAX_REPORT_BYTES);
  assert.throws(() => renderJson({value: value + 'x'}), {name: 'RangeError', message: /JSON report exceeds 16 MiB/});
});

test('HTML escaping expansion is bounded independently of the JSON report', () => {
  const report = fixture(), value = '&'.repeat(10000);
  report.sources.left.headers = ['id', 'text']; report.sources.right.headers = ['code', 'description'];
  report.rules.fields = [['text', 'description', 'text']];
  report.changed = []; report.only_left = []; report.only_right = [];
  report.matched = Array.from({length: 180}, (_, i) => ({key: String(i),
    left: {record: i + 2, values: {id: String(i), text: value}},
    right: {record: i + 2, values: {code: String(i), description: value}}}));
  assert.ok(Buffer.byteLength(renderJson(report)) < MAX_REPORT_BYTES);
  assert.throws(() => renderHtml(report), {name: 'RangeError', message: /HTML report exceeds 16 MiB/});
});

test('repeated long headers stop JSON output before constructing the entire report', () => {
  const header = 'h'.repeat(100000), report = {rows: Array.from({length: 200}, () => ({[header]: 'x'}))};
  assert.throws(() => renderJson(report), {name: 'RangeError', message: /JSON report exceeds 16 MiB/});
});
