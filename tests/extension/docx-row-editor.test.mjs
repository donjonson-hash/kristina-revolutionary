import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocxRowEditor} from '../../extension/docx-row-editor.mjs';
import {readDocxVisual, writeDocxVisual} from '../../extension/docx-visual.mjs';
import {compareText} from '../../extension/text-engine.mjs';
import oldEditor from '../../static/reconciliation/text-editor.js';
import {tableSource, table, cell, paragraph} from './table-fixture.mjs';
const body = value => paragraph('До') + table([[cell('Наименование'), cell('Штук'), cell('Цена')], [cell([paragraph('Стул'), paragraph('Синий')]), cell('2'), cell(value)], [cell('Доставка', '<w:gridSpan w:val="2"/>'), cell('0')]]) + paragraph('После');
async function pair(leftBody = body('100'), rightBody = body('200')) {
  const left = tableSource('', {body:leftBody}), right = tableSource('', {body:rightBody});
  const report = await compareText({left, right}), models = {left:await readDocxVisual(left), right:await readDocxVisual(right)};
  return {report, models, sources:{left,right}, left:createDocxRowEditor(report, 'left', models.left), right:createDocxRowEditor(report, 'right', models.right)};
}
const clone = value => JSON.parse(JSON.stringify(value));
test('insert creates one empty paragraph per visible cell, retains horizontal spans, undo joins text and row actions', async () => {
  const {left, report} = await pair(), immutable = clone(report), before = left.snapshot();
  const key = left.insertRow(1, 2);
  assert.equal(key, 'row-left-1-1');
  assert.deepEqual(left.entries().filter(entry => entry.record < 0).map(entry => entry.text), ['', '', '']);
  assert.deepEqual(left.rowPlan().tables[0].rows[2], {id:'row-left-1', template:2, records:[-1,-2,-3]});
  left.edit(key, 'Стол'); left.edit(key, 'Стол новый');
  left.undo(); assert.equal(left.get(key), '');
  left.undo(); assert.deepEqual(left.entries(), before.entries); assert.equal(left.structureChanged, false);
  const second = left.insertRow(1,3, 'before');
  assert.equal(left.entries().filter(entry => entry.record < 0).length, 2);
  assert.notEqual(second, key);
  assert.deepEqual(report, immutable);
});
test('deletion removes the whole row, including multiple paragraphs, and single-cell edits cannot resurrect it', async () => {
  const {left} = await pair(), before = left.entries(), key = before.find(entry => entry.text === 'Стул').key;
  left.deleteRow(1,2);
  assert.equal(left.entries().length, before.length - 4);
  assert.equal(left.get(key), null);
  assert.throws(() => left.set(key, 'Исправлено'), /Отмените удаление/);
  assert.equal(left.get('row-right-900-1'), null);
  left.undo(); assert.deepEqual(left.entries(), before);
  assert.throws(() => left.set(key, null), /Удалить строку/);
});
test('copy all transfers edited rows across sides with target records, survives reload, and exports Word', async () => {
  const {left, right, models, sources} = await pair();
  const key = left.insertRow(1, 2); left.edit(key, 'Добавленная позиция'); left.deleteRow(1, 4);
  right.replaceAll(left.entries(), {rowPlan:left.rowPlan(), content:models.left.content});
  assert.equal(right.text(), left.text()); assert.equal(right.get(key), 'Добавленная позиция');
  assert.equal(right.structureChanged, true);
  const saved = right.snapshot(); right.reset(); right.restore(saved); assert.deepEqual(right.snapshot(), saved);
  const exported = await writeDocxVisual(sources.right, [], {sequence:right.entries(), rowPlan:right.rowPlan()});
  const result = await readDocxVisual({name:'edited.docx',data:Buffer.from(exported).toString('base64')});
  assert.deepEqual(result.blocks.map(block => block.text), right.entries().map(entry => entry.text));
  assert.equal(result.content.find(item => item.type === 'table').rows.length, 3);
});
test('restore accepts legacy text-only sessions but rejects forged keys, records, row identities and oversized history atomically', async () => {
  const {left, report} = await pair(), old = oldEditor.create(report, 'left');
  const key = old.entries()[0].key; old.edit(key,'Изменённое вступление');
  left.restore(old.snapshot()); assert.equal(left.get(key), old.get(key)); left.undo(); assert.equal(left.changed, false);
  left.insertRow(1, 2); const valid = left.snapshot();
  const changes = [
    value => {value.entries[0].record = 999;},
    value => {value.entries.find(entry => entry.record < 0).key = 'row-right-999-1';},
    value => {value.rowPlan.tables[0].rows[2].id = 'unknown';},
    value => {value.rowPlan.tables[0].rows[2].records[0] = -2;},
    value => {value.history.push(...Array(21).fill(value.history[0]));},
    value => {value.history[0].entries[0].record = -500;},
    value => {value.entries[0].text = 'x'.repeat(500001);},
    value => {value.rowPlan.tables.push(clone(value.rowPlan.tables[0]));},
  ];
  for (const change of changes) {
    const invalid = clone(valid); change(invalid);
    assert.throws(() => left.restore(invalid)); assert.deepEqual(left.snapshot(), valid);
  }
});
test('different source geometry refuses copy all before mutation, including paragraphs surrounding tables', async () => {
  const {left,right,models} = await pair(body('100'), body('200').replace(paragraph('После'), paragraph('После') + paragraph('Лишний абзац')));
  const before = right.snapshot();
  assert.throws(() => right.replaceAll(left.entries(), {rowPlan:left.rowPlan(), content:models.left.content}), /разная структура/);
  assert.deepEqual(right.snapshot(), before);
});
test('vertical merges stay protected while ordinary rows remain editable; cannot remove the final row', async () => {
  const source = tableSource(), report = await compareText({left:source,right:source});
  const draft = createDocxRowEditor(report,'left',await readDocxVisual(source));
  for (const index of [2,3]) {
    assert.throws(() => draft.insertRow(1,index), /вертикально/);
    assert.throws(() => draft.deleteRow(1,index), /вертикально/);
  }
  draft.insertRow(1,4);
  const solo = await pair(table([[cell('A'),cell('B'),cell('C')]]),table([[cell('A'),cell('B'),cell('C')]]));
  assert.throws(() => solo.left.deleteRow(1,1), /хотя бы одна/);
});
test('restored row IDs stay unique and row text counts toward history and document limits', async () => {
  const {left} = await pair();
  const key = left.insertRow(1,2); left.edit(key,'Данные'); const saved = left.snapshot(); left.restore(saved);
  const second = left.insertRow(1,3); assert.notEqual(key,second);
  const before = left.snapshot();
  assert.throws(() => left.edit(second,'X'.repeat(500001)), /500 000/);
  assert.deepEqual(left.snapshot(),before);
  for (let index = 0; index < 25; index++) { left.endEdit(); left.edit(second,String(index)); }
  assert.equal(left.snapshot().history.length,20);
});

test('row allocator survives deleted-row history eviction and restart without colliding with an opposite-side copy', async () => {
  const {left, right, models, report} = await pair();
  const oldKey = left.insertRow(1,2); left.edit(oldKey,'Старая строка');
  right.replaceAll(left.entries(), {rowPlan:left.rowPlan(), content:models.left.content});
  left.deleteRow(1,3);
  const textKey = left.entries()[0].key;
  for (let index = 0; index < 25; index++) { left.endEdit(); left.edit(textKey, `Вступление ${index}`); }
  const saved = left.snapshot();
  assert.equal(JSON.stringify(saved).includes(oldKey), false);
  const restored = createDocxRowEditor(report, 'left', models.left); restored.restore(saved);
  const newKey = restored.insertRow(1,2);
  assert.notEqual(newKey, oldKey); assert.equal(right.get(newKey), null); assert.equal(right.get(oldKey),'Старая строка');
  restored.undo(); restored.reset();
  const restart = createDocxRowEditor(report, 'left', models.left); restart.restore(restored.snapshot());
  assert.notEqual(restart.insertRow(1,2),newKey);
});

test('allocator validates persisted high watermark and advances when copied rows use its own side prefix', async () => {
  const {left,right,models,report} = await pair();
  const key = left.insertRow(1,2);
  right.replaceAll(left.entries(), {rowPlan:left.rowPlan(), content:models.left.content});
  const fresh = createDocxRowEditor(report,'left',models.left);
  fresh.replaceAll(right.entries(), {rowPlan:right.rowPlan(), content:models.right.content});
  const saved = fresh.snapshot(); assert.equal(saved.nextId,2);
  for (const nextId of [undefined,0,1,2.5,1000000001]) {
    const invalid = {...saved,nextId};
    assert.throws(() => fresh.restore(invalid)); assert.deepEqual(fresh.snapshot(),saved);
  }
  const restart = createDocxRowEditor(report,'left',models.left); restart.restore(saved);
  assert.notEqual(restart.insertRow(1,2),key);
});
