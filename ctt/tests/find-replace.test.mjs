import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findTextMatches,replacementPatches} from '../dist/find-replace.mjs';
import editor from '../dist/text-editor.js';
test('literal Unicode search and replacement retain offsets and never interpret replacement dollars',()=>{
 const entries=[{key:'one',text:'😀 Анна анна [a].* $&'},{key:'one',text:'Анна'}];
 const hits=findTextMatches(entries,'анна');assert.equal(hits.length,3);assert.equal(hits[0].start,3);assert.equal(hits[2].offset,entries[0].text.length+1);assert.equal(findTextMatches(entries,'Анна',true).length,2);assert.equal(findTextMatches(entries,'[a].*').length,1);assert.equal(findTextMatches(entries,'').length,0);assert.throws(()=>findTextMatches(entries,'a'.repeat(50001)),/shorter phrase/);
 assert.equal(replacementPatches(entries,[hits[0]],'$& $1')[0].text,'😀 $& $1 анна [a].* $&');assert.equal(replacementPatches(entries,hits,'')[0].text,'😀   [a].* $&');assert.throws(()=>replacementPatches(entries,hits,'x'.repeat(200000)),/too large/);
});
test('batch edits preserve multi-entry groups and PDF boxes with one atomic undo',()=>{
 const a={record:1,text:'Alice'},b={record:2,text:'Alice'},c={record:3,text:'Alice'},group={record:1,text:'Alice\nAlice',source_blocks:[a,b]};
 const report={kind:'text',status:'complete',sources:{left:{format:'pdf'},right:{format:'pdf'}},matched:[{key:'text:1',left:group,right:group},{key:'text:3',left:c,right:c}]},draft=editor.create(report,'left');draft.replaceBlock('text:3','Alice',{width:100,height:30,fontSize:12});
 const before=draft.snapshot(),entries=draft.entries();draft.updateTexts(replacementPatches(entries,findTextMatches(entries,'Alice'),'Bob'));const after=draft.snapshot();assert.equal(after.history.length,before.history.length+1);assert.deepEqual(after.entries.map(e=>e.record),[1,2,3]);assert.deepEqual(after.entries[2].pdfBox,before.entries[2].pdfBox);assert.ok(after.entries.every(e=>e.text==='Bob'));
 const resumed=editor.create(report,'left');resumed.restore(after);resumed.undo();assert.deepEqual(resumed.entries(),before.entries);
 assert.throws(()=>draft.updateTexts([{index:0,before:'Bob',text:'x'.repeat(500001)}]),/too large/);assert.deepEqual(draft.snapshot(),after);assert.throws(()=>draft.updateTexts([{index:0,before:'Alice',text:'Wrong'}]),/changed/);assert.deepEqual(draft.snapshot(),after);
});
