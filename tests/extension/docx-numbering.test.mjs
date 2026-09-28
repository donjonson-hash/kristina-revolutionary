import test from 'node:test';
import assert from 'node:assert/strict';
import {readDocxPackage,readTextSource} from '../../extension/text-source.mjs';
import {renderDocxNumbering} from '../../extension/docx-numbering.mjs';
import {docx,W} from './text-fixture.mjs';
const level=(i,fmt='decimal',text=`%${i+1}.`,extra='',start=1)=>`<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`;
const para=(num=1,level=0,text='body',extra='')=>`<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${num}"/></w:numPr>${extra}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const numbering=(levels,nums='<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>')=>`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0">${levels}</w:abstractNum>${nums}</w:numbering>`;
const pack=(paragraphs,numberingXml,styles='',extra={})=>docx([],{xml:`<w:document xmlns:w="${W}"><w:body>${paragraphs}</w:body></w:document>`,extraEntries:{...(numberingXml?{'word/numbering.xml':numberingXml}:{}),...(styles?{'word/styles.xml':`<w:styles xmlns:w="${W}">${styles}</w:styles>`}:{}),...extra}});
const resolved=async bytes=>(await readDocxPackage(bytes)).listData;
const labels=async bytes=>renderDocxNumbering(await resolved(bytes)).map(x=>x?.label??null);

test('lists use independent numbering instances and starts; displayed markers are not comparison text',async()=>{
 const num=numbering(level(0),'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>');
 const bytes=pack(para()+para(2)+para()+para(2),num);assert.deepEqual(await labels(bytes),['1.','7.','2.','8.']);
 const result=await readTextSource({name:'lists.docx',data:Buffer.from(bytes).toString('base64')});assert.deepEqual(result.blocks.map(x=>x.text),Array(4).fill('body'));assert.ok(result.meta.notes.some(n=>n.includes('без автоматической нумерации')));
});
test('nested decimal, letters and Roman numbers restart or continue according to lvlRestart',async()=>{
 const levels=level(0)+level(1,'lowerLetter','%2)')+level(2,'lowerRoman','%3)', '<w:lvlRestart w:val="0"/>');
 const sequence=[0,1,2,2,0,1,2];assert.deepEqual(await labels(pack(sequence.map(i=>para(1,i)).join(''),numbering(levels))),['1.','a)','i)','ii)','2.','a)','iii)']);
});
test('level overrides replace formats while startOverride wins and legal numbering uses decimal ancestors',async()=>{
 const nums='<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="1"><w:startOverride w:val="3"/>'+level(1,'upperLetter','%1.%2', '<w:isLgl/>',9)+'</w:lvlOverride></w:num>';
 assert.deepEqual(await labels(pack(para()+para(1,1)+para(1,1),numbering(level(0,'upperRoman')+level(1),nums))),['I.','1.3','1.4']);
});
test('applied/default style inheritance, document defaults and explicit numId zero resolve without editable labels',async()=>{
 const styles='<w:docDefaults><w:pPrDefault><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child" w:default="1"><w:basedOn w:val="Base"/></w:style>';
 const plain='<w:p><w:r><w:t>body</w:t></w:r></w:p>';
 assert.deepEqual(await labels(pack(plain+para(0)+plain,numbering(level(0)),styles)),['1.',null,'2.']);
});
test('style-linked levels and direct level overrides are resolved with bounded style chains',async()=>{
 const styles='<w:style w:type="paragraph" w:styleId="Nested"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';
 const p='<w:p><w:pPr><w:pStyle w:val="Nested"/></w:pPr><w:r><w:t>nested</w:t></w:r></w:p>';
 const levels=level(0)+level(1,'decimal','%1.%2','<w:pStyle w:val="Nested"/>');assert.deepEqual(await labels(pack(p,numbering(levels),styles)),['1.1']);
 const conflict=styles.replace('<w:numId','<w:ilvl w:val="0"/><w:numId');await assert.rejects(()=>resolved(pack(p,numbering(levels),conflict)),/неоднозначный уровень/);
});
test('standard Symbol and Wingdings bullets become portable Unicode, other private glyphs refuse explicitly',async()=>{
 for(const [font,glyph,label]of[['Symbol','\uF0B7','•'],['Wingdings','\uF0A7','▪'],['Arial','•','•']])assert.deepEqual(await labels(pack(para(),numbering(level(0,'bullet',glyph,`<w:rPr><w:rFonts w:ascii="${font}"/></w:rPr>`)))),[label]);
 await assert.rejects(()=>resolved(pack(para(),numbering(level(0,'bullet','\uF0FF','<w:rPr><w:rFonts w:ascii="Wingdings"/></w:rPr>')))),/символический маркер/);
});
test('list indent follows direct paragraph overrides and marker emphasis is separate from body',async()=>{
 const n=numbering(level(0,'decimal','%1.','<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="123456"/></w:rPr>'));
 const [result]=renderDocxNumbering(await resolved(pack(para(1,0,'body','<w:ind w:left="1080"/>'),n)));
 assert.deepEqual(result.indent,{left:54,hanging:18,firstLine:0});assert.deepEqual(result.markerStyle,{fontWeight:'bold',fontSize:'14pt',color:'#123456'});
});
test('reordering recomputes counters and serializable descriptors survive structured clone',async()=>{
 const data=await resolved(pack(para()+para()+para(),numbering(level(0))));const copy=structuredClone(data);assert.deepEqual(renderDocxNumbering(copy,[copy.paragraphs[2],copy.paragraphs[0]]).map(x=>x.label),['1.','2.']);
});
test('unused unsupported list levels do not block regular document or used supported levels',async()=>{
 const unsupported=level(1,'chicago','%2');assert.deepEqual(await labels(pack(para(),numbering(level(0)+unsupported))),['1.']);
 await assert.rejects(()=>resolved(pack(para(1,1),numbering(level(0)+unsupported))),/формат автоматической/);
 const picture=level(0).replace('</w:lvl>','<w:lvlPicBulletId w:val="1"/></w:lvl>');await assert.rejects(()=>resolved(pack(para(),numbering(picture))),/lvlPicBulletId/);
});
test('invalid numbering links, levels, duplicate XML properties and misplaced numPr cannot silently degrade',async()=>{
 await assert.rejects(()=>resolved(pack(para(4),numbering(level(0)))),/отсутствует определение/);
 await assert.rejects(()=>resolved(pack(para(1,9),numbering(level(0)))),/уровень/);
 await assert.rejects(()=>resolved(pack(para(),numbering(level(0)+level(0)))),/повторяющийся/);
 await assert.rejects(()=>resolved(pack(para(),numbering(level(0).replace('</w:lvl>','<w:start w:val="7"/></w:lvl>')))),/неоднозначное/);
 await assert.rejects(()=>resolved(pack('<w:p><w:r><w:rPr><w:numPr><w:numId w:val="1"/></w:numPr></w:rPr><w:t>x</w:t></w:r></w:p>',numbering(level(0)))),/numPr/);
});
test('stylesWithEffects absent custom styles fall back but conflicting definitions refuse',async()=>{
 const p='<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>',style='<w:style w:type="paragraph" w:styleId="Custom"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';
 assert.deepEqual(await labels(pack(p,numbering(level(0)),style,{'word/stylesWithEffects.xml':`<w:styles xmlns:w="${W}"/>`})),['1.']);
 await assert.rejects(()=>resolved(pack(p,numbering(level(0)),style,{'word/stylesWithEffects.xml':`<w:styles xmlns:w="${W}">${style.replace('w:val="1"','w:val="0"')}</w:styles>`})),/stylesWithEffects/);
});
test('plain paragraphs retain previous formatting scope and strict namespace lists resolve',async()=>{
 const plain='<w:p><w:pPr><w:ind w:leftChars="100"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>';assert.deepEqual(await labels(pack(plain,null)),[null]);
 const bytes=docx([],{xml:`<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body>${para()}</w:body></w:document>`,extraEntries:{'word/numbering.xml':numbering(level(0)).replaceAll(W,'http://purl.oclc.org/ooxml/wordprocessingml/main')}});assert.deepEqual(await labels(bytes),['1.']);
});
test('native Word letter progression repeats letters after Z and restarts skipped levels',async()=>{
 // Independent fixture rendered in LibreOffice: Z,AA,BB,CC (not Excel columns).
 for(const [fmt,expected]of[['upperLetter',['Z.','AA.','BB.','CC.']],['lowerLetter',['z.','aa.','bb.','cc.']]])assert.deepEqual(await labels(pack(para().repeat(4),numbering(level(0,fmt,'%1.','',26)))),expected);
 assert.deepEqual(await labels(pack([0,2,2,0,2].map(i=>para(1,i)).join(''),numbering(level(0)+level(1)+level(2)))),['1.','1.','2.','2.','1.']);
});
test('orphan sublevels establish implicit parent counters before explicit parent paragraphs',async()=>{
 const levels=level(0)+level(1,'decimal','%1.%2.')+level(2,'decimal','%1.%2.%3.');
 assert.deepEqual(await labels(pack([1,2,0,1].map(i=>para(1,i)).join(''),numbering(levels))),['1.1.','1.1.1.','2.','2.1.']);
});
