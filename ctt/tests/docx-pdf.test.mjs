import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {readDocxVisual,projectDocxVisual} from '../dist/docx-visual.mjs';
import {renderDocxPdf} from '../dist/docx-pdf.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {PDFDocument} from '../dist/pdf-vendor.mjs';
import {handleRequest} from '../dist/worker.mjs';
import {mountVisualReview} from '../dist/visual-review.mjs';
import editor from '../dist/text-editor.js';
import {createDocxRowEditor} from '../dist/docx-row-editor.mjs';
import {tableSource} from './fixtures/table-fixture.mjs';
import {docx,W} from './fixtures/text-fixture.mjs';
const require=createRequire(import.meta.url),{JSDOM}=require('jsdom');const native=require('@napi-rs/canvas');
const source=(name,data)=>({name,data:Buffer.from(data).toString('base64')});
const sequence=model=>model.blocks.map(b=>({record:b.record,key:'key-'+b.record,text:b.text}));
async function extracted(data){const loading=getDocument({data:data.slice(),useSystemFonts:false,disableFontFace:true,isEvalSupported:false,verbosity:0});try{const doc=await loading.promise,out=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),text=await page.getTextContent();out.push(text.items.map(x=>x.str).join(' '));}return out;}finally{await loading.destroy();}}
async function demo(){const js=await readFile(new URL('../dist/document-demo.js',import.meta.url),'utf8');return JSON.parse(js.slice(js.indexOf('Object.freeze(')+14,js.lastIndexOf(');')));}
async function artifact(name,bytes){if(process.env.DOCX_PDF_ARTIFACT_DIR){await mkdir(process.env.DOCX_PDF_ARTIFACT_DIR,{recursive:true});await writeFile(process.env.DOCX_PDF_ARTIFACT_DIR+'/'+name,bytes);}}
test('Word PDF retains merged tables, edited text, page breaks and all lines across pages',async()=>{
 const model=await readDocxVisual(tableSource()),seq=sequence(model);seq.find(e=>e.text==='Печать').text='Исправленный текст';
 const compact=await renderDocxPdf(projectDocxVisual(model,seq)),compactText=(await extracted(compact)).join(' ');assert.match(compactText,/Исправленный текст/);assert.doesNotMatch(compactText,/Печать/);assert.match(compactText,/Группа/);assert.match(compactText,/Доставка/);await artifact('word-table.pdf',compact);
 const rowSources=await demo(),rowModel=await readDocxVisual(rowSources.right),rowReport=(await handleRequest('/api/compare',rowSources)).report,draft=createDocxRowEditor(rowReport,'right',rowModel),newKey=draft.insertRow(1,2,'after');draft.edit(newKey,'Added delivery row');const rowPdf=await renderDocxPdf(projectDocxVisual(rowModel,draft.entries(),{rowPlan:draft.rowPlan()}));assert.match((await extracted(rowPdf)).join(' '),/Added delivery row/);
 seq.find(e=>e.text==='Исправленный текст').text=Array.from({length:130},(_,i)=>`Row detail ${i+1}`).join('\n');let layout;
 const expanded=await renderDocxPdf(projectDocxVisual(model,seq),{onLayout:value=>layout=value}),pages=await extracted(expanded);assert.ok(pages.length>2);for(let i=1;i<=130;i++)assert.match(pages.join(' '),new RegExp(`Row detail ${i}(?: |$)`));assert.match(pages.at(-1),/Конец/);assert.equal((pages.join(' ').match(/Группа/g)||[]).length,1);
 for(const r of layout){assert.ok(r.y>=model.page.marginTop*.75-.01);assert.ok(r.y+r.height<=(model.page.height-model.page.marginBottom)*.75+.01,JSON.stringify(r));}await artifact('word-long-table.pdf',expanded);
 const breaks=source('breaks.docx',docx([],{xml:`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>First page</w:t><w:br w:type="page"/><w:t>Second page</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Third page</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="15840" w:h="12240"/></w:sectPr></w:body></w:document>`}));
 const bm=await readDocxVisual(breaks),bp=await renderDocxPdf(projectDocxVisual(bm,sequence(bm))),texts=await extracted(bp);assert.equal(texts.length,3);assert.match(texts[0],/First page/);assert.match(texts[1],/Second page/);assert.match(texts[2],/Third page/);assert.deepEqual((await PDFDocument.load(bp)).getPage(0).getSize(),{width:792,height:612});
 const reverse=projectDocxVisual(bm,sequence(bm).reverse());reverse.blocks.forEach(b=>{b.pageBreakBefore=false;b.runs=b.runs.filter(r=>!r.pageBreak);});const reversed=(await extracted(await renderDocxPdf(reverse))).join(' ');assert.ok(reversed.indexOf('Third page')<reversed.indexOf('First page'));
 await assert.rejects(()=>renderDocxPdf({...model,pdfUnsupported:['Unsupported layout']}),/Unsupported layout/);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>renderDocxPdf(model,{signal:abort.signal}),{name:'AbortError'});
});

test('Word PDF preview downloads edited text and image, rejects stale revisions and leaves drafts unchanged',{skip:!native},async t=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),root=dom.window.document.querySelector('main');Object.assign(globalThis,{window:dom.window,document:dom.window.document,DOMMatrix:native.DOMMatrix,Path2D:native.Path2D,ImageData:native.ImageData});window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const canvases=new WeakMap();function canvas(el){let c=canvases.get(el);if(!c||c.width!==el.width||c.height!==el.height){c=native.createCanvas(el.width,el.height);canvases.set(el,c);}return c;}
 window.HTMLCanvasElement.prototype.getContext=function(type){const ctx=canvas(this).getContext(type);if(!ctx._wrapped){const draw=ctx.drawImage.bind(ctx);ctx.drawImage=(image,...args)=>draw(image instanceof window.HTMLCanvasElement?canvas(image):image,...args);ctx._wrapped=true;}return ctx;};
 let view;const downloads=[],oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:word-pdf';};URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=function(){};
 t.after(()=>{view?.dispose();dom.window.close();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;for(const key of ['window','document','DOMMatrix','Path2D','ImageData'])delete globalThis[key];});
 const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await delay(20);}assert.fail(root.querySelector('.document-pdf-status')?.textContent||'Preview timeout');};
 const sources=await demo(),{report}=await handleRequest('/api/compare',sources);view=await mountVisualReview(root,{report,sources});const group=report.changed.find(g=>g.right.text.includes('Warranty'));await view.select(group.key);const field=root.querySelector('[data-edit-side="right"]');field.value='Warranty: 36 months.';field.dispatchEvent(new window.Event('input'));const before=view.drafts.right.snapshot();
 root.querySelector('[data-download-format="right"]').value='pdf';root.querySelector('[data-save-side="right"]').click();const dialog=()=>root.querySelector('.document-pdf-dialog'),save=()=>dialog()?.querySelector('.primary');await until(()=>save()&&!save().disabled);assert.deepEqual(view.drafts.right.snapshot(),before);
 const c=dialog().querySelector('canvas'),pixels=c.getContext('2d').getImageData(45,45,50,50).data;let green=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+1]>pixels[i]*1.15&&pixels[i+1]>pixels[i+2]*1.1)green++;assert.ok(green>100,'The embedded logo is visible in its original position');
 save().click();assert.equal(downloads.length,1);const pdf=new Uint8Array(await downloads[0].arrayBuffer()),text=(await extracted(pdf)).join(' ');assert.match(text,/Warranty: 36 months/);assert.doesNotMatch(text,/Warranty: 12 months/);assert.match(text,/Desk lamp/);await artifact('word-edited-demo.pdf',pdf);if(process.env.DOCX_PDF_ARTIFACT_DIR)await writeFile(process.env.DOCX_PDF_ARTIFACT_DIR+'/word-preview.png',canvas(c).toBuffer('image/png'));
 view.drafts.right.edit(group.key,'Warranty: 48 months.');save().click();assert.equal(downloads.length,1);assert.match(dialog().textContent,/document changed/);dialog().querySelector('.pdf-block-actions .secondary').click();
 root.querySelector('[data-save-side="right"]').click();await until(()=>save()&&!save().disabled);save().click();assert.equal(downloads.length,2);assert.match((await extracted(new Uint8Array(await downloads[1].arrayBuffer()))).join(' '),/Warranty: 48 months/);dialog().querySelector('.pdf-block-actions .secondary').click();
 const latest=view.drafts.right.snapshot();root.querySelector('[data-save-side="right"]').click();await until(()=>dialog());dialog().querySelector('.pdf-block-actions .secondary').click();await delay(50);assert.equal(dialog(),null);assert.deepEqual(view.drafts.right.snapshot(),latest);assert.equal(downloads.length,2);
});
