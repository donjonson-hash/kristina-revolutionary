import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountSessionUI} from '../dist/session-ui.mjs';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const payload=text=>({sources:{left:{name:'A.docx'},right:{name:'B.docx'}},text});
async function harness(t,{write}={}) {
 const dom=new JSDOM('<main></main>'),previous=globalThis.document;globalThis.document=dom.window.document;
 const root=document.querySelector('main');let row={token:null,payload:null};const writes=[],clears=[],restored=[];
 const store={read:async()=>row,write:(value,token)=>{writes.push({value,token});return write?write(value,token):Promise.resolve(row={token:'saved-'+writes.length,payload:value});},clear:async token=>{clears.push(token);return row={token:'cleared',payload:null};},close(){}};
 const ui=await mountSessionUI(root,{openStore:async()=>store,onResume:value=>restored.push(value),onFinish:()=>{}});
 t.after(()=>{ui.dispose();dom.window.close();globalThis.document=previous;});
 return {dom,root,ui,store,writes,clears,restored,commit(value){row=value;return value;},status:()=>root.querySelector('#session-status').textContent};
}
// Controlled transaction completion tests the real autosave queue, not browser IndexedDB.
test('last edit made as a transaction completes is saved automatically and flush waits for it',async t=>{
 const first=deferred(),second=deferred();let call=0;
 const p=await harness(t,{write:()=>++call===1?first.promise:second.promise});let draft=payload('first');p.ui.activate(()=>draft);
 let flushed=false;const waiting=p.ui.flush().then(()=>{flushed=true;});
 first.resolve(p.commit({token:'first',payload:draft}));
 queueMicrotask(()=>{draft=payload('last keystroke');p.ui.changed();});
 await tick();
 assert.equal(p.writes.length,2,'The last keystroke must start saving without another edit or Retry');
 assert.equal(p.writes[1].value.text,'last keystroke');assert.equal(p.writes[1].token,'first');
 assert.equal(flushed,false,'flush must include the newly queued transaction');assert.match(p.status(),/Saving/);
 second.resolve(p.commit({token:'second',payload:draft}));await waiting;
 assert.match(p.status(),/Saved in this browser/);
 // Reopen the component against the same committed store and resume its saved work.
 p.ui.dispose();const reopened=document.createElement('section');document.body.append(reopened);
 const next=await mountSessionUI(reopened,{openStore:async()=>p.store,onResume:value=>p.restored.push(value),onFinish:()=>{}});t.after(()=>next.dispose());
 reopened.querySelector('#session-resume').click();await tick();assert.equal(p.restored[0].text,'last keystroke');
});
test('autosave failure retains the latest draft and retries only on request',async t=>{
 const first=deferred();let call=0;const p=await harness(t,{write:value=>++call===1?first.promise:Promise.resolve({token:'recovered',payload:value})});
 let draft=payload('old');p.ui.activate(()=>draft);draft=payload('newest');p.ui.changed();
 first.reject(Object.assign(new Error('Storage full'),{code:'quota'}));await p.ui.flush();await tick();
 assert.equal(p.writes.length,1,'A failed write must not enter an automatic retry loop');assert.match(p.status(),/Couldn't save/);
 p.root.querySelector('#session-retry').click();await tick();await p.ui.flush();assert.equal(p.writes.at(-1).value.text,'newest');assert.match(p.status(),/Saved/);
});
test('ending a session waits for its latest queued save before deleting it',async t=>{
 const first=deferred(),second=deferred();let call=0;const p=await harness(t,{write:()=>++call===1?first.promise:second.promise});
 let draft=payload('first');p.ui.activate(()=>draft);first.resolve(p.commit({token:'first',payload:draft}));
 queueMicrotask(()=>{draft=payload('latest');p.ui.changed();p.root.querySelector('#session-delete').click();});await tick();
 assert.equal(p.writes.length,2);assert.deepEqual(p.clears,[]);
 second.resolve(p.commit({token:'latest',payload:draft}));await tick();assert.deepEqual(p.clears,['latest']);assert.equal(p.root.hidden,true);assert.equal((await p.store.read()).payload,null);
});
