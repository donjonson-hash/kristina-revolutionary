import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {compareText} from '../../extension/text-engine.mjs';
import editor from '../../static/reconciliation/text-editor.js';
import {mountVisualReview} from '../../extension/visual-review.mjs';
const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM} = require('jsdom');
const source = text => ({name: 'document.txt', data: Buffer.from(text).toString('base64')});
async function setup(t, a, b, options = {}) {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main');
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  window.KristinaTextEditor = editor; window.Element.prototype.scrollIntoView = () => {};
  const sources = {left: source(a), right: source(b)}, report = await compareText(sources), before = JSON.stringify(report);
  const abort = new AbortController(), revisions = [], changes = [];
  const review = await mountVisualReview(root, {report, sources, signal: abort.signal, onRevision: value => revisions.push(value), onStateChange: () => changes.push(true), ...options});
  t.after(() => { abort.abort(); review.dispose(); dom.window.close(); delete globalThis.document; delete globalThis.window; });
  return {dom, root, review, report, before, abort, revisions, changes, sources};
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

test('resume keeps both drafts, independent undo, selection, zoom, scroll and the last keystroke', async t => {
  const p = await setup(t, 'Цена 100\nКонец', 'Цена 200\nКонец');
  assert.equal(p.changes.length, 0, 'rendering alone does not request saves');
  const key = p.report.changed[0].key;
  await p.review.select(key);
  for (const [side, value] of [['left', 'Цена 150'], ['right', 'Цена 250']]) {
    const field = p.root.querySelector(`[data-edit-side="${side}"]`);
    field.value = value; field.dispatchEvent(new p.dom.window.Event('input'));
  }
  const zoom = p.root.querySelector('select'); zoom.value = '1191'; zoom.dispatchEvent(new p.dom.window.Event('change'));
  const panes = p.root.querySelectorAll('.visual-scroll');
  panes[0].scrollTop = 120; panes[0].scrollLeft = 40; panes[0].dispatchEvent(new p.dom.window.Event('scroll'));
  panes[1].scrollTop = 230; panes[1].scrollLeft = 50; panes[1].dispatchEvent(new p.dom.window.Event('scroll'));
  const state = JSON.parse(JSON.stringify(p.review.snapshot()));
  assert.equal(state.drafts.right.entries[0].text, 'Цена 250', 'snapshot includes input before delayed render');
  assert.equal(p.changes.length, 6);
  p.review.dispose();
  const restored = await setup(t, 'Цена 100\nКонец', 'Цена 200\nКонец', {restoredState: state});
  assert.deepEqual(restored.review.snapshot(), state);
  assert.equal(restored.changes.length, 0, 'restoration does not start a save loop');
  assert.equal(restored.root.querySelector('.visual-inspector').hidden, false);
  assert.equal(restored.root.querySelector('[data-edit-side="left"]').value, 'Цена 150');
  assert.equal(restored.root.querySelector('[data-edit-side="right"]').value, 'Цена 250');
  restored.root.querySelector('[aria-label="Отменить правку A"]').click();
  assert.equal(restored.review.drafts.left.get(key), 'Цена 100');
  assert.equal(restored.review.drafts.right.get(key), 'Цена 250');
  restored.root.querySelector('[aria-label="Отменить правку B"]').click();
  assert.equal(restored.review.drafts.right.get(key), 'Цена 200');
  [...restored.root.querySelectorAll('button')].find(node => node.textContent === 'Готово ✓').click();
  assert.equal(restored.review.snapshot().selected, null);
  assert.equal(restored.changes.length, 3);
});

test('malformed saved navigation and editor data fail visibly before replacing current UI', async t => {
  const p = await setup(t, 'Цена 100', 'Цена 200'), baseline = p.root.innerHTML;
  for (const mutate of [state => { state.selected = 'missing'; }, state => { state.zoom = '-1'; }, state => { state.pages.right = 2; }, state => { state.scroll.left.top = Infinity; }, state => { state.drafts.right.entries[0].record = 99; }]) {
    const state = p.review.snapshot(); mutate(state);
    await assert.rejects(mountVisualReview(p.root, {report: p.report, sources: p.sources, restoredState: state}), /поврежден/);
    assert.equal(p.root.innerHTML, baseline);
  }
});

test('aborted review never saves detached input, selection, zoom, scroll, reset or delayed renders', async t => {
  const p = await setup(t, 'Цена 100', 'Цена 200');
  await p.review.select(p.report.changed[0].key);
  const input = p.root.querySelector('[data-edit-side="right"]'), zoom = p.root.querySelector('select'), scroll = p.root.querySelector('.visual-scroll');
  const reset = [...p.root.querySelectorAll('button')].find(node => node.textContent === 'Вернуть исходные документы');
  input.value = 'Цена 300'; input.dispatchEvent(new p.dom.window.Event('input'));
  const count = p.changes.length; p.abort.abort();
  input.value = 'stale'; input.dispatchEvent(new p.dom.window.Event('input'));
  zoom.dispatchEvent(new p.dom.window.Event('change')); scroll.scrollTop = 10; scroll.dispatchEvent(new p.dom.window.Event('scroll')); reset.click();
  await p.review.select(p.report.changed[0].key);
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(p.changes.length, count);
  assert.equal(p.review.drafts.right.text(), 'Цена 300');
});
