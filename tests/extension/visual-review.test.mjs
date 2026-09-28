import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {compareText} from '../../extension/text-engine.mjs';
import editor from '../../static/reconciliation/text-editor.js';
import {mountVisualReview} from '../../extension/visual-review.mjs';
const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM} = require('jsdom');
const source = text => ({name: 'document.txt', data: Buffer.from(text).toString('base64')});
async function setup(t, a, b) {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main');
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  window.KristinaTextEditor = editor; window.Element.prototype.scrollIntoView = () => {};
  const sources = {left: source(a), right: source(b)}, report = await compareText(sources), before = JSON.stringify(report);
  const abort = new AbortController(), revisions = [];
  const review = await mountVisualReview(root, {report, sources, signal: abort.signal, onRevision: value => revisions.push(value)});
  t.after(() => { abort.abort(); review.dispose(); dom.window.close(); delete globalThis.document; delete globalThis.window; });
  return {dom, root, review, report, before, abort, revisions};
}
test('whole documents remain visible; current A edits can be accepted into B in one click', async t => {
  const a = ['Оплата через 10 дней', ...Array.from({length: 40}, (_, i) => `Одинаковый абзац ${i}`)].join('\n');
  const b = a.replace('10 дней', '30 дней'), p = await setup(t, a, b);
  assert.equal(p.root.querySelectorAll('.visual-paragraph').length, 82, 'all text, including unchanged context, is visible');
  p.root.querySelector('.visual-column .has-difference').click();
  const left = p.root.querySelector('[data-edit-side="left"]');
  left.value = 'Оплата через 20 дней'; left.dispatchEvent(new p.dom.window.Event('input'));
  p.root.querySelector('[data-copy-to="right"]').click();
  assert.equal(p.review.drafts.right.get(p.report.changed[0].key), 'Оплата через 20 дней');
  assert.match(p.root.querySelector('.visual-progress').textContent, /совпадают/);
  assert.equal(p.root.querySelectorAll('.has-difference').length, 0);
  assert.equal(JSON.stringify(p.report), p.before);
  assert.ok(p.revisions.includes(true));
});
test('both undo buttons target their own document, including after copying the other draft', async t => {
  const p = await setup(t, 'Цена 100', 'Цена 200');
  p.root.querySelector('.visual-column .has-difference').click();
  p.root.querySelector('[data-copy-to="left"]').click();
  assert.equal(p.review.drafts.left.text(), 'Цена 200');
  p.root.querySelector('[aria-label="Отменить правку A"]').click();
  assert.equal(p.review.drafts.left.text(), 'Цена 100');
  assert.equal(p.review.drafts.right.text(), 'Цена 200');
  assert.match(p.root.querySelector('.visual-progress').textContent, /Отличий: 1/);
});
test('one-click addition and full-copy retain source order, empty blocks and Unicode', async t => {
  const p = await setup(t, 'Начало\nДобавленный пункт 😀\nКонец', 'Начало\nКонец');
  assert.equal(p.root.querySelectorAll('[data-missing-key]').length, 1);
  p.root.querySelector('[data-missing-key]').click();
  assert.equal(p.review.drafts.right.text(), p.review.drafts.left.text());
  const field = p.root.querySelector('[data-edit-side="left"]');
  field.value = '  😀 новая редакция  '; field.dispatchEvent(new p.dom.window.Event('input'));
  p.root.querySelector('[data-action="copy-all-right"]').click();
  assert.equal(p.review.drafts.right.text(), 'Начало\n  😀 новая редакция  \nКонец');
});
test('source cancellation clears pages and detached editor events cannot mutate a newer revision', async t => {
  const p = await setup(t, 'A', 'B');
  p.root.querySelector('.visual-paragraph').click();
  const input = p.root.querySelector('[data-edit-side="right"]');
  p.abort.abort(); assert.equal(p.root.childElementCount, 0);
  input.value = 'stale'; input.dispatchEvent(new p.dom.window.Event('input'));
  assert.equal(p.review.drafts.right.text(), 'B');
});
