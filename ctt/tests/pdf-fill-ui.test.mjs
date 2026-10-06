import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {JSDOM} from 'jsdom';
import {PDFDocument,fontkit} from '../dist/pdf-vendor.mjs';
import fontBase64 from '../dist/pdf-font.mjs';
import {mountSingleEditor} from '../dist/single-editor.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import editor from '../dist/text-editor.js';
const require=createRequire(import.meta.url),native=require('@napi-rs/canvas');
const source=(name,data)=>({name,data:Buffer.from(data).toString('base64')});
const until=async fn=>{for(let i=0;i<400;i++){if(fn())return;await delay(15);}assert.fail('Timed out');};
const visible=n=>!n.closest('[hidden]');
async function textPdf(blob){const task=getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,disableFontFace:true,verbosity:0});try{const doc=await task.promise;let text='';for(let i=1;i<=doc.numPages;i++)text+=(await (await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');return text;}finally{await task.destroy();}}
function setup(t,html='<main></main>'){
 const dom=new JSDOM(html,{url:'https://ctt.example/',pretendToBeVisual:true,runScripts:'outside-only'});Object.assign(globalThis,{window:dom.window,document:dom.window.document,DOMMatrix:native.DOMMatrix,Path2D:native.Path2D,ImageData:native.ImageData});window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const canvases=new WeakMap(),canvas=el=>{let c=canvases.get(el);if(!c||c.width!==el.width||c.height!==el.height){c=native.createCanvas(el.width,el.height);canvases.set(el,c);}return c;};window.HTMLCanvasElement.prototype.getContext=function(type){const ctx=canvas(this).getContext(type);if(!ctx.wrapped){const draw=ctx.drawImage.bind(ctx);ctx.drawImage=(img,...a)=>draw(img instanceof window.HTMLCanvasElement?canvas(img):img,...a);ctx.wrapped=true;}return ctx;};
 window.HTMLCanvasElement.prototype.toBlob=function(callback,mime){canvas(this).toBlob(callback,mime);};
 globalThis.FontFace=class{constructor(name,bytes){this.name=name;this.bytes=bytes;}async load(){native.GlobalFonts.register(Buffer.from(this.bytes),this.name);return this;}};document.fonts={add(){}};
 const downloads=[],names=[],oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=b=>{downloads.push(b);return 'blob:single';};URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=function(){names.push(this.download);};
 t.after(()=>{dom.window.close();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;for(const k of ['window','document','DOMMatrix','Path2D','ImageData','FontFace'])delete globalThis[k];});return {dom,root:document.querySelector('main'),downloads,names};
}
const findButton=(root,label)=>[...root.querySelectorAll('button')].find(node=>node.textContent===label);
const input=(root,label,value)=>{const node=root.querySelector(`[aria-label="${label}"]`);assert.ok(node,label);node.value=value;node.dispatchEvent(new window.Event('input'));};
async function formSource(){const doc=await PDFDocument.create();doc.registerFontkit(fontkit);const font=await doc.embedFont(Buffer.from(fontBase64,'base64'),{subset:true});for(let i=0;i<2;i++){const page=doc.addPage([500,700]);page.drawText(i?'Second form page':'Application form',{x:50,y:620,size:14,font});page.drawLine({start:{x:50,y:560},end:{x:380,y:560},thickness:.5});}return source('synthetic-form.pdf',await doc.save());}
async function openFill(root){root.querySelector('[data-pdf-fill="left"]').click();await until(()=>root.querySelector('.pdf-fill-dialog')&&findButton(root.querySelector('.pdf-fill-dialog'),'Add text')?.disabled===false);return root.querySelector('.pdf-fill-dialog');}
async function ready(dialog){await until(()=>findButton(dialog,'Apply').disabled===false);}

test('printed form filling persists, exports Cyrillic, cancels staged edits and guards stale positions',async t=>{
 const {root,downloads}=setup(t),src=await formSource();let view=await mountSingleEditor(root,{source:src});t.after(()=>view?.dispose());
 let dialog=await openFill(root);findButton(dialog,'Add text').click();input(dialog,'Field text','Анна Пример');input(dialog,'Left in points','50');input(dialog,'Top in points','115');input(dialog,'Width in points','250');
 assert.equal(findButton(dialog,'Apply').disabled,true,'unvalidated changes cannot be applied');await ready(dialog);findButton(dialog,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog'));const saved=view.snapshot();assert.equal(saved.pdfFill.fields[0].text,'Анна Пример');assert.equal(saved.pdfFill.fields[0].x,50);assert.equal(saved.pdfFill.fields[0].y,115);assert.equal(view.changed,true);
 view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:saved});assert.deepEqual(view.snapshot().pdfFill,saved.pdfFill);root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);const exported=await textPdf(downloads[0]);assert.match(exported,/Анна Пример/);assert.match(exported,/Application form/);assert.match(exported,/Second form page/);
 dialog=await openFill(root);input(dialog,'Field text','Discard this change');findButton(dialog,'Cancel').click();assert.deepEqual(view.snapshot().pdfFill,saved.pdfFill);
 const item=view.drafts.left.entries()[0];await view.select(item.key,'left');root.querySelector('[data-pdf-text-view="left"]').click();const edit=root.querySelector('[data-edit-side="left"]');edit.value='Application test';edit.dispatchEvent(new window.Event('input'));await until(()=>view.drafts.left.entries()[0].text==='Application test');await until(()=>!root.querySelector('[data-save-side="left"]').disabled);root.querySelector('[data-save-side="left"]').click();await delay(100);assert.equal(downloads.length,1,'stale field positions cannot be exported');assert.match(root.textContent,/check the positions|check the field positions/);
 dialog=await openFill(root);await ready(dialog);findButton(dialog,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog'));root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===2);const revised=await textPdf(downloads[1]);assert.match(revised,/Application test/);assert.match(revised,/Анна Пример/);
});

test('field placement rejects out-of-page geometry, supports next page and deletion',async t=>{
 const {root}=setup(t),src=await formSource();const view=await mountSingleEditor(root,{source:src});t.after(()=>view.dispose());const dialog=await openFill(root);findButton(dialog,'Next page').click();await until(()=>dialog.querySelector('.pdf-fill-toolbar span').textContent==='Page 2 of 2'&&!findButton(dialog,'Add text').disabled);findButton(dialog,'Add text').click();input(dialog,'Field text','Example');input(dialog,'Left in points','900');await until(()=>/must stay inside/.test(dialog.querySelector('[role="status"]').textContent));assert.equal(findButton(dialog,'Apply').disabled,true);input(dialog,'Left in points','50');await ready(dialog);findButton(dialog,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog'));assert.equal(view.snapshot().pdfFill.fields[0].page,2);
 const again=await openFill(root);findButton(again,'Delete text').click();await ready(again);findButton(again,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog'));assert.equal(view.snapshot().pdfFill,undefined);assert.equal(view.changed,false);
});

test('restored out-of-page fields recover preview and download after position correction',async t=>{
 const {root,downloads}=setup(t),src=await formSource();let view=await mountSingleEditor(root,{source:src});t.after(()=>view?.dispose());let dialog=await openFill(root);findButton(dialog,'Add text').click();input(dialog,'Field text','Анна Пример');await ready(dialog);findButton(dialog,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog'));const saved=view.snapshot();saved.pdfFill.fields[0].x=900;
 view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:saved});await until(()=>root.querySelector('[data-save-side="left"]').disabled);assert.equal(downloads.length,0);dialog=await openFill(root);await until(()=>/must stay inside/.test(dialog.querySelector('[role="status"]').textContent));assert.equal(findButton(dialog,'Apply').disabled,true);input(dialog,'Left in points','50');await ready(dialog);findButton(dialog,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog')&&!root.querySelector('[data-save-side="left"]').disabled);root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);assert.match(await textPdf(downloads[0]),/Анна Пример/);assert.equal(view.snapshot().pdfFill.fields[0].x,50);
});

test('empty form opens at the start and a blank-page click creates a usable field',async t=>{
 const {root,downloads}=setup(t),src=await formSource(),view=await mountSingleEditor(root,{source:src});t.after(()=>view.dispose());const dialog=await openFill(root);
 assert.equal(document.activeElement,dialog,'opening must not focus the bottom Cancel button and scroll away from Add text');
 assert.equal(findButton(dialog,'Apply').disabled,true,'an untouched empty form has nothing to apply');
 assert.equal(dialog.querySelector('[aria-label="Field text"]').disabled,true);
 const paper=dialog.querySelector('.pdf-fill-paper');paper.getBoundingClientRect=()=>({left:40,top:60,width:250,height:350,right:290,bottom:410,x:40,y:60,toJSON(){return {};}});
 paper.dispatchEvent(new window.MouseEvent('click',{bubbles:true,clientX:90,clientY:160}));
 const fieldText=dialog.querySelector('[aria-label="Field text"]');assert.equal(fieldText.disabled,false);assert.equal(document.activeElement,fieldText);assert.equal(dialog.querySelector('[aria-label="Left in points"]').value,'100');assert.equal(dialog.querySelector('[aria-label="Top in points"]').value,'200');
 input(dialog,'Field text','Анна Пример');await ready(dialog);findButton(dialog,'Apply').click();await until(()=>!root.querySelector('.pdf-fill-dialog'));const field=view.snapshot().pdfFill.fields[0];assert.equal(field.x,100);assert.equal(field.y,200);root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);assert.match(await textPdf(downloads[0]),/Анна Пример/);
});
