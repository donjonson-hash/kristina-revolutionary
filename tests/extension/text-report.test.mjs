import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {renderTextHtml} from '../../extension/text-report.mjs';
const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM} = require('jsdom');
function block(record, text) { return {record, text, location: `Абзац ${record}`}; }
function fixture() {
  return {schema_version: 1, kind: 'text', status: 'complete',
    sources: {left: {name: 'Договор A.docx', sha256: 'a'.repeat(64), format: 'docx', block_count: 3, notes: ['Примечания не извлекались.']},
      right: {name: 'Договор B.txt', sha256: 'b'.repeat(64), format: 'txt', block_count: 3, notes: []}},
    rules: {mode: 'text', normalization: 'line_endings'},
    summary: {left_blocks: 3, right_blocks: 3, matched: 1, changed: 1, only_left: 1, only_right: 1},
    matched: [{key: 'text-1', left: block(1, '  Совпало.\n🙂'), right: block(1, '  Совпало.\n🙂')}],
    changed: [{key: 'text-3', left: block(2, 'Срок 15 дней.'), right: block(3, 'Срок 20 дней.'),
      segments: {left: [{text: 'Срок ', changed: false}, {text: '15', changed: true}, {text: ' дней.', changed: false}],
        right: [{text: 'Срок ', changed: false}, {text: '20', changed: true}, {text: ' дней.', changed: false}]}}],
    only_left: [{key: 'text-4', row: block(3, 'Убрано.')}], only_right: [{key: 'text-2', row: block(2, 'Добавлено.')}],
  };
}

test('text HTML follows aligned keys, preserves block text and highlights exact words', () => {
  const report = fixture(), doc = new JSDOM(renderTextHtml(report)).window.document;
  assert.deepEqual([...doc.querySelectorAll('.pair h3')].map(n => n.textContent.split(' · ')[0]), ['text-1', 'text-2', 'text-3', 'text-4']);
  assert.deepEqual([...doc.querySelectorAll('.changed mark')].map(n => n.textContent), ['15', '20']);
  assert.deepEqual([...doc.querySelectorAll('.text')].map(n => n.textContent), ['  Совпало.\n🙂', '  Совпало.\n🙂', 'Добавлено.', 'Срок 15 дней.', 'Срок 20 дней.', 'Убрано.']);
  assert.equal(doc.querySelectorAll('.absent').length, 2);
  assert.equal(doc.querySelector('.only_right mark').textContent, 'Добавлено.');
  assert.match(doc.querySelector('.changed .right .location').textContent, /Абзац 3/);
  for (const value of [report.sources.left.name, report.sources.right.sha256, report.sources.left.notes[0]]) assert.ok(doc.body.textContent.includes(value));
  assert.match(doc.body.textContent, /не оценка юридического смысла/);
  assert.match(doc.body.textContent, /не исходная вёрстка/);
});

test('source text, metadata, notes and locations are escaped and cannot load resources', () => {
  const report = fixture(), payload = '<img src="https://invalid.test" onerror="bad()"><script>bad()</script>';
  report.sources.left.name = payload; report.sources.left.notes = [payload]; report.changed[0].left.location = payload;
  report.changed[0].left.text = payload;
  report.changed[0].segments.left = [{text: payload, changed: true}];
  const doc = new JSDOM(renderTextHtml(report)).window.document;
  assert.equal(doc.querySelector('.changed .left .text').textContent, payload);
  assert.equal(doc.querySelectorAll('script,img,iframe,link,form,[src],[onerror]').length, 0);
  assert.match(doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /connect-src 'none'/);
});

test('malformed highlighting is refused instead of changing original evidence', () => {
  const report = fixture(); report.changed[0].segments.left[0].text = 'Иной текст ';
  assert.throws(() => renderTextHtml(report), /segments do not preserve/);
  assert.throws(() => renderTextHtml({...report, status: 'needs_clarification'}), /complete text report/);
});

test('HTML amplification stops at the UTF-8 budget', () => {
  const report = fixture(), value = '&'.repeat(1900);
  report.changed = []; report.only_left = []; report.only_right = [];
  report.matched = Array.from({length: 1000}, (_, i) => ({key: `text-${i + 1}`, left: block(i + 1, value), right: block(i + 1, value)}));
  assert.throws(() => renderTextHtml(report), {name: 'RangeError', message: /HTML report exceeds 16 MiB/});
});
