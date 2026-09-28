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

test('either document can be edited and copied from the other current draft', async () => {
  const report = freeze(await compare('Начало\nОплата через 10 дней.\nКонец', 'Начало\nОплата через 30 дней.\nКонец'));
  const before = JSON.stringify(report), key = report.changed[0].key;
  const a = editor.create(report, 'left'), b = editor.create(report);
  assert.equal(a.text(), 'Начало\nОплата через 10 дней.\nКонец');
  assert.equal(a.canonicalText(), b.text());
  a.edit(key, 'Оплата через 15 дней.');
  b.set(key, a.get(key));
  assert.equal(a.text(), b.text());
  b.undo(); assert.equal(b.get(key), 'Оплата через 30 дней.');
  a.set(key, b.get(key)); assert.equal(a.get(key), 'Оплата через 30 дней.');
  a.undo(); assert.equal(a.get(key), 'Оплата через 15 дней.');
  a.undo(); assert.equal(a.get(key), 'Оплата через 10 дней.');
  a.apply(key); assert.equal(a.get(key), 'Оплата через 30 дней.');
  a.reset(); assert.equal(a.changed, false);
  assert.equal(JSON.stringify(report), before);
});

test('copy operations insert and remove fragments in either document, preserving empty text', async () => {
  const report = await compare('Начало\nТолько первый\nКонец', 'Начало\nКонец\nТолько второй');
  const a = editor.create(report, 'left'), b = editor.create(report);
  const first = report.only_left[0].key, second = report.only_right[0].key;
  a.set(second, b.get(second)); assert.equal(a.text(), 'Начало\nТолько первый\nКонец\nТолько второй');
  b.set(first, a.get(first)); assert.equal(b.text(), a.text());
  a.set(second, null); assert.equal(a.get(second), null);
  b.set(second, a.get(second)); assert.equal(b.get(second), null);
  a.set(first, ''); b.set(first, a.get(first)); assert.equal(b.text(), 'Начало\n\nКонец');
  b.undo(); assert.equal(b.get(first), 'Только первый');
});

test('copy-all uses current opposite draft order and keeps own source coordinates', async () => {
  const first = 'Раздел первый\nПереносимый пункт\nРаздел второй\nКонец документа';
  const second = 'Раздел первый\nРаздел второй\nКонец документа\nПереносимый пункт';
  const report = freeze(await compare(first, second)), a = editor.create(report, 'left'), b = editor.create(report);
  const originalA = a.entries(), moved = report.moved[0].key;
  b.edit(moved, 'Новая редакция переносимого пункта');
  a.replaceAll(b.entries());
  assert.equal(a.text(), b.text());
  for (const entry of a.entries()) assert.equal(entry.record, originalA.find(row => row.key === entry.key).record);
  a.undo(); assert.equal(a.text(), first);
  a.set(moved, b.get(moved), {relocate: true}); assert.equal(a.text(), b.text());
  b.replaceAll(a.entries()); assert.equal(b.text(), a.text());
  a.reset(); a.applyAll(); assert.equal(a.text(), second);
  a.undo(); assert.equal(a.text(), first);
});

test('entries are independent snapshots; invalid copy-all fails without changing the draft', async () => {
  const report = await compare('A\nB', 'A\nC'), draft = editor.create(report);
  const snapshot = draft.entries(), before = draft.text();
  snapshot[0].text = 'Tampered'; snapshot.reverse();
  assert.equal(draft.text(), before);
  assert.throws(() => draft.replaceAll([{key: snapshot[0].key, text: 'valid'}, {key: 'missing', text: 'bad'}]));
  assert.throws(() => draft.replaceAll([{key: snapshot[0].key, text: 'x'.repeat(500001)}]), /500 000/);
  assert.throws(() => draft.replaceAll([{key: snapshot[0].key, text: null}]));
  assert.throws(() => editor.create(report, 'unknown'));
  assert.equal(draft.text(), before); assert.equal(draft.canUndo, false);
});

test('copy-all preserves reflow blocks and copy actions end a typing undo group', async () => {
  const report = await compareText({left: input(docx(['Payment due in 10 days.', 'End']), 'a.docx'), right: await pdfSource('b.pdf', [['Payment due', 'in 10 days.', 'End']], {standardFont: true})});
  const a = editor.create(report, 'left'), b = editor.create(report), key = report.reflow[0].key;
  a.replaceAll(b.entries()); assert.equal(a.text(), b.text()); assert.equal(a.entries().length, b.entries().length);
  a.undo(); assert.equal(a.text(), 'Payment due in 10 days.\nEnd');
  b.edit(key, 'First edit'); b.set(key, 'First edit'); b.edit(key, 'Second edit');
  b.undo(); assert.equal(b.get(key), 'First edit'); b.undo(); assert.equal(b.get(key), 'Payment due\nin 10 days.');
});

test('inserted fragments never borrow opposite source records that belong to existing paragraphs', async () => {
  const report = freeze(await compare('Начало\nТолько первый\nКонец', 'Начало\nКонец\nТолько второй'));
  for (const side of ['left', 'right']) {
    const target = editor.create(report, side), other = editor.create(report, side === 'left' ? 'right' : 'left');
    const key = report[side === 'left' ? 'only_right' : 'only_left'][0].key;
    const originalEntries = target.entries();
    assert.ok(originalEntries.some(entry => entry.record === other.entries().find(entry => entry.key === key).record));
    target.set(key, other.get(key));
    assert.equal(target.entries().find(entry => entry.key === key).record, undefined);
    for (const entry of originalEntries) assert.equal(target.entries().find(row => row.key === entry.key).record, entry.record);
    target.reset(); target.apply(key);
    assert.equal(target.entries().find(entry => entry.key === key).record, undefined);
    target.applyAll(); assert.equal(target.text(), other.text());
    for (const entry of target.entries()) assert.equal(entry.record, originalEntries.find(row => row.key === entry.key)?.record);
  }
});

test('copying split or merged groups preserves only real target source record positions', async () => {
  const report = freeze(await compareText({left: input(docx(['Payment due in 10 days.', 'End']), 'a.docx'), right: await pdfSource('b.pdf', [['Payment due', 'in 10 days.', 'End']], {standardFont: true})}));
  const key = report.reflow[0].key;
  const left = editor.create(report, 'left'), right = editor.create(report, 'right');
  const leftRows = left.entries(), rightRows = right.entries();
  left.replaceAll(right.entries());
  assert.equal(left.text(), right.text());
  assert.deepEqual(left.entries().filter(entry => entry.key === key).map(entry => entry.record), [leftRows.find(entry => entry.key === key).record, undefined]);
  left.reset(); left.apply(key);
  assert.deepEqual(left.entries().filter(entry => entry.key === key).map(entry => entry.record), [leftRows.find(entry => entry.key === key).record, undefined]);
  left.reset(); right.replaceAll(left.entries());
  assert.equal(right.text(), left.text());
  assert.deepEqual(right.entries().filter(entry => entry.key === key).map(entry => entry.record), [rightRows.find(entry => entry.key === key).record]);
  const last = right.entries().at(-1);
  assert.equal(last.record, rightRows.find(entry => entry.key === last.key).record);
});

test('saved revisions preserve edits, deletion, insertion, moved order and independent undo after JSON storage', async () => {
  const report = await compare('Начало\nПереносимый пункт\nТолько первый\nКонец', 'Начало\nКонец\nПереносимый пункт\nТолько второй');
  for (const side of ['left', 'right']) {
    const draft = editor.create(report, side), opposite = editor.create(report, side === 'left' ? 'right' : 'left');
    draft.replaceAll(opposite.entries());
    const key = draft.entries()[0].key;
    draft.edit(key, 'Новая редакция 😀'); draft.edit(key, 'Последняя клавиша 😀');
    const saved = JSON.parse(JSON.stringify(draft.snapshot())), restored = editor.create(report, side);
    restored.restore(saved);
    assert.deepEqual(restored.entries(), draft.entries());
    saved.entries[0].text = 'tampered'; saved.history[0][0].text = 'tampered';
    assert.equal(restored.get(key), 'Последняя клавиша 😀');
    restored.undo(); draft.undo(); assert.deepEqual(restored.entries(), draft.entries());
    restored.undo(); draft.undo(); assert.deepEqual(restored.entries(), draft.entries());
    assert.equal(restored.canUndo, false);
  }
});

test('restore rejects invalid keys, record borrowing, split group order and oversized history atomically', async () => {
  const report = await compare('Начало\nДобавленный пункт\nКонец', 'Начало\nКонец');
  const draft = editor.create(report), key = report.only_left[0].key;
  draft.set(key, 'Вставка');
  const baseline = draft.snapshot(), inserted = baseline.entries.findIndex(entry => entry.key === key);
  const mutations = [
    state => { state.version = 2; },
    state => { state.side = 'left'; },
    state => { state.entries[0].key = 'unknown'; },
    state => { state.entries[inserted].record = 1; },
    state => { state.entries[0].record = 2; },
    state => { state.entries.push({...state.entries[0]}); },
    state => { state.entries[0].text = 'x'.repeat(500001); },
    state => { state.history = Array.from({length: 21}, () => []); },
    state => { state.history[0][0].key = 'unknown'; },
    state => { state.history = Array.from({length: 5}, () => [{...state.entries[0], text: 'x'.repeat(500000)}]); },
  ];
  for (const mutate of mutations) {
    const state = structuredClone(baseline); mutate(state);
    assert.throws(() => draft.restore(state), /повреждена/);
    assert.deepEqual(draft.snapshot(), baseline);
  }
});

test('reflow persistence retains own source coordinates and restores a fresh typing undo boundary', async () => {
  const report = await compareText({left: input(docx(['Payment due in 10 days.', 'End']), 'a.docx'), right: await pdfSource('b.pdf', [['Payment due', 'in 10 days.', 'End']], {standardFont: true})});
  const left = editor.create(report, 'left'), right = editor.create(report), key = report.reflow[0].key;
  left.replaceAll(right.entries());
  const restored = editor.create(report, 'left'); restored.restore(JSON.parse(JSON.stringify(left.snapshot())));
  assert.deepEqual(restored.entries(), left.entries());
  assert.deepEqual(restored.entries().filter(entry => entry.key === key).map(entry => entry.record), [1, undefined]);
  restored.edit(key, 'new'); restored.undo(); assert.deepEqual(restored.entries(), left.entries());
  restored.undo(); assert.equal(restored.text(), 'Payment due in 10 days.\nEnd');
});
