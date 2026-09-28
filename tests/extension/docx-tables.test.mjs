import test from 'node:test';
import assert from 'node:assert/strict';
import {readTextSource} from '../../extension/text-source.mjs';
import {readDocxVisual, projectDocxVisual, writeDocxVisual} from '../../extension/docx-visual.mjs';
import {compareText} from '../../extension/text-engine.mjs';
import {unzipDocument} from '../../extension/text-zip.mjs';
import editor from '../../static/reconciliation/text-editor.js';
import {tableSource, table, cell, paragraph} from './table-fixture.mjs';
import {W} from './text-fixture.mjs';
const raw = source => Uint8Array.from(Buffer.from(source.data, 'base64'));
const input = bytes => ({name: 'edited.docx', data: Buffer.from(bytes).toString('base64')});
test('Word table extraction and preview share records through multiple paragraphs and both merge directions', async () => {
  const source = tableSource(), text = await readTextSource(source), model = await readDocxVisual(source);
  assert.deepEqual(text.blocks.map(b => b.text), ['Предложение','Услуги','Группа','Товар','Цена','Печать','Доставка','100','Итого','100','Конец']);
  assert.deepEqual(model.blocks.map(b => b.text), text.blocks.map(b => b.text));
  assert.deepEqual(text.blocks[6].table, {table: 1, row: 3, column: 2, paragraph: 2});
  assert.match(text.blocks[6].location, /Таблица 1, строка 3, столбец 2, абзац 2/);
  const grid = model.content[1];
  assert.equal(grid.rows[0].cells[0].colSpan, 3); assert.equal(grid.rows[1].cells[0].rowSpan, 2);
  assert.equal(grid.rows[2].cells.length, 2); assert.equal(grid.rows[2].cells[0].column, 2);
  assert.equal(grid.rows[0].cells[0].style.backgroundColor, '#DDEEFF');
  assert.equal(grid.rows[1].cells[0].style.borderLeft, '1pt solid #336699');
});
test('native table export edits in place, retains cell geometry and every other package part', async () => {
  const source = tableSource(), before = await unzipDocument(raw(source)), model = await readDocxVisual(source);
  const sequence = model.blocks.map(b => ({record: b.record, text: b.record === 8 ? '200\tрублей\nс НДС 😀' : b.record === 7 ? '' : b.text}));
  const exported = await writeDocxVisual(source, [], {sequence}), reloaded = await readDocxVisual(input(exported)), parts = await unzipDocument(exported);
  assert.deepEqual(reloaded.blocks.map(b => b.text), sequence.map(b => b.text));
  assert.deepEqual(reloaded.content, model.content);
  assert.deepEqual(projectDocxVisual(model, sequence).blocks.map(b => b.runs.map(r => r.text).join('')), reloaded.blocks.map(b => b.runs.map(r => r.text).join('')));
  for (const [name, bytes] of before) if (name !== 'word/document.xml') assert.deepEqual(parts.get(name), bytes, name);
  const geometry = bytes => new TextDecoder().decode(bytes).replaceAll('<w:tcPr></w:tcPr>', '<w:tcPr/>').replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\s*\/>/g, '<paragraph/>');
  assert.equal(geometry(parts.get('word/document.xml')), geometry(before.get('word/document.xml')));
});
test('repeated or swapped table values pair by cell, never by a coincidental matching number', async () => {
  const left = tableSource('100'), right = tableSource('200');
  const report = await compareText({left,right});
  assert.equal(report.changed.length, 2); assert.equal(report.only_left.length + report.only_right.length, 0);
  for (const pair of report.changed) assert.deepEqual(pair.left.table, pair.right.table);
  const swapped = await compareText({left: tableSource('', {body: table([[cell('A'),cell('B'),cell('A')]])}), right: tableSource('', {body: table([[cell('B'),cell('A'),cell('A')]])})});
  assert.equal(swapped.changed.length, 2); assert.equal(swapped.moved, undefined);
  assert.equal(swapped.changed[0].left.table.column, 1); assert.equal(swapped.changed[0].right.table.column, 1);
  const target = editor.create(report, 'right'), origin = editor.create(report, 'left');
  target.replaceAll(origin.entries()); assert.equal(target.text(), origin.text());
  const sequence = target.entries().map(e => ({record: e.record, text: e.text}));
  assert.deepEqual((await readTextSource(input(await writeDocxVisual(right, [], {sequence})))).blocks.map(b => b.text), (await readTextSource(left)).blocks.map(b => b.text));
});
test('table structural changes refuse before mutating the draft or producing a flattened DOCX', async () => {
  const source = tableSource(), model = await readDocxVisual(source), sequence = model.blocks.map(b => ({record:b.record,text:b.text}));
  for (const invalid of [sequence.slice(1), [...sequence,{text:'new'}], [sequence[1],sequence[0],...sequence.slice(2)]]) {
    assert.throws(() => projectDocxVisual(model, invalid), /Добавление, удаление/);
    await assert.rejects(() => writeDocxVisual(source, [], {sequence: invalid}), /Добавление, удаление/);
  }
  const report = await compareText({left: source, right: tableSource('', {body: paragraph('Другой документ')})});
  const target = editor.create(report, 'left'), before = target.snapshot();
  assert.throws(() => target.replaceAll(editor.create(report, 'right').entries()), /Добавление, удаление/);
  assert.deepEqual(target.snapshot(), before);
});
test('lists inside and outside tables share Word numbering in document order', async () => {
  const num = '<w:numPr><w:numId w:val="1"/></w:numPr>';
  const source = tableSource('', {body: paragraph('До', num) + table([[cell([paragraph('Один', num)]),cell([paragraph('Два', num)]),cell('Обычно')]]) + paragraph('После', num), extraEntries: {
    'word/numbering.xml': `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  }});
  const model = await readDocxVisual(source);
  assert.deepEqual(model.blocks.map(b => b.list?.label || null), ['1.','2.','3.',null,'4.']);
  const exported = await readDocxVisual(input(await writeDocxVisual(source,[{record:2,text:'Исправлено'}])));
  assert.deepEqual(exported.blocks.map(b => b.list), model.blocks.map(b => b.list));
});
test('unsupported or inconsistent tables reject clearly instead of losing visible content', async () => {
  const examples = [
    table([[cell([table([[cell('nested'),cell(''),cell('')]])]),cell(''),cell('')]]),
    table([[cell('hidden','<w:vMerge/>'),cell(''),cell('')]]),
    table([[cell(''),cell('')]]),
    table([[cell('','<w:gridSpan w:val="0"/>'),cell(''),cell('')]]),
    table([[cell('start','<w:vMerge w:val="restart"/>'),cell(''),cell('')],[cell('hidden','<w:vMerge/>'),cell(''),cell('')]]),
    table([[cell(''),cell(''),cell('')]]).replace('<w:tblPr>', '<w:tblPr><w:tblpPr/>'),
  ];
  for (const body of examples) await assert.rejects(() => readTextSource(tableSource('', {body})), /DOCX:/);
});

test('table edit bounds remain active when PDF reflow wraps the DOCX source block', async () => {
  const source = tableSource(), report = await compareText({left: source, right: source});
  for (const pair of report.matched) for (const side of ['left','right']) {
    const block = pair[side]; pair[side] = {record: block.record, text: block.text, location: block.location, source_blocks: [block]};
  }
  const draft = editor.create(report, 'right'), before = draft.snapshot();
  assert.throws(() => draft.replaceAll(draft.entries().slice(1)), /Добавление, удаление/);
  assert.deepEqual(draft.snapshot(), before);
});

test('header rows are excluded from alternating table bands', async () => {
  const body = table([[cell('header'),cell(''),cell('')],[cell('body'),cell(''),cell('')]])
    .replace('<w:tblPr>', '<w:tblPr><w:tblLook w:firstRow="1" w:noHBand="0"/>');
  const source = tableSource('', {body, extraEntries: {
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="table" w:styleId="TableGrid"><w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:fill="DDEEFF"/></w:tcPr></w:tblStylePr></w:style></w:styles>`,
  }});
  const rows = (await readDocxVisual(source)).content[0].rows;
  assert.equal(rows[0].cells[0].style.backgroundColor, undefined);
  assert.equal(rows[1].cells[0].style.backgroundColor, '#DDEEFF');
});
