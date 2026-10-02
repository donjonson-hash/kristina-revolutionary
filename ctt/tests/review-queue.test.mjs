import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewQueue} from '../dist/review-queue.mjs';
const item=(key,signature,differs=true)=>({key,signature,differs});
test('kept differences are reviewed, edits reopen them, and returning to old text does not reaccept them',()=>{
 const q=createReviewQueue(['first','second']);q.sync([item('first','A/B'),item('second','X/Y')]);q.accept('first');
 assert.deepEqual(q.progress(),{total:2,reviewed:1,pending:1});assert.equal(q.next('first'),'second');
 const restored=createReviewQueue([],q.snapshot(true));restored.sync([item('first','A/B'),item('second','X/Y')]);assert.equal(restored.reviewed('first'),true);
 restored.sync([item('first','A/C'),item('second','X/Y')]);assert.equal(restored.reviewed('first'),false);
 restored.sync([item('first','A/B'),item('second','X/Y')]);assert.equal(restored.reviewed('first'),false);
});
test('resolved differences stay in total, new differences join, removed dynamic rows leave no stale queue',()=>{
 const q=createReviewQueue(['original']);q.sync([item('original','A/B')]);q.sync([item('original','A/A',false),item('new-cell','added')]);
 assert.deepEqual(q.progress(),{total:2,reviewed:1,pending:1});q.sync([item('original','A/A',false)]);assert.deepEqual(q.progress(),{total:1,reviewed:1,pending:0});
});
test('layout differences require their own decision even after all text decisions',()=>{
 const q=createReviewQueue(['text']);q.sync([item('text','A/B'),item('__document_structure__','layout-A/B')]);q.accept('text');
 assert.equal(q.next('text'),'__document_structure__');q.accept('__document_structure__');assert.equal(q.progress().pending,0);
 q.sync([item('text','A/B'),item('__document_structure__','new-layout')]);assert.equal(q.progress().pending,1);
 q.reset();assert.equal(q.progress().pending,2);
});
