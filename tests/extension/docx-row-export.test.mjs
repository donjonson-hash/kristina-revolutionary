import test from 'node:test';
import assert from 'node:assert/strict';
import {readDocxVisual, projectDocxVisual, writeDocxVisual} from '../../extension/docx-visual.mjs';
import {normalizeDocxRowPlan} from '../../extension/docx-structure.mjs';
import {unzipDocument} from '../../extension/text-zip.mjs';
import {tableSource, table, cell, paragraph} from './table-fixture.mjs';
import {W, docx} from './text-fixture.mjs';
const input = bytes => ({name: 'rows.docx', data: Buffer.from(bytes).toString('base64')});
const plan = rows => ({version: 1, tables: [{table: 1, rows}]});
const inserted = (template = 4, records = [-1, -2], id = 'row-left-1') => ({id, template, records});
const sequenceFor = (model, rowPlan) => normalizeDocxRowPlan(model.content, rowPlan).records.map(record => ({record, key: 'key' + record, text: record > 0 ? model.blocks[record - 1].text : record === -1 ? 'Новая строка 😀' : ''}));
const visible = model => model.blocks.map(({text, style, runs, heading, list}) => ({text, style, runs: runs.flatMap(run => run.image ? [run] : [...run.text].map(text => ({text, style: run.style}))), heading, list}));
const geometry = model => model.content.filter(n => n.type === 'table').map(t => t.rows.map(row => row.cells.map(({column, colSpan, rowSpan, style}) => ({column, colSpan, rowSpan, style}))));

test('row insertion and deletion round-trip text, horizontal merges and all other package parts', async () => {
  const source = tableSource(), model = await readDocxVisual(source);
  const rowPlan = plan([{source: 2}, {source: 3}, inserted(), {source: 4}]);
  const sequence = sequenceFor(model, rowPlan); sequence[2].text = 'Исправленная цена\t200\nрублей';
  const projected = projectDocxVisual(model, sequence, {rowPlan});
  const exported = await writeDocxVisual(source, [], {rowPlan, sequence}), reloaded = await readDocxVisual(input(exported));
  assert.deepEqual(visible(projected), visible(reloaded));
  assert.deepEqual(geometry(projected), geometry(reloaded));
  assert.equal(projected.content[1].rows[2].cells[0].colSpan, 2);
  assert.equal(projected.content[1].rows[2].cells[0].content[0].record, -1);
  assert.equal(model.content[1].rows.length, 4);
  const before = await unzipDocument(Buffer.from(source.data, 'base64')), after = await unzipDocument(exported);
  for (const [name, bytes] of before) if (name !== 'word/document.xml') assert.deepEqual(after.get(name), bytes);
});

test('new rows retain first paragraph and run formatting without inheriting old text or extra paragraphs', async () => {
  const first = '<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="336699"/></w:rPr><w:t>Образец</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> хвост</w:t></w:r></w:p>';
  const source = tableSource('', {body: table([[cell([first, paragraph('Второй абзац')], '<w:gridSpan w:val="2"/>'), cell('Цена')]])});
  const model = await readDocxVisual(source), rowPlan = plan([inserted(1), {source: 1}]), sequence = sequenceFor(model, rowPlan);
  const projected = projectDocxVisual(model, sequence, {rowPlan}), reloaded = await readDocxVisual(input(await writeDocxVisual(source, [], {rowPlan, sequence})));
  assert.deepEqual(visible(projected), visible(reloaded));
  assert.equal(reloaded.content[0].rows[0].cells[0].content.length, 1);
  assert.deepEqual(reloaded.blocks[0].runs, [{text: 'Новая строка 😀', style: {fontWeight: 'bold', color: '#336699'}}]);
  assert.equal(reloaded.blocks[0].style.textAlign, 'right');
});

test('conditional header, footer and alternating row styles follow actual new row positions', async () => {
  const body = table([[cell('head'),cell(''),cell('')],[cell('body'),cell(''),cell('')],[cell('last'),cell(''),cell('')]])
    .replace('<w:tblPr>', '<w:tblPr><w:tblLook w:firstRow="1" w:lastRow="1" w:noHBand="0"/>');
  const styles = [['firstRow','AAAAAA'],['lastRow','BBBBBB'],['band1Horz','DDEEFF'],['band2Horz','FFDDEE']].map(([type,fill]) => `<w:tblStylePr w:type="${type}"><w:tcPr><w:shd w:fill="${fill}"/></w:tcPr></w:tblStylePr>`).join('');
  const source = tableSource('', {body, extraEntries: {'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="table" w:styleId="TableGrid">${styles}</w:style></w:styles>`}});
  const model = await readDocxVisual(source), rowPlan = plan([{source: 1}, inserted(2, [-1,-2,-3]), {source: 2}, {source: 3}, inserted(2,[-4,-5,-6],'row-right-2')]), sequence = sequenceFor(model,rowPlan);
  const projected = projectDocxVisual(model,sequence,{rowPlan}), reloaded = await readDocxVisual(input(await writeDocxVisual(source,[],{rowPlan,sequence})));
  assert.deepEqual(geometry(projected),geometry(reloaded));
  assert.deepEqual(projected.content[0].rows.map(r=>r.cells[0].style.backgroundColor), ['#AAAAAA','#DDEEFF','#FFDDEE','#DDEEFF','#BBBBBB']);
});

test('vertical merged rows and boundaries cannot be deleted, duplicated or split', async () => {
  const model = await readDocxVisual(tableSource());
  assert.deepEqual(model.content[1].rows.map(row => row.mutable), [true, false, false, true]);
  for (const rows of [
    [{source:1},{source:3},{source:4}],
    [{source:1},{source:2},{source:4}],
    [{source:1},{source:2},inserted(),{source:3},{source:4}],
    [{source:1},{source:2},{source:3},inserted(2,[-1,-2,-3]),{source:4}],
    [{source:1},{source:2},{source:3},inserted(3),{source:4}],
  ]) assert.throws(()=>normalizeDocxRowPlan(model.content,plan(rows)), /вертикальн/);
  for (const rows of [[inserted(),{source:1},{source:2},{source:3},{source:4}],[{source:1},{source:2},{source:3},inserted(),{source:4}]]) assert.doesNotThrow(()=>normalizeDocxRowPlan(model.content,plan(rows)));
});

test('strict row plans and incomplete or reordered paragraph sequences fail before export', async () => {
  const source=tableSource(),model=await readDocxVisual(source), original=[{source:1},{source:2},{source:3},{source:4}];
  for (const rowPlan of [
    plan([]), plan([original[1],original[0],...original.slice(2)]),
    plan([...original,{source:4}]), plan([...original,inserted(4,[-1,-1])]),
    plan([...original,inserted(4,[-1])]), plan([...original,inserted(4,[1,-2])]),
    plan([...original,inserted(),inserted(4,[-3,-4])]),
    plan([...original,{...inserted(),extra:true}]), {version:2,tables:[]}, {version:1,tables:[]},
  ]) {
    assert.throws(()=>normalizeDocxRowPlan(model.content,rowPlan), /план/);
    await assert.rejects(()=>writeDocxVisual(source,[],{rowPlan}), /план/);
  }
  const rowPlan=plan([...original,inserted()]),sequence=sequenceFor(model,rowPlan);
  for (const wrong of [sequence.slice(1),[sequence[1],sequence[0],...sequence.slice(2)], [...sequence,{record:-99,text:'bad'}]]) {
    assert.throws(()=>projectDocxVisual(model,wrong,{rowPlan}), /Добавление, удаление/);
    await assert.rejects(()=>writeDocxVisual(source,[],{sequence:wrong,rowPlan}), /Добавление, удаление/);
  }
  const tooMuch=sequence.map((item,i)=>({...item,text:i===0?'x'.repeat(500001):''}));
  assert.throws(()=>projectDocxVisual(model,tooMuch,{rowPlan}), /объёму/);
  await assert.rejects(()=>writeDocxVisual(source,[],{sequence:tooMuch,rowPlan}), /объёму/);
});

test('deleting a whole row intentionally removes its photo, insertion never duplicates it', async () => {
  const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships', A='http://schemas.openxmlformats.org/drawingml/2006/main', WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', PIC='http://schemas.openxmlformats.org/drawingml/2006/picture';
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nkXcAAAAASUVORK5CYII=','base64'));
  const picture=`<w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Photo"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Photo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="photo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const body=table([[cell([`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Фото</w:t>${picture}</w:r></w:p>`],'<w:gridSpan w:val="2"/>'),cell('100')],[cell('Итого','<w:gridSpan w:val="2"/>'),cell('100')]]);
  const source=input(docx([], {xml:`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:pic="${PIC}"><w:body>${body}</w:body></w:document>`,extraEntries:{'word/media/photo.png':png,'word/_rels/document.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="photo" Type="${R}/image" Target="media/photo.png"/></Relationships>`}}));
  const model=await readDocxVisual(source);
  for (const rows of [[inserted(1),{source:2}],[{source:1},inserted(1),{source:2}]]) {
    const rowPlan=plan(rows),sequence=sequenceFor(model,rowPlan),projected=projectDocxVisual(model,sequence,{rowPlan});
    const bytes=await writeDocxVisual(source,[],{sequence,rowPlan}), reloaded=await readDocxVisual(input(bytes));
    assert.deepEqual(visible(projected),visible(reloaded));
    const pictures=reloaded.blocks.flatMap(b=>b.runs).filter(r=>r.image);
    assert.equal(pictures.length,rows.some(r=>r.source===1)?1:0);
    assert.deepEqual((await unzipDocument(bytes)).get('word/media/photo.png'),png);
  }
});

test('row and paragraph limits refuse excessive expanded plans',async()=>{
  const model=await readDocxVisual(tableSource('',{body:table([[cell('1'),cell('2'),cell('3')]])}));
  const rows=[{source:1},...Array.from({length:1000},(_,i)=>inserted(1,[-i*3-1,-i*3-2,-i*3-3],'row-'+i))];
  assert.throws(()=>normalizeDocxRowPlan(model.content,plan(rows)),/план/);
  assert.throws(()=>normalizeDocxRowPlan(model.content,plan(rows.slice(0,668))),/2000/);
});

test('1000-row limit applies to each table while the 2000-paragraph limit remains global', async () => {
  const row=[cell('', '<w:gridSpan w:val="3"/>')];
  const source=tableSource('',{body:table(Array(501).fill(row))+table(Array(500).fill(row))});
  const model=await readDocxVisual(source);
  const rowPlan={version:1,tables:[{table:1,rows:Array.from({length:501},(_,i)=>({source:i+1}))},{table:2,rows:Array.from({length:500},(_,i)=>({source:i+1}))}]};
  const normalized=normalizeDocxRowPlan(model.content,rowPlan);
  assert.equal(normalized.records.length,1001);
  const sequence=normalized.records.map(record=>({record,text:''}));
  assert.equal(projectDocxVisual(model,sequence,{rowPlan}).blocks.length,1001);
  const reloaded=await readDocxVisual(input(await writeDocxVisual(source,[],{sequence,rowPlan})));
  assert.deepEqual(reloaded.content.map(t=>t.rows.length),[501,500]);
});
