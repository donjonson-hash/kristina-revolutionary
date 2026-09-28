import test from 'node:test';
import assert from 'node:assert/strict';
import {readDocxVisual,writeDocxVisual,projectDocxVisual} from '../../extension/docx-visual.mjs';
import {readTextSource} from '../../extension/text-source.mjs';
import {unzipDocument} from '../../extension/text-zip.mjs';
import {docx,W} from './text-fixture.mjs';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A='http://schemas.openxmlformats.org/drawingml/2006/main';
const WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PIC='http://schemas.openxmlformats.org/drawingml/2006/picture';
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nkXcAAAAASUVORK5CYII=','base64'));
const input=raw=>({name:'example.docx',data:Buffer.from(raw).toString('base64')});
const drawing=`<w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Photo" descr="Фотография"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Photo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="photo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
function rich({picture=drawing,relsExtra='',image=png}={}) {
  return docx([],{
    xml:`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:pic="${PIC}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Заголовок</w:t></w:r></w:p><w:p><w:r>${picture}</w:r></w:p><w:p><w:r><w:t>Цена </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="336699"/></w:rPr><w:t>100</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> рублей</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`,
    extraEntries:{'word/media/photo.png':image,'word/styles.xml':`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`,'word/_rels/document.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="photo" Type="${R}/image" Target="media/photo.png" ${relsExtra}/></Relationships>`},
  });
}
test('DOCX visual model retains heading, inline photo, run styling and the same comparison records',async()=>{
  const source=input(rich()),view=await readDocxVisual(source),text=await readTextSource(source);
  assert.deepEqual(view.blocks.map(b=>({record:b.record,text:b.text})),text.blocks.map(({record,text})=>({record,text})));
  assert.equal(view.blocks[0].heading,1);assert.equal(view.blocks[0].style.fontSize,'18pt');assert.equal(view.blocks[0].style.fontWeight,'bold');
  assert.equal(view.blocks[1].runs[0].image.src,`data:image/png;base64,${Buffer.from(png).toString('base64')}`);assert.equal(view.blocks[1].runs[0].image.width,100);
  assert.equal(view.blocks[2].runs[1].style.color,'#336699');assert.equal(view.blocks[2].runs[1].style.fontWeight,'bold');assert.equal(view.page.marginLeft,72);
});
test('DOCX edited export reimports exact text while retaining photo bytes, styles, links and unaffected run emphasis',async()=>{
  const source=input(rich()),before=await unzipDocument(rich());
  const raw=await writeDocxVisual(source,[{record:3,text:'Цена 200 рублей'},{record:1,text:'Заголовок <A & B>'}]);
  const updated=await readDocxVisual(input(raw)),parts=await unzipDocument(raw);
  assert.equal(updated.blocks[2].text,'Цена 200 рублей');assert.equal(updated.blocks[0].text,'Заголовок <A & B>');
  assert.equal(updated.blocks[0].heading,1);assert.equal(updated.blocks[2].runs.find(r=>r.text==='200').style.fontWeight,'bold');
  assert.equal(updated.blocks[2].runs.at(-1).style.fontStyle,'italic');
  for(const name of ['word/media/photo.png','word/styles.xml','word/_rels/document.xml.rels'])assert.deepEqual(parts.get(name),before.get(name));
});
test('DOCX sequence supports insertion, reorder and deletion, retaining photos from deleted paragraphs',async()=>{
  const raw=await writeDocxVisual(input(rich()),[],{sequence:[{record:3,text:'Первый\tабзац\nстрока'},{text:'Вставка <script>alert(1)</script>'},{record:1,text:'Последний'}]});
  const view=await readDocxVisual(input(raw));
  assert.deepEqual(view.blocks.filter(b=>b.text).map(b=>b.text),['Первый\tабзац\nстрока','Вставка <script>alert(1)</script>','Последний']);
  assert.equal(view.blocks.flatMap(b=>b.runs).filter(r=>r.image).length,1);
  assert.equal(view.blocks.at(-1).heading,1);
});
test('DOCX manual edits preserve emoji boundaries, blank paragraphs and tabs',async()=>{
  const source=input(docx(['A😀tail','','end']));
  const raw=await writeDocxVisual(source,[{record:1,text:'A😁tail'},{record:2,text:'\tnew\nline'},{record:3,text:''}]);
  assert.deepEqual((await readTextSource(input(raw))).blocks.map(b=>b.text),['A😁tail','\tnew\nline','']);
});
test('DOCX pictures cannot fetch remote resources or hide text, transforms or oversized decoded images',async()=>{
  await assert.rejects(()=>readDocxVisual(input(rich({relsExtra:'TargetMode="External"'}))),/внешние связи/);
  await assert.rejects(()=>readDocxVisual(input(rich({picture:drawing.replace('<a:avLst/>','<a:avLst/><a:t>hidden text</a:t>')}))),/рисунок не поддерживается/);
  await assert.rejects(()=>readDocxVisual(input(rich({picture:drawing.replace('<a:xfrm>','<a:xfrm rot="90">')}))),/рисунок не поддерживается/);
  const large=png.slice();new DataView(large.buffer).setUint32(16,100000);new DataView(large.buffer).setUint32(20,100000);
  await assert.rejects(()=>readDocxVisual(input(rich({image:large}))),/25 млн/);
});
test('DOCX export rejects duplicate records and invalid XML characters before making a file',async()=>{
  const source=input(docx(['one','two']));
  await assert.rejects(()=>writeDocxVisual(source,[],{sequence:[{record:1,text:'a'},{record:1,text:'b'}]}),/повторный/);
  await assert.rejects(()=>writeDocxVisual(source,[{record:1,text:'invalid\0text'}]),/недопустимые/);
  await assert.rejects(()=>writeDocxVisual(source,[{record:1,text:'invalid\uD800text'}]),/недопустимые/);
});

test('DOCX projected preview and exported revision keep the same text, formatting and deleted-paragraph images',async()=>{
  const source=input(rich()),model=await readDocxVisual(source);
  const sequence=[{key:'third',record:3,text:'Цена 200 рублей'},{key:'new',text:'Новый текст'},{key:'first',record:1,text:'Заголовок <новый>'}];
  const projected=projectDocxVisual(model,sequence),exported=await readDocxVisual(input(await writeDocxVisual(source,[],{sequence})));
  const comparable=view=>view.blocks.map(({text,heading,style,runs})=>({text,heading,style,runs}));
  assert.deepEqual(comparable(projected),comparable(exported));
  assert.equal(projected.blocks[0].retainedMedia,true);
  assert.equal(projected.blocks[1].key,'third');assert.equal(projected.blocks[1].sourceRecord,3);
  assert.equal(model.blocks[2].text,'Цена 100 рублей');
});

function lists({photo=false}={}) {
  const paragraph=(text,numId,level=0,extra='')=>`<w:p>${numId?`<w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`:''}<w:r><w:t>${text}</w:t>${extra}</w:r></w:p>`;
  return docx([],{
    xml:`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:pic="${PIC}"><w:body>${[
      paragraph('Условия'),paragraph('Первый',7),paragraph('Подпункт один',7,1,photo?drawing:''),paragraph('Подпункт два',7,1),paragraph('Пояснение'),paragraph('Второй',7),paragraph('Новый подпункт',7,1),paragraph('С пятого',8),paragraph('Шестой',8),paragraph('Маркер',9),
      '<w:p><w:pPr><w:pStyle w:val="InheritedList"/></w:pPr><w:r><w:t>Из стиля</w:t></w:r></w:p>',
    ].join('')}</w:body></w:document>`,
    extraEntries:{
      'word/numbering.xml':`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="right"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/><w:suff w:val="space"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="●"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:i/><w:sz w:val="24"/><w:color w:val="336699"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num><w:num w:numId="9"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
      'word/styles.xml':`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="BaseList"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="InheritedList"><w:basedOn w:val="BaseList"/></w:style></w:styles>`,
      'word/_rels/document.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="numbering" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/>${photo?`<Relationship Id="photo" Type="${R}/image" Target="media/photo.png"/>`:''}</Relationships>`,
      ...(photo?{'word/media/photo.png':png}:{}),
    },
  });
}
const listLabels=view=>view.blocks.map(block=>block.list?.label||null);
const visibleContent=view=>view.blocks.map(({text,heading,style,runs,list})=>({text,heading,style,runs,list}));
test('DOCX lists retain body text separately from inherited, nested, restarted and bullet labels',async()=>{
  const source=input(lists()),view=await readDocxVisual(source),extracted=await readTextSource(source);
  assert.deepEqual(listLabels(view),[null,'1.','1.a)','1.b)',null,'2.','2.a)','5.','6.','●','3.']);
  assert.deepEqual(view.blocks.map(b=>b.text),extracted.blocks.map(b=>b.text));
  assert.equal(view.blocks[1].text,'Первый');
  assert.equal(view.blocks[1].list.indent.left,36);assert.equal(view.blocks[1].list.indent.hanging,18);
  assert.equal(view.blocks[2].list.indent.left,72);assert.equal(view.blocks[2].list.suffix,'space');
  assert.equal(view.blocks[1].list.align,'right');assert.equal(view.blocks[9].list.fontFamily,'Arial');
  assert.deepEqual(view.blocks[9].list.markerStyle,{fontWeight:'bold',fontStyle:'italic',fontSize:'12pt',color:'#336699'});
});
test('DOCX list text edits preserve numbering definitions, styles and paragraph properties byte for byte',async()=>{
  const source=input(lists()),before=await unzipDocument(lists());
  const raw=await writeDocxVisual(source,[{record:2,text:'Первый исправленный'},{record:3,text:'Подпункт исправленный'}]),after=await unzipDocument(raw);
  const reloaded=await readDocxVisual(input(raw));
  assert.equal(reloaded.blocks[1].text,'Первый исправленный');assert.equal(reloaded.blocks[2].text,'Подпункт исправленный');
  assert.deepEqual(listLabels(reloaded),[null,'1.','1.a)','1.b)',null,'2.','2.a)','5.','6.','●','3.']);
  for(const [name,bytes] of before)if(name!=='word/document.xml')assert.deepEqual(after.get(name),bytes,name);
  const properties=bytes=>[...new TextDecoder().decode(bytes).matchAll(/<w:pPr>.*?<\/w:pPr>/g)].map(match=>match[0]);
  assert.deepEqual(properties(after.get('word/document.xml')),properties(before.get('word/document.xml')));
});
test('DOCX projected and exported lists agree after insertion, deletion and reordering, including restarts',async()=>{
  const source=input(lists()),model=await readDocxVisual(source);
  const sequence=[{record:1,text:'Условия'},{record:6,text:'Перенесённый'},{text:'Вставленный пункт'},{record:3,text:'Подпункт один'},{record:7,text:'Подпункт два'},{record:8,text:'С пятого'},{record:9,text:'Шестой'},{record:5,text:'Пояснение'},{text:'Обычный абзац'},{record:10,text:'Маркер'},{text:'Ещё маркер'}];
  const projected=projectDocxVisual(model,sequence),reloaded=await readDocxVisual(input(await writeDocxVisual(source,[],{sequence})));
  assert.deepEqual(listLabels(projected),[null,'1.','2.','2.a)','2.b)','5.','6.',null,null,'●','●']);
  assert.deepEqual(visibleContent(projected),visibleContent(reloaded));
  assert.equal(model.blocks[5].list.label,'2.','Projecting a draft must leave original numbering unchanged');
});
test('DOCX list projection counts retained photos and uses the first paragraph template for a leading insertion',async()=>{
  const source=input(lists({photo:true})),model=await readDocxVisual(source);
  const sequence=[{text:'Новый начальный абзац'},{record:2,text:'Первый'},{record:4,text:'Подпункт два'},{record:6,text:'Второй'}];
  const projected=projectDocxVisual(model,sequence),reloaded=await readDocxVisual(input(await writeDocxVisual(source,[],{sequence})));
  assert.deepEqual(visibleContent(projected),visibleContent(reloaded));
  assert.deepEqual(listLabels(projected),[null,'1.','1.a)','1.b)','2.']);
  assert.equal(projected.blocks[2].retainedMedia,true);assert.equal(projected.blocks[2].text,'');
  assert.equal(projected.blocks[2].runs[0].image.src,`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  const listFirst=input(docx([], {xml:`<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Первый</w:t></w:r></w:p></w:body></w:document>`,extraEntries:Object.fromEntries([...await unzipDocument(lists())].filter(([name])=>['word/numbering.xml','word/styles.xml','word/_rels/document.xml.rels'].includes(name)))}));
  const firstModel=await readDocxVisual(listFirst),firstSequence=[{text:'Вставка в начало'},{record:1,text:'Первый'}];
  const firstProjected=projectDocxVisual(firstModel,firstSequence),firstReloaded=await readDocxVisual(input(await writeDocxVisual(listFirst,[],{sequence:firstSequence})));
  assert.deepEqual(listLabels(firstProjected),['1.','2.']);
  assert.deepEqual(visibleContent(firstProjected),visibleContent(firstReloaded));
});
