import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {compareText} from '../../extension/text-engine.mjs';
import editor from '../../static/reconciliation/text-editor.js';
import {mountVisualReview} from '../../extension/visual-review.mjs';
import {docx, W} from './text-fixture.mjs';
const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM} = require('jsdom');
const source = text => ({name: 'document.txt', data: Buffer.from(text).toString('base64')});
async function setup(t, a, b, options = {}) {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main');
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  window.KristinaTextEditor = editor; window.Element.prototype.scrollIntoView = () => {};
  const sources = options.sources || {left: source(a), right: source(b)}, report = await compareText(sources), before = JSON.stringify(report);
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

test('Word list markers stay outside editable text through copy and session restoration', async t => {
  const make = text => ({name: 'terms.docx', data: Buffer.from(docx([], {
    xml: `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Подпись</w:t></w:r></w:p></w:body></w:document>`,
    extraEntries: {'word/numbering.xml': `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="7"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`},
  })).toString('base64')});
  const sources = {left: make('Оплата 10 дней'), right: make('Оплата 30 дней')};
  const p = await setup(t, '', '', {sources});
  assert.deepEqual([...p.root.querySelectorAll('.visual-list-marker')].map(n => n.textContent), ['7.', '8.', '7.', '8.']);
  p.root.querySelector('.visual-list-marker').click();
  const field = p.root.querySelector('[data-edit-side="left"]');
  assert.equal(field.value, 'Оплата 10 дней');
  field.value = 'Оплата 20 дней'; field.dispatchEvent(new p.dom.window.Event('input'));
  p.root.querySelector('[data-copy-to="right"]').click();
  assert.equal(p.review.drafts.right.get(p.report.changed[0].key), 'Оплата 20 дней');
  const restoredState = JSON.parse(JSON.stringify(p.review.snapshot())); p.review.dispose();
  const resumed = await setup(t, '', '', {sources, restoredState});
  assert.deepEqual([...resumed.root.querySelectorAll('.visual-list-marker')].map(n => n.textContent), ['7.', '8.', '7.', '8.']);
  assert.equal(resumed.root.querySelector('[data-edit-side="right"]').value, 'Оплата 20 дней');
  assert.match(resumed.root.querySelector('.visual-instruction').textContent, /текст пунктов/);
  assert.equal(resumed.root.querySelector('.visual-list-item').style.paddingLeft, '18pt');
});

test('Word tables show merged cells, edit the selected cell in both drafts, and restore grid and undo', async t => {
  const {tableSource} = await import('./table-fixture.mjs');
  const sources = {left: tableSource('100'), right: tableSource('200')};
  const p = await setup(t, '', '', {sources});
  assert.equal(p.root.querySelectorAll('.visual-table').length, 2);
  const table = p.root.querySelector('.visual-table');
  assert.equal(table.rows[0].cells[0].colSpan, 3);
  assert.equal(table.rows[1].cells[0].rowSpan, 2);
  assert.equal(table.rows[2].cells[0].querySelectorAll('.visual-paragraph').length, 2);
  assert.equal(table.querySelectorAll('.has-difference').length, 2);
  table.querySelector('.has-difference').click();
  const key = p.report.changed[0].key, field = p.root.querySelector('[data-edit-side="left"]');
  field.value = '150 <НДС & доставка>'; field.dispatchEvent(new p.dom.window.Event('input'));
  p.root.querySelector('[data-copy-to="right"]').click();
  assert.equal(p.review.drafts.right.get(key), field.value);
  assert.equal(p.root.querySelectorAll('.visual-table').length, 2);
  assert.equal(p.root.querySelectorAll('.visual-table script').length, 0);
  const state = JSON.parse(JSON.stringify(p.review.snapshot())); p.review.dispose();
  const restored = await setup(t, '', '', {sources, restoredState: state});
  assert.equal(restored.root.querySelector('.visual-table').rows[1].cells[0].rowSpan, 2);
  assert.equal(restored.review.drafts.right.get(key), '150 <НДС & доставка>');
  restored.root.querySelector('[aria-label="Отменить правку B"]').click();
  assert.equal(restored.review.drafts.right.get(key), '200');
  assert.equal(restored.review.drafts.left.get(key), '150 <НДС & доставка>');
  restored.root.querySelector('[data-action="copy-all-right"]').click();
  assert.equal(restored.review.drafts.right.text(), restored.review.drafts.left.text());
  assert.equal(restored.root.querySelectorAll('.visual-table .has-difference').length, 0);
});

test('incompatible table copy gives a readable message and keeps the current table draft intact', async t => {
  const {tableSource, paragraph} = await import('./table-fixture.mjs');
  const p = await setup(t, '', '', {sources: {left: tableSource('', {body: paragraph('Другой документ')}), right: tableSource()}});
  const before = p.review.drafts.right.snapshot();
  p.root.querySelector('[data-action="copy-all-right"]').click();
  assert.deepEqual(p.review.drafts.right.snapshot(), before);
  assert.equal(p.root.querySelectorAll('.visual-table').length, 1);
  assert.match(p.root.textContent, /разная структура/);
});

test('Word row controls edit new cells, restore their selection, copy the structure and undo deletion', async t => {
  const {tableSource, table, cell, paragraph} = await import('./table-fixture.mjs');
  const source = price => tableSource('', {body: paragraph('Начало') + table([
    [cell('Товар'), cell('Цена'), cell('Срок')],
    [cell('Первый'), cell(price), cell('5 дней')],
    [cell('Второй'), cell('200'), cell('10 дней')],
  ]) + paragraph('Конец')});
  const sources = {left: source('100'), right: source('120')}, p = await setup(t, '', '', {sources});
  const first = p.root.querySelector('.visual-table'); first.rows[1].cells[0].querySelector('.visual-paragraph').click();
  p.root.querySelector('[data-insert-row="after"][data-row-side="left"]').click();
  assert.deepEqual([...p.root.querySelectorAll('.visual-table')].map(t => t.rows.length), [4,3]);
  const key = p.review.snapshot().selected; assert.match(key, /^row-left-/);
  const field = p.root.querySelector('[data-edit-side="left"]');
  field.value = 'Новая позиция <A & B>'; field.dispatchEvent(new p.dom.window.Event('input'));
  assert.equal(p.root.querySelector('[data-edit-side="right"]').disabled, true);
  const state = p.review.snapshot();
  const {validateSessionPayload} = await import('../../extension/session-store.mjs');
  assert.equal(validateSessionPayload({version:1,sources,report:p.report,review:state}).review.selected, key);
  assert.equal(JSON.stringify(p.report), p.before);
  p.review.dispose();
  const restored = await setup(t, '', '', {sources, restoredState: JSON.parse(JSON.stringify(state))});
  assert.equal(restored.review.snapshot().selected, key);
  assert.equal(restored.root.querySelector('[data-edit-side="left"]').value, field.value);
  assert.equal(restored.root.querySelectorAll('.visual-table')[0].rows.length, 4);
  restored.root.querySelector('[data-action="copy-all-right"]').click();
  assert.deepEqual([...restored.root.querySelectorAll('.visual-table')].map(t => t.rows.length), [4,4]);
  assert.equal(restored.review.drafts.right.get(key), 'Новая позиция <A & B>');
  assert.match(restored.root.querySelector('.visual-progress').textContent, /совпадают/);
  restored.root.querySelector('[data-delete-row][data-row-side="right"]').click();
  assert.equal(restored.root.querySelectorAll('.visual-table')[1].rows.length, 3);
  assert.equal(restored.review.snapshot().selected, null);
  restored.root.querySelector('[aria-label="Отменить правку B"]').click();
  assert.equal(restored.root.querySelectorAll('.visual-table')[1].rows.length, 4);
  assert.equal(restored.review.drafts.right.get(key), 'Новая позиция <A & B>');
});

test('Word row controls protect vertical merges and reject forged restored row state without replacing UI', async t => {
  const {tableSource} = await import('./table-fixture.mjs');
  const sources = {left: tableSource(), right: tableSource('200')}, p = await setup(t, '', '', {sources});
  const first = p.root.querySelector('.visual-table'); first.rows[1].cells[0].querySelector('.visual-paragraph').click();
  for (const selector of ['[data-insert-row="before"]','[data-insert-row="after"]','[data-delete-row]']) assert.equal(p.root.querySelector(selector + '[data-row-side="left"]').disabled, true);
  assert.equal(p.root.querySelector('[data-copy-row-text-from="left"]').disabled, true);
  const before = p.root.innerHTML, state = p.review.snapshot();
  state.drafts.left.rowPlan.tables[0].rows.splice(1,1);
  await assert.rejects(() => mountVisualReview(p.root, {sources,report:p.report,restoredState:state}), /объедин|поврежд|план/);
  assert.equal(p.root.innerHTML, before);
});

test('existing row action copies all text from a matching cell selection and preserves independent rows through resume and undo', async t => {
  const {tableSource, table, cell, paragraph} = await import('./table-fixture.mjs');
  const make = (note, count, price, total) => tableSource('', {body: table([
    [cell('Товар'), cell('Количество'), cell('Цена')],
    [cell([paragraph('Первый'), paragraph(note)]), cell(count), cell(price)],
    [cell('Итого', '<w:gridSpan w:val="2"/>'), cell(total)],
  ])});
  const sources = {left: make('Синий', '2', '100', '200'), right: make('Красный', '3', '120', '360')}, p = await setup(t, '', '', {sources});
  const key = p.review.drafts.left.entries().find(entry => entry.text === 'Первый').key;
  const own = p.review.drafts.right.insertRow(1, 2, 'before'); p.review.drafts.right.edit(own, 'Своя строка B');
  await p.review.select(key);
  const control = p.root.querySelector('[data-copy-row-text-from="left"]');
  assert.equal(control.hidden, false); assert.equal(control.disabled, false, 'other cells differ even though selected text matches');
  assert.match(control.textContent, /строку B как A/);
  const sourceBefore = p.review.drafts.left.snapshot(), before = p.review.drafts.right.snapshot();
  control.click();
  assert.deepEqual(p.review.drafts.left.snapshot(), sourceBefore);
  assert.deepEqual(p.review.drafts.right.rowPlan(), before.rowPlan);
  assert.deepEqual(p.review.drafts.right.entries().map(entry => entry.text), ['Товар','Количество','Цена','Своя строка B','','','Первый','Синий','2','100','Итого','360']);
  assert.equal(control.disabled, true);
  assert.equal(p.root.querySelectorAll('.visual-table')[1].rows.length, 4);
  const state = p.review.snapshot(); p.review.dispose();
  const restored = await setup(t, '', '', {sources, restoredState: state});
  assert.equal(restored.root.querySelector('[data-copy-row-text-from="left"]').disabled, true);
  restored.root.querySelector('[aria-label="Отменить правку B"]').click();
  assert.deepEqual(restored.review.drafts.right.snapshot().entries, before.entries);
  await restored.review.select(restored.review.drafts.right.entries().find(entry => entry.text === 'Красный').key);
  restored.root.querySelector('[data-copy-row-text-from="right"]').click();
  assert.deepEqual(restored.review.drafts.left.entries().map(entry => entry.text), ['Товар','Количество','Цена','Первый','Красный','3','120','Итого','200']);
  assert.equal(restored.review.snapshot().selected, restored.review.drafts.left.entries().find(entry => entry.text === 'Первый').key, 'selection follows the row actually updated');
  assert.equal(JSON.stringify(restored.report), p.before);
});

test('one row transfer preserves other edits, updates without duplicates, resumes and undoes independently', async t => {
  const {tableSource, table, cell} = await import('./table-fixture.mjs');
  const make = price => tableSource('', {body: table([[cell('Товар'), cell('Цена'), cell('Срок')], [cell('Первый'), cell(price), cell('5 дней')]])});
  const sources = {left: make('100'), right: make('120')}, p = await setup(t, '', '', {sources});
  const choose = async (side, row) => p.review.select(p.root.querySelectorAll('.visual-table')[side].rows[row].querySelector('[data-group]').dataset.group);
  await choose(0, 1);
  assert.equal(p.root.querySelector('[data-copy-row-from="left"]').hidden, true);
  p.root.querySelector('[data-insert-row="after"][data-row-side="left"]').click();
  const key = p.review.snapshot().selected;
  const edit = (side, text) => { const field = p.root.querySelector(`[data-edit-side="${side}"]`); field.value = text; field.dispatchEvent(new p.dom.window.Event('input')); };
  edit('left', 'Новая строка <&>');
  await choose(1, 1);
  p.root.querySelector('[data-insert-row="before"][data-row-side="right"]').click();
  const ownKey = p.review.snapshot().selected; edit('right', 'Своя строка B');
  await p.review.select(key);
  assert.match(p.root.querySelector('[data-edit-side="right"]').placeholder, /Перенести строку в B/);
  const beforeLeft = p.review.drafts.left.snapshot(), beforeRight = p.review.drafts.right.snapshot();
  p.root.querySelector('[data-copy-row-from="left"]').click();
  assert.deepEqual(p.review.drafts.left.snapshot(), beforeLeft);
  assert.equal(p.review.drafts.right.get(key), 'Новая строка <&>');
  assert.equal(p.review.drafts.right.get(ownKey), 'Своя строка B');
  assert.equal(p.review.drafts.right.get(p.report.changed[0].key), '120');
  assert.equal(p.root.querySelectorAll('.visual-table')[1].rows.length, 4);
  assert.equal(p.root.querySelector('[data-edit-side="right"]').disabled, false);
  assert.equal(p.root.querySelector('[data-copy-row-from="left"]').disabled, true);
  edit('left', 'Обновлённая строка');
  assert.match(p.root.querySelector('[data-copy-row-from="left"]').textContent, /Обновить/);
  p.root.querySelector('[data-copy-row-from="left"]').click();
  assert.equal(p.review.drafts.right.get(key), 'Обновлённая строка');
  assert.equal(p.root.querySelectorAll('.visual-table')[1].rows.length, 4);
  const restoredState = p.review.snapshot(); p.review.dispose();
  const resumed = await setup(t, '', '', {sources, restoredState});
  assert.equal(resumed.review.snapshot().selected, key);
  resumed.root.querySelector('[aria-label="Отменить правку B"]').click();
  assert.equal(resumed.review.drafts.right.get(key), 'Новая строка <&>');
  resumed.root.querySelector('[aria-label="Отменить правку B"]').click();
  assert.deepEqual(resumed.review.drafts.right.snapshot().entries, beforeRight.entries);
  assert.deepEqual(resumed.review.drafts.right.rowPlan(), beforeRight.rowPlan);
  assert.equal(resumed.review.drafts.left.get(key), 'Обновлённая строка');
  await resumed.review.select(ownKey);
  resumed.root.querySelector('[data-copy-row-from="right"]').click();
  assert.equal(resumed.review.drafts.left.get(ownKey), 'Своя строка B');
  assert.equal(JSON.stringify(resumed.report), p.before);
});
