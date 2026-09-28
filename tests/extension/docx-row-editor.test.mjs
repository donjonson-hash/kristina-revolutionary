import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocxRowEditor} from '../../extension/docx-row-editor.mjs';
import {readDocxVisual, writeDocxVisual} from '../../extension/docx-visual.mjs';
import {compareText} from '../../extension/text-engine.mjs';
import oldEditor from '../../static/reconciliation/text-editor.js';
import {tableSource, table, cell, paragraph} from './table-fixture.mjs';
import {unzipDocument} from '../../extension/text-zip.mjs';
import {W} from './text-fixture.mjs';
const body = value => paragraph('До') + table([[cell('Наименование'), cell('Штук'), cell('Цена')], [cell([paragraph('Стул'), paragraph('Синий')]), cell('2'), cell(value)], [cell('Доставка', '<w:gridSpan w:val="2"/>'), cell('0')]]) + paragraph('После');
async function pair(leftBody = body('100'), rightBody = body('200')) {
  const left = tableSource('', {body:leftBody}), right = tableSource('', {body:rightBody});
  return sourcePair(left, right);
}
async function sourcePair(left, right) {
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

test('single-row copy isolates both drafts, remaps records, preserves horizontal merges and exports the target', async () => {
  const {left,right,sources} = await pair();
  const own = right.insertRow(1,2); right.edit(own,'Только B');
  const key = left.insertRow(1,3); left.edit(key,'Новая доставка'); left.edit(key.replace(/-1$/, '-2'),'350');
  const unrelated = left.insertRow(1,1); left.edit(unrelated,'Не переносить');
  left.edit(left.entries()[0].key,'Правка только A');
  const sourceBefore = left.snapshot(), targetBefore = right.snapshot();
  assert.equal(right.copyRowFrom(left,key),key);
  assert.deepEqual(left.snapshot(),sourceBefore);
  assert.equal(right.get(own),'Только B'); assert.equal(right.get(unrelated),null);
  assert.equal(right.entries()[0].text,'До'); assert.equal(right.get(key),'Новая доставка');
  const copied = right.rowPlan().tables[0].rows.find(row => row.id === 'row-left-1');
  assert.deepEqual(copied.records,[-4,-5]);
  assert.equal(copied.template,3);
  const exported = await writeDocxVisual(sources.right,[],{sequence:right.entries(),rowPlan:right.rowPlan()});
  const result = await readDocxVisual({name:'row-copy.docx',data:Buffer.from(exported).toString('base64')});
  const rows = result.content.find(item => item.type === 'table').rows;
  assert.equal(rows.length,5); assert.equal(rows.at(-1).cells[0].colSpan,2);
  assert.deepEqual(result.blocks.map(item => item.text),right.entries().map(item => item.text));
  right.undo(); assert.deepEqual(right.entries(),targetBefore.entries); assert.deepEqual(right.rowPlan(),targetBefore.rowPlan);
});

test('copying a present row updates only its cells in one undo, is idempotent and survives restoration and return transfer', async () => {
  const {left,right,models,report} = await pair();
  const key = right.insertRow(1,2); right.edit(key,'Из B'); left.copyRowFrom(right,key);
  const saved = left.snapshot(), revision = left.revision;
  left.copyRowFrom(right,key); assert.deepEqual(left.snapshot(),saved); assert.equal(left.revision,revision);
  right.edit(key,'Обновление'); right.edit(key.replace(/-1$/,'-2'),'12');
  const before = left.snapshot(); left.copyRowFrom(right,key);
  assert.equal(left.get(key),'Обновление'); assert.equal(left.rowPlan().tables[0].rows.length,4);
  left.undo(); assert.deepEqual(left.entries(),before.entries); assert.deepEqual(left.rowPlan(),before.rowPlan);
  const restored = createDocxRowEditor(report,'left',models.left); restored.restore(left.snapshot());
  restored.edit(key,'Вернуть в B'); right.copyRowFrom(restored,key);
  assert.equal(right.get(key),'Вернуть в B'); assert.equal(right.rowPlan().tables[0].rows.length,4);
  right.deleteRow(1,3); right.copyRowFrom(restored,key);
  assert.equal(right.rowPlan().tables[0].rows.length,4);
  assert.notEqual(right.insertRow(1,3),key);
});

test('copy keeps source row order in either transfer order and keeps target-only rows', async () => {
  for (const reverse of [false,true]) {
    const {left,right} = await pair();
    const first = left.insertRow(1,2), second = left.insertRow(1,3);
    const independent = right.insertRow(1,2); right.edit(independent,'Независимая');
    for (const key of reverse ? [second,first] : [first,second]) right.copyRowFrom(left,key);
    const ids = right.rowPlan().tables[0].rows.map(row => row.id).filter(Boolean);
    assert.deepEqual(ids,['row-right-1','row-left-1','row-left-2']);
    assert.equal(right.get(independent),'Независимая');
  }
});

test('copy skips deleted anchors without resurrecting them and refuses when none survive', async () => {
  const {left,right} = await pair();
  const key = left.insertRow(1,2);
  right.deleteRow(1,2); right.copyRowFrom(left,key);
  assert.deepEqual(right.rowPlan().tables[0].rows.map(row => row.source || row.id),[1,'row-left-1',3]);
  right.undo(); right.deleteRow(1,2); right.copyRowFrom(left,key);
  assert.deepEqual(right.rowPlan().tables[0].rows.map(row => row.source || row.id),[1,'row-left-1']);
  const separate = right.insertRow(1,1); right.deleteRow(1,1); right.deleteRow(1,2);
  assert.equal(right.get(separate),'');
  const before = right.snapshot();
  assert.throws(() => right.copyRowFrom(left,key),/соседние исходные строки удалены/);
  assert.deepEqual(right.snapshot(),before);
});

test('copy rejects incompatible documents, fake editors and conflicting restored row identity atomically', async () => {
  const incompatible = await pair(body('100'),body('200') + paragraph('Лишний абзац'));
  const wrongKey = incompatible.left.insertRow(1,2), initial = incompatible.right.snapshot();
  assert.throws(() => incompatible.right.copyRowFrom(incompatible.left,wrongKey),/разная структура/);
  assert.deepEqual(incompatible.right.snapshot(),initial);
  const {left,right} = await pair(), key = left.insertRow(1,2);
  assert.throws(() => right.copyRowFrom({entries:left.entries,rowPlan:left.rowPlan},key),/два документа Word/);
  assert.throws(() => right.copyRowFrom(left,left.entries()[0].key),/добавленной строки/);
  right.copyRowFrom(left,key);
  const conflict = right.snapshot(); conflict.rowPlan.tables[0].rows[2].template = 1;
  right.restore(conflict); const before = right.snapshot();
  assert.throws(() => right.copyRowFrom(left,key),/другая структура/);
  assert.deepEqual(right.snapshot(),before);
});

test('copy rejects crossed shared row anchors atomically after a restored order change', async () => {
  const {left,right} = await pair();
  const first = left.insertRow(1,2), middle = left.insertRow(1,3), last = left.insertRow(1,4);
  right.copyRowFrom(left,first); right.copyRowFrom(left,last);
  const saved = right.snapshot(), rows = saved.rowPlan.tables[0].rows;
  [rows[2],rows[3]] = [rows[3],rows[2]];
  const byRecord = new Map(saved.entries.map(entry => [entry.record,entry]));
  const firstEntries = rows[2].records.map(record => byRecord.get(record)), lastEntries = rows[3].records.map(record => byRecord.get(record));
  const start = saved.entries.findIndex(entry => entry.record < 0); saved.entries.splice(start,6,...firstEntries,...lastEntries);
  right.restore(saved); const before = right.snapshot();
  assert.throws(() => right.copyRowFrom(left,middle),/Порядок соседних строк/);
  assert.deepEqual(right.snapshot(),before);
});

test('single-row copy enforces character, row and block limits without partial mutations', async () => {
  const {left,right} = await pair();
  const key = left.insertRow(1,2); left.edit(key,'X'.repeat(300000));
  right.edit(right.entries()[0].key,'Y'.repeat(250000)); const large = right.snapshot();
  assert.throws(() => right.copyRowFrom(left,key),/500 000/); assert.deepEqual(right.snapshot(),large);
  for (const [columns,count,expected] of [[1,999,/1000 строк/],[3,665,/2000 текстовых блоков/]]) {
    const contents = table([Array.from({length:columns},(_,index) => cell(String(index), columns === 1 ? '<w:gridSpan w:val="3"/>' : ''))]);
    const pairOfEditors = await pair(contents,contents), source = pairOfEditors.left, target = pairOfEditors.right;
    const added = source.insertRow(1,1), state = target.snapshot();
    let record = -1;
    for (let index = 1; index <= count; index++) {
      const id = `row-right-${index}`, records = Array.from({length:columns},() => record--);
      state.rowPlan.tables[0].rows.push({id,template:1,records});
      state.entries.push(...records.map((record,index) => ({key:`${id}-${index + 1}`,record,text:''})));
    }
    state.nextId = count + 1; target.restore(state); const before = target.snapshot();
    assert.throws(() => target.copyRowFrom(source,added),expected); assert.deepEqual(target.snapshot(),before);
  }
});

test('existing-row text copy replaces all paragraphs in one undo, keeps target identities and survives restart in either direction', async () => {
  const {left,right,report,models} = await pair();
  for (const [source,target,side] of [[left,right,'right'],[right,left,'left']]) {
    const selected = source.entries().find(entry => entry.text === 'Стул').key;
    const colour = source.entries().find(entry => entry.text === 'Синий').key;
    source.edit(colour,'Красный'); source.edit(selected,'Новый стул');
    target.edit(target.entries()[0].key,'Своя правка вступления');
    const before = target.snapshot(), sourceBefore = source.snapshot(), revision = target.revision;
    assert.deepEqual(target.rowTextCopyState(source,selected),{available:true,equal:false,reason:''});
    assert.deepEqual(target.snapshot(),before);
    target.replaceRowTextFrom(source,selected);
    assert.equal(target.get(colour),'Красный'); assert.equal(target.get(selected),'Новый стул');
    assert.equal(target.entries()[0].text,'Своя правка вступления');
    assert.deepEqual(target.entries().map(({record,key}) => ({record,key})),before.entries.map(({record,key}) => ({record,key})));
    assert.deepEqual(target.rowPlan(),before.rowPlan); assert.deepEqual(source.snapshot(),sourceBefore);
    assert.equal(target.revision,revision + 1); assert.equal(target.snapshot().history.length,before.history.length + 1);
    const saved = target.snapshot(); target.replaceRowTextFrom(source,selected);
    assert.deepEqual(target.snapshot(),saved); assert.equal(target.revision,revision + 1);
    assert.equal(target.rowTextCopyState(source,selected).equal,true);
    const restored = createDocxRowEditor(report,side,models[side]); restored.restore(saved);
    restored.undo(); assert.deepEqual(restored.entries(),before.entries); assert.deepEqual(restored.rowPlan(),before.rowPlan);
    source.reset(); target.reset();
  }
});

test('existing row identity survives unrelated insertions and deletions and repeated labels without copying the neighboring row', async () => {
  const contents = table([[cell('Название'),cell('Кол-во'),cell('Цена')], [cell('Повтор'),cell('2'),cell('100')], [cell('Повтор'),cell('2'),cell('100')], [cell('Итог','<w:gridSpan w:val="2"/>'),cell('200')]]);
  const {left,right} = await pair(contents,contents);
  const original = left.entries(), key = original[7].key;
  left.edit(key,'99');
  const a = left.insertRow(1,1); left.edit(a,'Только A');
  const b = right.insertRow(1,3); right.edit(b,'Только B');
  right.deleteRow(1,2);
  const before = right.snapshot();
  right.replaceRowTextFrom(left,key);
  assert.equal(right.get(key),'99'); assert.equal(right.get(b),'Только B'); assert.equal(right.get(a),null);
  assert.equal(right.get(original[3].key),null);
  assert.deepEqual(right.rowPlan(),before.rowPlan);
  assert.deepEqual(right.entries().filter(entry => entry.key !== key),before.entries.filter(entry => entry.key !== key));
});

test('existing-row action and readonly state consistently reject missing, added, incompatible and vertically merged rows', async () => {
  const cases = [];
  const absentSource = await pair(), sourceKey = absentSource.left.entries().find(entry => entry.text === 'Стул').key;
  absentSource.left.deleteRow(1,2); cases.push([absentSource,sourceKey,/Отмените удаление/]);
  const absentTarget = await pair(), targetKey = absentTarget.left.entries().find(entry => entry.text === 'Стул').key;
  absentTarget.right.deleteRow(1,2); cases.push([absentTarget,targetKey,/Отмените удаление/]);
  const added = await pair(); cases.push([added,added.left.insertRow(1,2),/исходной строки/]);
  const wrong = await pair(body('100'),body('200') + paragraph('Другая структура')); cases.push([wrong,wrong.left.entries()[1].key,/разная структура/]);
  const vertical = await sourcePair(tableSource(),tableSource());
  cases.push([vertical,vertical.left.entries().find(entry => entry.text === 'Группа').key,/вертикально/]);
  cases.push([vertical,vertical.left.entries().find(entry => entry.text === 'Печать').key,/вертикально/]);
  const outside = await pair(); cases.push([outside,outside.left.entries()[0].key,/исходной строки/]);
  for (const [{left,right},key,pattern] of cases) {
    const sourceBefore = left.snapshot(), before = right.snapshot();
    const state = right.rowTextCopyState(left,key);
    assert.equal(state.available,false); assert.equal(state.equal,false); assert.match(state.reason,pattern);
    assert.throws(() => right.replaceRowTextFrom(left,key),error => error.message === state.reason);
    assert.deepEqual(right.snapshot(),before); assert.deepEqual(left.snapshot(),sourceBefore);
  }
  assert.equal(outside.right.rowTextCopyState({},'x').available,false);
  assert.throws(() => outside.right.replaceRowTextFrom({},'x'),/два документа Word/);
});

test('existing-row replacement enforces total character limit before changing text or history', async () => {
  const {left,right} = await pair();
  const key = left.entries().find(entry => entry.text === 'Стул').key;
  left.edit(key,'X'.repeat(300000)); right.edit(right.entries()[0].key,'Y'.repeat(250000));
  const before = right.snapshot(), sourceBefore = left.snapshot();
  const state = right.rowTextCopyState(left,key);
  assert.equal(state.available,false); assert.match(state.reason,/500 000/);
  assert.throws(() => right.replaceRowTextFrom(left,key),/500 000/);
  assert.deepEqual(right.snapshot(),before); assert.deepEqual(left.snapshot(),sourceBefore);
});

test('existing horizontally merged row exports new text while retaining target lists, formatting, picture and other package parts', async () => {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const picture = `<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}"><wp:inline><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData><a:blip r:embed="photo"/></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const numbered = value => paragraph(value,'<w:numPr><w:numId w:val="1"/></w:numPr>');
  const contents = value => table([[cell([numbered('Комплект'),numbered(value)],'<w:gridSpan w:val="2"/>'),cell([`<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="336699"/></w:rPr><w:t>${value}</w:t>${picture}</w:r></w:p>`])], [cell('Итого','<w:gridSpan w:val="2"/>'),cell('100')]]);
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nkXcAAAAASUVORK5CYII=','base64'));
  const extraEntries = {
    'word/media/photo.png':png,
    'word/numbering.xml':`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    'word/_rels/document.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="photo" Type="${R}/image" Target="media/photo.png"/></Relationships>`,
  };
  const {left,right,models,sources} = await sourcePair(tableSource('',{body:contents('110'),extraEntries}),tableSource('',{body:contents('100'),extraEntries}));
  const key = left.entries()[0].key, plan = right.rowPlan();
  right.replaceRowTextFrom(left,key);
  const bytes = await writeDocxVisual(sources.right,[],{sequence:right.entries(),rowPlan:right.rowPlan()});
  const result = await readDocxVisual({name:'row-text.docx',data:Buffer.from(bytes).toString('base64')});
  assert.deepEqual(result.blocks.map(block => block.text),['Комплект','110','110','Итого','100']);
  assert.deepEqual(right.rowPlan(),plan);
  assert.equal(result.content[0].rows[0].cells[0].colSpan,2);
  assert.deepEqual(result.blocks.map(block => block.list),models.right.blocks.map(block => block.list));
  assert.equal(result.blocks[2].style.textAlign,'right');
  assert.deepEqual(result.blocks[2].runs.find(run => run.text)?.style,{fontWeight:'bold',color:'#336699'});
  assert.deepEqual(result.blocks.flatMap(block => block.runs).filter(run => run.image),models.right.blocks.flatMap(block => block.runs).filter(run => run.image));
  const before = await unzipDocument(Buffer.from(sources.right.data,'base64')), after = await unzipDocument(bytes);
  for (const [name,content] of before) if (name !== 'word/document.xml') assert.deepEqual(after.get(name),content);
});
