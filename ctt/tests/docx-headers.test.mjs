import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {docx,W} from './fixtures/text-fixture.mjs';
import {readTextSource} from '../dist/text-source.mjs';
import {readDocxVisual,writeDocxVisual} from '../dist/docx-visual.mjs';
import {renderDocxPdf} from '../dist/docx-pdf.mjs';
import {unzipDocument} from '../dist/text-zip.mjs';
import {handleRequest} from '../dist/worker.mjs';
import {mountVisualReview} from '../dist/visual-review.mjs';
import {mountSingleEditor} from '../dist/single-editor.mjs';
import editor from '../dist/text-editor.js';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const source=bytes=>({name:'headers.docx',data:Buffer.from(bytes).toString('base64')});
function fixture({header='Project title',field='PAGE',ref='h',target='header1.xml',extra={},body='<w:p><w:r><w:t>Body text</w:t></w:r></w:p>',headerXml}={}){
 return source(docx([],{xml:`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="${ref}"/><w:footerReference w:type="default" r:id="f"/></w:sectPr></w:body></w:document>`,extraEntries:{
  'word/header1.xml':headerXml||`<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>${header}</w:t></w:r></w:p></w:hdr>`,
  'word/footer1.xml':`<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>October 2026 • </w:t></w:r><w:fldSimple w:instr="${field}"/></w:p></w:ftr>`,
  'word/_rels/document.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="h" Type="${R}/header" Target="${target}"/><Relationship Id="f" Type="${R}/footer" Target="footer1.xml"/></Relationships>`,...extra}}));
}
test('DOCX imports the body, discloses peripheral coverage and preserves every other package part on edit',async()=>{
 const src=fixture(),parsed=await readTextSource(src),model=await readDocxVisual(src);
 assert.deepEqual(parsed.blocks.map(b=>b.text),['Body text']);assert.equal(parsed.meta.coverage,'main_body_only');assert.equal(parsed.meta.header_footer_count,2);assert.match(parsed.meta.notes.join(' '),/not compared/);
 assert.deepEqual(model.headersFooters.map(p=>p.text),['Project title','October 2026 • [Page number]']);
 const bytes=await writeDocxVisual(src,[{record:1,text:'Edited body'}]),after=await readTextSource(source(bytes));assert.equal(after.blocks[0].text,'Edited body');
 const beforeParts=await unzipDocument(Buffer.from(src.data,'base64')),afterParts=await unzipDocument(bytes);assert.deepEqual([...afterParts.keys()].sort(),[...beforeParts.keys()].sort());
 for(const [path,content] of beforeParts)if(path!=='word/document.xml')assert.deepEqual(afterParts.get(path),content,path);
 assert.deepEqual((await readDocxVisual(source(bytes))).headersFooters,model.headersFooters);
 await assert.rejects(()=>renderDocxPdf(model),/headers or footers/);
 const {report}=await handleRequest('/api/compare',{left:src,right:fixture({header:'Different title'})});assert.equal(report.changed.length,0);assert.equal(report.sources.left.coverage,'main_body_only');
});
test('DOCX rejects missing references, active header fields, unsupported objects and unhandled notes',async()=>{
 for(const src of [fixture({ref:'missing'}),fixture({target:'missing.xml'}),fixture({field:'INCLUDETEXT &quot;https://example.org&quot;'}),fixture({headerXml:`<w:hdr xmlns:w="${W}"><w:p><w:r><w:drawing/></w:r></w:p></w:hdr>`}),fixture({extra:{'word/footnotes.xml':`<w:footnotes xmlns:w="${W}"/>`}})])await assert.rejects(()=>readTextSource(src),/header|footer|footnote/i);
 const external=fixture({target:'header1.xml" TargetMode="External'});await assert.rejects(()=>readTextSource(external),/external relationships/);
});
test('inherited list-level hints do not prevent importing unnumbered styled paragraphs',async()=>{
 const styles=`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading"><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
 const body='<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>Heading text</w:t></w:r></w:p>';
 assert.equal((await readTextSource(fixture({body,extra:{'word/styles.xml':styles}}))).blocks[0].text,'Heading text');
 await assert.rejects(()=>readTextSource(fixture({body:body.replace('<w:pStyle w:val="Heading"/>','<w:numPr><w:ilvl w:val="1"/></w:numPr>')})),/without a numbering definition/);
});
test('single and comparison views disclose read-only headers and disable incomplete PDF export',async t=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true});Object.assign(globalThis,{window:dom.window,document:dom.window.document});window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 t.after(()=>{dom.window.close();delete globalThis.window;delete globalThis.document;});
 const root=document.querySelector('main'),sources={left:fixture(),right:fixture({header:'Other title'})};
 for(const single of [false,true]){
  const view=single?await mountSingleEditor(root,{source:sources.left}):await mountVisualReview(root,{report:(await handleRequest('/api/compare',sources)).report,sources});
  try{for(const side of single?['left']:['left','right']){
   const details=root.querySelector(`[data-docx-peripheral="${side}"]`);assert.match(details.textContent,/read-only, not compared/);assert.match(details.textContent,/\[Page number\]/);assert.equal(details.querySelector('input,textarea,[contenteditable]'),null);
   assert.match(root.querySelector(`[data-docx-peripheral-note="${side}"]`).textContent,/kept unchanged/);
   const select=root.querySelector(`[data-download-format="${side}"]`);assert.equal(select.value,'docx');assert.equal(select.querySelector('[value="pdf"]').disabled,true);
  }}finally{view.dispose();root.replaceChildren();}
 }
});
