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


async function openBlank(root,index=0){await until(()=>root.querySelectorAll('.pdf-fill-inline-blank').length>index);root.querySelectorAll('.pdf-fill-inline-blank')[index].click();await until(()=>root.querySelector('[aria-label="Field text"]'));return field(root);}
async function save(root){findButton(field(root),'Save').click();await until(()=>!root.querySelector('[aria-label="Field text"]'));}
const field=root=>root.querySelector('.pdf-fill-inline-layer');
test('upload shows fillable lines; download saves the latest typed Cyrillic without Apply',async t=>{
 const {root,downloads}=setup(t),src=await formSource();let view=await mountSingleEditor(root,{source:src});t.after(()=>view.dispose());
 await view.select(view.drafts.left.entries()[0].key,'left');
 const layer=await openBlank(root);assert.equal(root.querySelector('.visual-inspector').hidden,true,'opening a blank closes the source editor to prevent competing saves');input(layer,'Field text','Анна Пример');
 root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);
 const text=await textPdf(downloads[0]);assert.match(text,/Анна Пример/);assert.match(text,/Application form/);assert.match(text,/Second form page/);
 const saved=view.snapshot();assert.ok(saved.pdfFill.fields[0].y<140);assert.ok(saved.pdfFill.fields[0].y+saved.pdfFill.fields[0].height<=140);
 field(root).querySelector('.pdf-fill-inline-existing').click();await until(()=>root.querySelector('textarea[aria-label="Field text"]'));input(field(root),'Field text','Discard this');findButton(field(root),'Cancel').click();assert.deepEqual(view.snapshot().pdfFill,saved.pdfFill);
 view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:saved});assert.deepEqual(view.snapshot().pdfFill,saved.pdfFill);assert.equal(root.querySelectorAll('.pdf-fill-inline-existing').length,1);
});
test('navigation autosaves, automatic sizing fits the line, invalid text remains editable',async t=>{
 const {root,downloads}=setup(t),view=await mountSingleEditor(root,{source:await formSource()});t.after(()=>view.dispose());
 let layer=await openBlank(root);input(layer,'Width in points','120');input(layer,'Field text','Alexandra Example');
 root.querySelector('[aria-label="Next page"]').click();await until(()=>root.querySelector('canvas[aria-label="Page 2"]')&&root.querySelector('.pdf-fill-inline-blank'));
 const first=view.snapshot().pdfFill.fields[0];assert.ok(first.fontSize<14);assert.equal(first.page,1);
 layer=await openBlank(root);input(layer,'Field text','X'.repeat(500));root.querySelector('[data-save-side="left"]').click();await until(()=>/needs more space/.test(layer.textContent));assert.equal(downloads.length,0);assert.equal(layer.querySelector('textarea').value,'X'.repeat(500));
 input(layer,'Field text','Second page');await save(root);assert.equal(view.snapshot().pdfFill.fields[1].page,2);
 field(root).querySelector('.pdf-fill-inline-existing').click();await until(()=>findButton(field(root),'Delete text'));findButton(field(root),'Delete text').click();await until(()=>view.snapshot().pdfFill.fields.length===1);assert.equal(root.querySelectorAll('.pdf-fill-inline-blank').length,1);
});
test('manual area selection remains available without covering original text controls',async t=>{
 const {root}=setup(t),view=await mountSingleEditor(root,{source:await formSource()});t.after(()=>view.dispose());
 root.querySelector('[data-pdf-fill="left"]').click();await until(()=>field(root).classList.contains('is-placing'));const layer=field(root),paper=root.querySelector('.visual-pdf-page');paper.getBoundingClientRect=()=>({left:40,top:60,width:250,height:350});
 const pointer=(type,x,y)=>layer.dispatchEvent(new window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
 pointer('pointerdown',190,160);pointer('pointerup',65,145);await until(()=>root.querySelector('[aria-label="Field text"]'));
 assert.equal(layer.querySelector('[aria-label="Left in points"]').value,'50');input(layer,'Field text','Address');await save(root);assert.equal(view.snapshot().pdfFill.fields[0].y,170);
 await view.select(view.drafts.left.entries()[0].key,'left');assert.equal(root.querySelector('.visual-inspector').hidden,false);
});
test('changed source positions require explicit revalidation; invalid restored geometry can be repaired',async t=>{
 const {root,downloads}=setup(t),src=await formSource();let view=await mountSingleEditor(root,{source:src});t.after(()=>view.dispose());let layer=await openBlank(root);input(layer,'Field text','Example');await save(root);
 await view.select(view.drafts.left.entries()[0].key,'left');const edit=root.querySelector('[data-edit-side="left"]');edit.value='Application test';edit.dispatchEvent(new window.Event('input'));await until(()=>view.drafts.left.entries()[0].text==='Application test');await delay(500);await until(()=>field(root)&&!root.querySelector('[data-save-side="left"]').disabled);
 root.querySelector('[data-save-side="left"]').click();await delay(100);assert.equal(downloads.length,0);
 field(root).querySelector('.pdf-fill-inline-existing').click();await until(()=>root.querySelector('[aria-label="Field text"]'));await save(root);
 const saved=view.snapshot();saved.pdfFill.fields[0].width=900;view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:saved});
 field(root).querySelector('.pdf-fill-inline-existing').click();await until(()=>root.querySelector('[aria-label="Field text"]'));input(field(root),'Width in points','250');await save(root);
 root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);const text=await textPdf(downloads[0]);assert.match(text,/Application test/);assert.match(text,/Example/);
});
