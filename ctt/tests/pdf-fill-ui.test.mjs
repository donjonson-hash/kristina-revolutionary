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

async function openFill(root){root.querySelector('[data-pdf-fill="left"]').click();await until(()=>root.querySelector('.pdf-fill-inline-layer'));return root.querySelector('.pdf-fill-inline-layer');}
async function apply(root){const layer=root.querySelector('.pdf-fill-inline-layer');await until(()=>!findButton(layer,'Apply').disabled);findButton(layer,'Apply').click();await until(()=>root.querySelector('.pdf-fill-inline-layer')&&!root.querySelector('[aria-label="Field text"]'));}
const field=root=>root.querySelector('.pdf-fill-inline-layer');
test('inline fields persist, preserve source, export Cyrillic and guard unfinished input',async t=>{
 const {root,downloads}=setup(t),src=await formSource();let view=await mountSingleEditor(root,{source:src});t.after(()=>view.dispose());
 let layer=await openFill(root);findButton(layer,'Add text').click();input(layer,'Field text','Анна Пример');input(layer,'Left in points','50');input(layer,'Top in points','115');input(layer,'Width in points','250');
 root.querySelector('[data-save-side="left"]').click();await delay(50);assert.equal(downloads.length,0);assert.match(root.textContent,/Apply or cancel/);
 await apply(root);const saved=view.snapshot();assert.equal(saved.pdfFill.fields[0].y,115);
 layer=field(root);layer.querySelector('.pdf-fill-inline-existing').click();input(layer,'Field text','Discard this');findButton(layer,'Cancel').click();assert.deepEqual(view.snapshot().pdfFill,saved.pdfFill);
 view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:saved});root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);const text=await textPdf(downloads[0]);assert.match(text,/Анна Пример/);assert.match(text,/Application form/);assert.match(text,/Second form page/);
});
test('drag uses page coordinates, formatting repairs overflow, multiple areas and pages work',async t=>{
 const {root}=setup(t),view=await mountSingleEditor(root,{source:await formSource()});t.after(()=>view.dispose());let layer=await openFill(root);
 const paper=root.querySelector('.visual-pdf-page');paper.getBoundingClientRect=()=>({left:40,top:60,width:250,height:350});
 const pointer=(type,x,y)=>layer.dispatchEvent(new window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
 pointer('pointerdown',190,130);pointer('pointermove',65,115);pointer('pointerup',65,115);
 assert.equal(field(root).querySelector('[aria-label="Left in points"]').value,'50');assert.equal(field(root).querySelector('[aria-label="Top in points"]').value,'110');
 input(layer,'Field text','Example');input(layer,'Width in points','15');
 await until(()=>/does not fit/.test(layer.textContent));assert.equal(findButton(layer,'Apply').disabled,true);assert.equal(layer.querySelector('textarea').value,'Example');
 input(layer,'Width in points','250');await apply(root);assert.equal(view.snapshot().pdfFill.fields[0].width,250);
 layer=field(root);findButton(layer,'Add text').click();input(layer,'Field text','Address');await apply(root);assert.equal(view.snapshot().pdfFill.fields.length,2);
 root.querySelector('[aria-label="Next page"]').click();await until(()=>root.querySelector('canvas[aria-label="Page 2"]')&&field(root));
 layer=field(root);findButton(layer,'Add text').click();input(layer,'Field text','Second page');input(layer,'Left in points','900');await until(()=>/must stay inside/.test(layer.textContent));input(layer,'Left in points','50');await apply(root);assert.equal(view.snapshot().pdfFill.fields[2].page,2);
 field(root).querySelector('.pdf-fill-inline-existing').click();findButton(field(root),'Delete text').click();await until(()=>view.snapshot().pdfFill.fields.length===2);assert.ok(view.snapshot().pdfFill.fields.every(f=>f.page===1));
});
test('source edits require field revalidation before downloading',async t=>{
 const {root,downloads}=setup(t),view=await mountSingleEditor(root,{source:await formSource()});t.after(()=>view.dispose());let layer=await openFill(root);findButton(layer,'Add text').click();input(layer,'Field text','Example');await apply(root);
 root.querySelector('[data-pdf-fill="left"]').click();await until(()=>!field(root));await view.select(view.drafts.left.entries()[0].key,'left');root.querySelector('[data-pdf-text-view="left"]').click();
 const edit=root.querySelector('[data-edit-side="left"]');edit.value='Application test';edit.dispatchEvent(new window.Event('input'));await until(()=>view.drafts.left.entries()[0].text==='Application test');await until(()=>!root.querySelector('[data-save-side="left"]').disabled);root.querySelector('[data-save-side="left"]').click();await delay(100);assert.equal(downloads.length,0);assert.match(root.textContent,/check the positions|check the field positions/);
 layer=await openFill(root);layer.querySelector('.pdf-fill-inline-existing').click();await apply(root);root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);const text=await textPdf(downloads[0]);assert.match(text,/Application test/);assert.match(text,/Example/);
});
test('invalid restored positions remain repairable directly on the page',async t=>{
 const {root,downloads}=setup(t),src=await formSource();let view=await mountSingleEditor(root,{source:src});t.after(()=>view.dispose());let layer=await openFill(root);findButton(layer,'Add text').click();input(layer,'Field text','Example');await apply(root);const saved=view.snapshot();saved.pdfFill.fields[0].width=900;
 view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:saved});layer=await openFill(root);layer.querySelector('.pdf-fill-inline-existing').click();await until(()=>/must stay inside/.test(layer.textContent));input(layer,'Width in points','250');await apply(root);root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);assert.match(await textPdf(downloads[0]),/Example/);
});
