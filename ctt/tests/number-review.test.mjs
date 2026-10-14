import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountVisualReview} from '../dist/visual-review.mjs';
import {compareText} from '../dist/text-engine.mjs';
import editor from '../dist/text-editor.js';
import {mountNumberReview} from '../dist/number-review.mjs';
import {createReviewQueue} from '../dist/review-queue.mjs';
const source = (name, text) => ({name, data: Buffer.from(text).toString('base64')});
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(t, options = {}) {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  window.KristinaTextEditor = editor; window.Element.prototype.scrollIntoView = () => {};
  const sources = {left: source('A.txt', 'Price $100. Deposit 30%.\nThank you.'), right: source('B.txt', 'Price $150. Deposit 50%.\nThank you.')};
  const report = await compareText(sources), original = JSON.stringify(report);
  let saves = 0, view = await mountVisualReview(root, {report, sources, ...options, onStateChange: () => saves++});
  const q = selector => root.querySelector(selector);
  t.after(() => { view.dispose(); dom.window.close(); delete globalThis.window; delete globalThis.document; assert.equal(JSON.stringify(report), original); });
  return {dom, root, q, report, sources, get view() { return view; }, get saves() { return saves; },
    async restore(snapshot) { view.dispose(); view = await mountVisualReview(root, {report, sources, restoredState: snapshot}); },
    edit(side, text) { const field = q(`[data-edit-side="${side}"]`); field.value = text; field.dispatchEvent(new dom.window.Event('input')); },
  };
}

test('real editor: open evidence, select the exact changed value, edit, copy and undo without stale cards', async t => {
  const p = await harness(t);
  assert.match(p.q('.number-review').textContent, /\$100 → \$150/);
  p.q('[data-number-action="show"]').click(); await tick();
  const field = p.q('[data-edit-side="right"]');
  assert.equal(field.value.slice(field.selectionStart, field.selectionEnd), '$150');
  assert.equal(document.activeElement, field);
  p.edit('right', 'Price $180. Deposit 50%.');
  assert.match(p.q('.number-review-values').textContent, /\$180/);
  assert.doesNotMatch(p.q('.number-review-values').textContent, /\$150/);
  p.q('[data-copy-to="right"]').click(); assert.equal(p.q('[data-number-passage]'), null);
  assert.match(p.q('.number-review').textContent, /No changes to supported/);
  p.q('[aria-label="Undo edit in B"]').click();
  assert.match(p.q('.number-review-values').textContent, /\$180/);
});

test('values checked survive reopening, are independent of whole-passage review, and reopen after edits or undo', async t => {
  const p = await harness(t); p.q('.number-review').open = true;
  p.q('[data-number-action="check"]').click();
  assert.equal(p.q('[data-number-action="check"]').getAttribute('aria-pressed'), 'true');
  assert.match(p.q('.review-flow-progress').textContent, /Reviewed 0 of/);
  assert.ok(p.saves > 0);
  await p.restore(p.view.snapshot());
  assert.equal(p.q('.number-review').open, true);
  assert.equal(p.q('[data-number-action="check"]').getAttribute('aria-pressed'), 'true');
  await p.view.select(p.report.changed[0].key);
  p.edit('left', 'Price $110. Deposit 30%.');
  assert.equal(p.q('[data-number-action="check"]').getAttribute('aria-pressed'), 'false');
  p.q('[aria-label="Undo edit in A"]').click();
  assert.equal(p.q('[data-number-action="check"]').getAttribute('aria-pressed'), 'false');
  const legacy = p.view.snapshot(); delete legacy.numberReview;
  await p.restore(legacy); assert.equal(p.q('[data-number-action="check"]').getAttribute('aria-pressed'), 'false');
});

test('rewritten passages expose both original contexts and cannot execute document markup', async t => {
  const p = await harness(t); await p.view.select(p.report.changed[0].key);
  p.edit('right', 'New price $180. <img src=x onerror=alert(1)> Deposit 40%.');
  assert.match(p.q('.number-review-item').textContent, /Review values in context/);
  assert.equal(p.q('.number-review-values'), null);
  assert.equal(p.q('.number-review-item img'), null);
  assert.match(p.q('.number-review-item').textContent, /<img src=x/);
});

test('the comparison-only panel stays out of Edit & export', async t => {
  const p = await harness(t, {single: true}); assert.equal(p.q('.number-review'), null);
  assert.equal(p.view.snapshot().numberReview, undefined);
});

test('long lists paginate, retain review decisions and drop removed passages', t => {
  const dom = new JSDOM('<main></main>'); globalThis.document = dom.window.document;
  const root = document.querySelector('main'), queue = createReviewQueue();
  let blocks = Array.from({length: 12}, (_, i) => ({key: `text-${i}`, left: `Item ${i}: $10`, right: `Item ${i}: $20`}));
  const view = mountNumberReview(root, {queue, getBlocks: () => blocks, choose: async () => {}, onChange() {}});
  t.after(() => { view.dispose(); dom.window.close(); delete globalThis.document; });
  view.refresh('1'); assert.equal(root.querySelectorAll('[data-number-passage]').length, 5);
  root.querySelector('[data-number-action="check"]').click();
  [...root.querySelectorAll('button')].find(b => b.textContent === 'Next passages').click();
  assert.equal(root.querySelector('[data-number-passage]').dataset.numberPassage, 'text-5');
  blocks = blocks.slice(0, 1); view.refresh('2');
  assert.equal(root.querySelector('[data-number-action="check"]').getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('.number-review-pages').hidden, true);
  blocks = []; view.refresh('3'); assert.equal(queue.progress().total, 0);
});
