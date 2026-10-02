import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script,SyntheticModule} from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {JSDOM} from 'jsdom';
import {mountSingleSession,validateSinglePayload,openSingleSessionStore} from '../dist/single-session.mjs';
import {mountSingleEditor} from '../dist/single-editor.mjs';
import {read,write,utils} from '../dist/xlsx-vendor.mjs';
import editor from '../dist/text-editor.js';
const source=(name,data)=>({name,data:Buffer.from(data).toString('base64')});
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await delay(10);}assert.fail('Timed out');};
function memoryStore(){let row={token:null,payload:null},serial=0;return {read:async()=>structuredClone(row),async write(payload,token){if(token!==row.token)throw Object.assign(Error('conflict'),{code:'conflict'});row={token:String(++serial),payload:validateSinglePayload(payload)};return structuredClone(row);},async clear(token){if(token!==row.token)throw Object.assign(Error('conflict'),{code:'conflict'});row={token:String(++serial),payload:null};return structuredClone(row);},close(){}};}
function setup(t,html='<main></main>'){
 const dom=new JSDOM(html,{url:'https://ctt.example/',pretendToBeVisual:true,runScripts:'outside-only'});Object.assign(globalThis,{document:dom.window.document,window:dom.window});window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};window.confirm=()=>true;
 t.after(()=>{dom.window.close();delete globalThis.window;delete globalThis.document;});return dom;
}
async function entry(t,store){
 const dom=setup(t,await readFile(new URL('../dist/index.html',import.meta.url),'utf8')),ctx=dom.getInternalVMContext();Object.defineProperty(document,'currentScript',{value:{src:'https://ctt.example/single-entry.js'},configurable:true});
 const sessionModule=new SyntheticModule(['mountSingleSession'],function(){this.setExport('mountSingleSession',(root,options)=>mountSingleSession(root,{...options,openStore:async()=>store}));},{context:ctx});await sessionModule.link(()=>{});await sessionModule.evaluate();
 new Script(await readFile(new URL('../dist/single-entry.js',import.meta.url),'utf8'),{importModuleDynamically:specifier=>specifier.endsWith('single-session.mjs')?sessionModule:import('../dist/single-editor.mjs')}).runInContext(ctx);
 const $=id=>dom.window.document.getElementById(id);await until(()=>$('single-session-status'));
 const load=async(name,text)=>{const field=$('single-file');Object.defineProperty(field,'files',{value:[{name,size:Buffer.byteLength(text),arrayBuffer:async()=>new TextEncoder().encode(text).buffer}],configurable:true});field.dispatchEvent(new dom.window.Event('change'));};
 return {dom,$,load,async close(){dom.window.dispatchEvent(new dom.window.Event('pagehide'));await delay(25);dom.window.close();}};
}
test('real single workspace resumes CSV pending input on page two and deletes only its own draft',async t=>{
 const store=memoryStore(),first=await entry(t,store);first.dom.window.document.querySelector('[data-work-mode="single"]').click();await first.load('records.csv',Array.from({length:65},(_,i)=>`00${i};${i}`).join('\n'));await until(()=>!first.$('single-options').hidden);first.$('single-open').click();await until(()=>first.$('single-editor-host').querySelector('[data-cell="B1"]'));
 [...first.$('single-editor-host').querySelectorAll('button')].find(b=>b.textContent==='Next rows').click();first.$('single-editor-host').querySelector('[data-cell="B61"]').click();const input=first.$('single-editor-host').querySelector('[data-edit-side="left"]');input.value='unconfirmed value';input.dispatchEvent(new first.dom.window.Event('input'));await until(()=>/Saved in this browser/.test(first.$('single-session-status').textContent));await delay(10);
 const saved=(await store.read()).payload;assert.equal(saved.delimiter,';');assert.equal(saved.review.singleUi.value,'unconfirmed value');assert.equal(saved.review.singleUi.page,1);assert.equal(saved.review.singleUi.address,'B61');assert.equal(saved.review.drafts.left.patches.length,0);
 const beforeLeave=new first.dom.window.Event('beforeunload',{cancelable:true});first.dom.window.dispatchEvent(beforeLeave);assert.equal(beforeLeave.defaultPrevented,false,'Committed autosave does not warn on every departure');await first.close();
 const second=await entry(t,store);assert.match(second.$('single-session').textContent,/records.csv/);assert.equal(second.$('single-session-resume').textContent,'Continue editing');second.$('single-session-resume').click();await until(()=>second.$('single-editor-host').querySelector('[data-cell="B61"]'));assert.equal(second.$('single-workspace').hidden,false);assert.equal(second.$('single-editor-host').querySelector('[data-edit-side="left"]').value,'unconfirmed value');assert.equal(second.$('single-editor-host').querySelector('[data-cell="B61"]').textContent,'60');
 second.$('single-editor-host').querySelector('[data-sheet-undo]').click();await until(()=>/Saved in this browser/.test(second.$('single-session-status').textContent));await delay(10);assert.equal((await store.read()).payload.review.singleUi.value,'60');
 // A failed replacement cannot relabel or overwrite the active source.
 await second.load('invalid.docx','not a zip');await until(()=>/ZIP|archive|Word|DOCX/i.test(second.$('single-notice').textContent));assert.equal((await store.read()).payload.source.name,'records.csv');
 second.$('single-session-delete').click();await until(()=>second.$('single-editor-host').children.length===0);assert.equal((await store.read()).payload,null);assert.equal(second.$('single-session').hidden,true);await second.close();assert.equal((await store.read()).payload,null);
});
test('XLSX saves an unfinished number and selected sheet, then exports corrections after restore',async t=>{
 const dom=setup(t),root=document.querySelector('main'),book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Untouched'],[{t:'n',v:4,f:'2+2'}]]),'Other');utils.book_append_sheet(book,utils.aoa_to_sheet([['Code','Value'],['001',12]]),'Orders');const src=source('book.xlsx',write(book,{type:'array',bookType:'xlsx',compression:true}));let changes=0;
 let view=await mountSingleEditor(root,{source:src,sheet:'Orders',onStateChange:()=>changes++});root.querySelector('[data-cell="B2"]').click();const field=root.querySelector('[data-edit-side="left"]');field.value='-';field.dispatchEvent(new window.Event('input'));assert.ok(changes>=2);
 const payload=validateSinglePayload({version:1,kind:'single-editor',source:src,sheet:'Orders',delimiter:',',review:view.snapshot()});assert.equal(payload.review.singleUi.type,'number');view.dispose();view=await mountSingleEditor(root,{source:payload.source,sheet:payload.sheet,delimiter:payload.delimiter,restoredState:payload.review});t.after(()=>view.dispose());assert.equal(root.querySelector('[data-edit-side="left"]').value,'-');assert.equal(root.querySelector('[data-cell="B2"]').textContent,'12');
 const longState=structuredClone(payload);longState.review.singleUi.value='x'.repeat(131073);validateSinglePayload(longState);const extra=document.createElement('div'),longView=await mountSingleEditor(extra,{source:src,sheet:'Orders',restoredState:longState.review});assert.equal(extra.querySelector('[data-edit-side="left"]').value.length,131073);longView.dispose();
 const downloads=[],oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=b=>{downloads.push(b);return 'blob:test';};URL.revokeObjectURL=()=>{};dom.window.HTMLAnchorElement.prototype.click=()=>{};t.after(()=>{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;});root.querySelector('[data-save-side="left"]').click();assert.equal(downloads.length,0);assert.match(root.textContent,/Enter a number/);
 root.querySelector('[data-edit-side="left"]').value='-24';root.querySelector('[data-save-side="left"]').click();assert.equal(downloads.length,1);const out=read(new Uint8Array(await downloads[0].arrayBuffer()),{type:'array'});assert.equal(out.Sheets.Orders.B2.v,-24);assert.equal(out.Sheets.Other.A2.f,'2+2');
});
test('Word restores added table rows, edited text, selection and undo history',async t=>{
 setup(t);const root=document.querySelector('main'),js=await readFile(new URL('../dist/document-demo.js',import.meta.url),'utf8'),src=JSON.parse(js.slice(js.indexOf('Object.freeze(')+14,js.lastIndexOf(');'))).right;
 let view=await mountSingleEditor(root,{source:src});[...root.querySelectorAll('.visual-column:not([hidden]) [data-group]')].find(n=>n.textContent==='Desk lamp').click();root.querySelector('[data-row-side="left"][data-insert-row="after"]').click();const field=root.querySelector('[data-edit-side="left"]');field.value='Added row after reopening';field.dispatchEvent(new window.Event('input'));const snapshot=view.snapshot();assert.ok(snapshot.drafts.left.entries.some(e=>e.record<0&&e.text==='Added row after reopening'));view.dispose();
 const payload=validateSinglePayload({version:1,kind:'single-editor',source:src,sheet:null,delimiter:',',review:snapshot});view=await mountSingleEditor(root,{source:src,restoredState:payload.review});t.after(()=>view.dispose());assert.equal(root.querySelector('[data-edit-side="left"]').value,'Added row after reopening');assert.ok(view.drafts.left.entries().some(e=>e.text==='Added row after reopening'));assert.ok(view.drafts.left.canUndo);assert.ok(root.querySelector('img'));root.querySelector('[aria-label="Undo edit"]').click();assert.ok(!view.drafts.left.entries().some(e=>e.text==='Added row after reopening'));
});
test('single queue reports failure honestly, protects newer tabs and drains before delete',async t=>{
 setup(t);const base=memoryStore(),roots=[document.createElement('section'),document.createElement('section')];roots.forEach(r=>document.body.append(r));let fail=true,release;const store={...base,write:async(...args)=>{if(fail)throw Error('Storage full');return base.write(...args);}};
 const value={version:1,kind:'single-editor',source:source('one.csv','x'),sheet:null,delimiter:',',review:{kind:'sheet',version:1}};const a=await mountSingleSession(roots[0],{openStore:async()=>store,onResume:()=>{},onFinish:()=>{}}),b=await mountSingleSession(roots[1],{openStore:async()=>base,onResume:()=>{},onFinish:()=>{}});t.after(()=>{a.dispose();b.dispose();});a.activate(()=>value);await a.flush();assert.equal(a.saved,false);assert.match(roots[0].textContent,/Couldn't save/);fail=false;roots[0].querySelector('#single-session-retry').click();await until(()=>a.saved);assert.equal((await base.read()).payload.source.name,'one.csv');
 b.activate(()=>({...value,source:source('stale.csv','x')}));await b.flush();assert.equal(b.saved,false);assert.match(roots[1].textContent,/another tab/);roots[1].querySelector('#single-session-delete').click();await delay(10);assert.equal((await base.read()).payload.source.name,'one.csv');
 store.write=(...args)=>new Promise(resolve=>{release=async()=>resolve(await base.write(...args));});a.changed();roots[0].querySelector('#single-session-delete').click();await delay(10);assert.ok((await base.read()).payload);await release();await until(()=>roots[0].hidden);assert.equal((await base.read()).payload,null);
});
test('single store uses its own database and rejects incompatible or corrupt snapshots',async()=>{
 let name;await assert.rejects(()=>openSingleSessionStore({indexedDB:{open(value){name=value;throw Error('test blocked');}}}),/test blocked/);assert.equal(name,'ctt-single-editor-session');
 assert.throws(()=>validateSinglePayload({version:2}),e=>e.code==='incompatible');assert.throws(()=>validateSinglePayload({version:1,kind:'single-editor',source:{name:'x.pdf',data:''}}),e=>e.code==='invalid');
});
