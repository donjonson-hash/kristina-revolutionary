import test from 'node:test';
import assert from 'node:assert/strict';
import editor from '../../static/reconciliation/text-editor.js';
import {compareText} from '../../extension/text-engine.mjs';
import {readTextSource} from '../../extension/text-source.mjs';
import {pdfSource} from './pdf-input-fixture.mjs';
import {docx} from './text-fixture.mjs';
const input = (raw, name = 'file.txt') => ({name, data: Buffer.from(raw).toString('base64')});
const compare = (a, b) => compareText({left: input(a), right: input(b)});
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

test('individual fixes add, delete and replace without mutating the source evidence', async () => {
  const a = 'Начало\nОплата через 10 дней.\nРаздел два\nУдалённый пункт\nКонец';
  const b = 'Начало\nОплата через 30 дней.\nРаздел два\nКонец\nНовый пункт';
  const report = freeze(await compare(a, b)), original = JSON.stringify(report), draft = editor.create(report);
  assert.equal(draft.text(), b);
  for (const category of ['changed', 'only_left', 'only_right']) for (const item of report[category]) draft.apply(item.key);
  assert.equal(draft.text(), a); assert.equal(draft.matchesCanonical, true);
  assert.equal(JSON.stringify(report), original);
  draft.undo(); assert.match(draft.text(), /Новый пункт/);
  draft.reset(); assert.equal(draft.text(), b);
  draft.undo(); assert.match(draft.text(), /Новый пункт/);
});

test('moves start in B order; per-row correction and apply-all restore A order', async () => {
  const a = 'Раздел первый\nПереносимый пункт\nРаздел второй\nКонец документа';
  const b = 'Раздел первый\nРаздел второй\nКонец документа\nПереносимый пункт';
  const report = await compare(a, b), draft = editor.create(report);
  assert.ok(report.moved.length); assert.equal(draft.text(), b);
  for (const item of report.moved) draft.apply(item.key);
  assert.equal(draft.text(), a);
  draft.reset(); draft.applyAll(); assert.equal(draft.text(), a);
  draft.undo(); assert.equal(draft.text(), b);
});

test('PDF reflow preserves original blocks on both sides', async () => {
  const a = ['Payment due in 10 days.', 'End'];
  const b = ['Payment due', 'in 10 days.', 'End'];
  const report = await compareText({left: input(docx(a), 'a.docx'), right: await pdfSource('b.pdf', [b], {standardFont: true})});
  assert.ok(report.reflow.length);
  const draft = editor.create(report); assert.equal(draft.text(), b.join('\n'));
  draft.apply(report.reflow[0].key); assert.equal(draft.text(), a.join('\n'));
  draft.reset(); draft.applyAll(); assert.equal(draft.text(), a.join('\n'));
});

test('typing is one undo step; empty fragment differs from deletion; apply-all is undoable', async () => {
  const report = await compare('Первый\nПоследний', 'Первый\nЛишний пункт\nПоследний');
  const key = report.only_right[0].key, draft = editor.create(report);
  draft.edit(key, 'x'); draft.edit(key, 'xy'); draft.undo(); assert.equal(draft.get(key), 'Лишний пункт');
  draft.edit(key, ''); assert.equal(draft.text(), 'Первый\n\nПоследний');
  draft.endEdit(); draft.apply(key); assert.equal(draft.get(key), null); assert.equal(draft.text(), 'Первый\nПоследний');
  draft.undo(); assert.equal(draft.get(key), '');
  draft.edit(key, 'ручная\r\nправка'); draft.applyAll(); assert.equal(draft.matchesCanonical, true);
  draft.undo(); assert.equal(draft.get(key), 'ручная\nправка');
});

test('oversized edits fail atomically and invalid or incomplete reports are refused', async () => {
  const report = await compare('текст', 'текст'), draft = editor.create(report), key = report.matched[0].key;
  assert.throws(() => draft.edit(key, 'x'.repeat(500001)), /500 000/);
  assert.equal(draft.text(), 'текст'); assert.equal(draft.canUndo, false);
  assert.throws(() => editor.create({kind: 'table', status: 'complete'}));
  assert.throws(() => editor.create({kind: 'text', status: 'clarification'}));
  assert.throws(() => draft.apply('nonexistent'));
});


test('export round-trips final blank blocks through TXT reader', async () => {
  const report = await compare('  Точный текст 😀  \n\n', 'первая\nвторая');
  const draft = editor.create(report); draft.applyAll();
  const parsed = await readTextSource(input(draft.exportText()));
  assert.deepEqual(parsed.blocks.map(block => block.text), ['  Точный текст 😀  ', '']);
});
