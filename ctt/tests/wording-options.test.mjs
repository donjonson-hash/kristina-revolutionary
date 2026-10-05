import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {wordingOptions} from '../dist/wording-options.mjs';
import {mountSingleEditor} from '../dist/single-editor.mjs';
import {validateSinglePayload} from '../dist/single-session.mjs';
import {readTextSource} from '../dist/text-source.mjs';
import editor from '../dist/text-editor.js';
import {docx} from './fixtures/text-fixture.mjs';
const source=(name,bytes)=>({name,data:Buffer.from(bytes).toString('base64')});
const until=async fn=>{for(let i=0;i<150;i++){if(fn())return;await delay(10);}assert.fail('UI did not settle');};
function setup(t,html='<main></main>'){
 const dom=new JSDOM(html,{url:'https://ctt.example/',pretendToBeVisual:true,runScripts:'outside-only'});Object.assign(globalThis,{window:dom.window,document:dom.window.document});window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const downloads=[],oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=b=>{downloads.push(b);return 'blob:wording';};URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=()=>{};
 t.after(()=>{dom.window.close();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;delete globalThis.window;delete globalThis.document;});return {dom,downloads};
}
test('wording alternatives respect case, Unicode boundaries, unknown terms and exact selections',()=>{
 assert.deepEqual(wordingOptions('Utilize',0,7),['Use','Make use of']);assert.deepEqual(wordingOptions('UTILIZE',0,7),['USE','MAKE USE OF']);
 assert.deepEqual(wordingOptions('in order to',0,11),['to']);
 for(const [text,start,end] of [['utilized',0,7],['éutilize',1,8],['utilize_name',0,7],['42',0,2],['€25',0,3],['OpenAI',0,6],['utilize\nnow',0,11],[' utilize ',0,9],['uTiLiZe',0,7],['useful',-1,3]])assert.deepEqual(wordingOptions(text,start,end),[],text);
});
test('TXT and Word apply exactly one replacement, keep the original, restore drafts and export undoable edits',async t=>{
 const {downloads}=setup(t),root=document.querySelector('main');
 for(const format of ['txt','docx']){
  const original='We utilize 25 units; utilize again.',src=source('sample.'+format,format==='txt'?original:docx([original]));let view=await mountSingleEditor(root,{source:src});
  try{
   await view.select('text:1');const field=root.querySelector('[data-edit-side="left"]');field.setSelectionRange(3,10);root.querySelector('[data-wording-open]').click();assert.equal(root.querySelector('[data-wording-apply]').disabled,false);
   assert.match(root.querySelector('.wording-preview').textContent,/utilize → use/);root.querySelector('[data-wording-apply]').click();assert.equal(field.value,'We use 25 units; utilize again.');assert.equal(view.drafts.right.text(),original);assert.equal(field.selectionStart,3);assert.equal(field.selectionEnd,6);
   const snapshot=validateSinglePayload({version:1,kind:'single-editor',source:src,sheet:null,delimiter:',',review:view.snapshot()});view.dispose();view=await mountSingleEditor(root,{source:src,restoredState:snapshot.review});
   const before=downloads.length;root.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length>before);const exported=await readTextSource(source('edited.'+format,new Uint8Array(await downloads.at(-1).arrayBuffer())));assert.equal(exported.blocks[0].text,'We use 25 units; utilize again.');
   root.querySelector('[aria-label="Undo edit"]').click();assert.equal(view.drafts.left.text(),original);
  }finally{view.dispose();}
 }
});
test('stale wording is blocked after selection changes, typing and paragraph switches',async t=>{
 setup(t);const root=document.querySelector('main'),view=await mountSingleEditor(root,{source:source('text.txt','utilize\nutilize')});t.after(()=>view.dispose());await view.select('text:1');const field=root.querySelector('[data-edit-side="left"]'),open=root.querySelector('[data-wording-open]'),apply=root.querySelector('[data-wording-apply]');
 field.setSelectionRange(0,7);open.click();field.setSelectionRange(0,3);apply.click();assert.equal(view.drafts.left.text(),'utilize\nutilize');assert.equal(apply.disabled,true);
 field.setSelectionRange(0,7);open.click();await view.select('text:2');assert.equal(apply.disabled,true);assert.equal(view.drafts.left.text(),'utilize\nutilize');
 field.setSelectionRange(0,7);open.click();field.value='utilized';field.dispatchEvent(new window.Event('input'));assert.equal(apply.disabled,true);
 // Typing and a subsequent suggested replacement must remain separate undo steps.
 field.setSelectionRange(0,8);open.click();apply.click();assert.equal(view.drafts.left.text(),'utilize\nused');root.querySelector('[aria-label="Undo edit"]').click();assert.equal(view.drafts.left.text(),'utilize\nutilized');root.querySelector('[aria-label="Undo edit"]').click();assert.equal(view.drafts.left.text(),'utilize\nutilize');
});
test('Edit & export opens pasted Unicode text through the real entry flow',async t=>{
 const {dom,downloads}=setup(t,await readFile(new URL('../dist/index.html',import.meta.url),'utf8'));Object.defineProperty(document,'currentScript',{value:{src:'https://ctt.example/single-entry.js'},configurable:true});
 const script=new Script(await readFile(new URL('../dist/single-entry.js',import.meta.url),'utf8'),{importModuleDynamically:specifier=>specifier.endsWith('single-session.mjs')?import('../dist/single-session.mjs'):import('../dist/single-editor.mjs')});script.runInContext(dom.getInternalVMContext());
 document.querySelector('[data-work-mode="single"]').click();document.getElementById('single-paste-text').value='We utilize 25 units.\nПривет 👋';document.getElementById('single-paste-open').click();await until(()=>document.querySelector('[data-save-side="left"]'));assert.equal(document.getElementById('single-current').textContent,'pasted-text.txt');
 document.querySelector('[data-save-side="left"]').click();await until(()=>downloads.length===1);assert.equal(await downloads[0].text(),'We utilize 25 units.\nПривет 👋\n');window.dispatchEvent(new window.Event('pagehide'));
});
