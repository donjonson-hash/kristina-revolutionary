import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function fixture(value = 'Hello world', start = 0, end = value.length) {
  const cache = new Map(), styles = [...value].flatMap(c => Array(c.length).fill({FONT_SIZE: 11, BOLD: false}));
  const state = {value, styles, tabId: 'tab-a', docId: 'doc-a', writes: 0, failStyle: false, paragraphStyle: {INDENT_START: 0}, before: [], after: []};
  const text = {
    getType: () => 'TEXT', asText() {return this;}, getParent: () => paragraph,
    getText: () => state.value,
    getTextAttributeIndices() {return state.styles.map((s,i) => i === 0 || JSON.stringify(s) !== JSON.stringify(state.styles[i-1]) ? i : -1).filter(i=>i>=0);},
    getLinkUrl: i => state.styles[i]?.LINK_URL || null,
    getAttributes: i => ({...state.styles[i]}),
    insertText(i, s) {state.writes++; state.value = state.value.slice(0,i)+s+state.value.slice(i); state.styles.splice(i,0,...Array(s.length).fill(state.styles[Math.max(0,i-1)]));},
    setAttributes(a,b,s) {if(state.failStyle) throw Error('API failure'); for(let i=a;i<=b;i++)state.styles[i]={...s};},
    deleteText(a,b) {state.writes++;state.value=state.value.slice(0,a)+state.value.slice(b+1);state.styles.splice(a,b-a+1);}
  };
  const paragraph = {getType:()=> 'PARAGRAPH',getParent:()=>body,getNumChildren:()=>1,getChild:()=>text,getAttributes:()=>state.paragraphStyle};
  const body = {getType:()=> 'BODY_SECTION',getChildIndex:()=>state.before.length,getNumChildren:()=>state.before.length+1+state.after.length,getChild:()=>paragraph, getText:()=>[...state.before,state.value,...state.after].join('\n')};
  const tab = {getId:()=>state.tabId,asDocumentTab:()=>({getBody:()=>body})};
  const doc = {getId:()=>state.docId,getActiveTab:()=>tab,getSelection:()=>({getRangeElements:()=>[
    {getElement:()=>text,isPartial:()=>true,getStartOffset:()=>start,getEndOffsetInclusive:()=>end-1}
  ]})};
  const context = vm.createContext({DocumentApp:{getActiveDocument:()=>doc,ElementType:{TEXT:'TEXT',PARAGRAPH:'PARAGRAPH',BODY_SECTION:'BODY_SECTION'}},
    CacheService:{getUserCache:()=>({put:(k,v)=>cache.set(k,v),get:k=>cache.get(k),remove:k=>cache.delete(k)})},
    LockService:{getDocumentLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(algorithm,value)=>Array.from(createHash(algorithm).update(value).digest()),getUuid:()=> '12345678-1234-1234-1234-123456789012',newBlob:s=>({getBytes:()=>Buffer.from(s)})},Date});
  vm.runInContext(source,context);
  return {context,state,cache};
}

test('partial replacement preserves all untouched formatting and consumes token',()=>{
  const {context:c,state:s}=fixture('One blue word',4,8);
  s.styles[0]={BOLD:true,FONT_SIZE:18}; s.styles[9]={ITALIC:true,FONT_SIZE:10};
  const snapshot=c.loadSelection();
  assert.equal(c.applyEdit(snapshot.token,'red').changed,true);
  assert.equal(s.value,'One red word');
  assert.equal(s.styles[0].BOLD,true); assert.equal(s.styles[8].ITALIC,true);
  assert.equal(s.styles[4].FONT_SIZE,11);
  assert.throws(()=>c.applyEdit(snapshot.token,'green'),/expired|already applied/);
});

test('stale paragraph text, run style, paragraph style, tab and document reject before writes',()=>{
  for(const mutate of [s=>s.value+='!',s=>s.styles[1]={BOLD:true},s=>s.paragraphStyle.INDENT_START=20,s=>s.tabId='other',s=>s.docId='other']) {
    const {context:c,state:s}=fixture();const {token}=c.loadSelection();mutate(s);
    assert.throws(()=>c.applyEdit(token,'Goodbye world'),/changed/);assert.equal(s.writes,0);
  }
});

test('mixed-style replacement rejects, pure deletion does not flatten remaining styles',()=>{
  const {context:c,state:s}=fixture('abcde');s.styles[2]={BOLD:true};
  const {token}=c.loadSelection();
  assert.throws(()=>c.applyEdit(token,'aXe'),/different text formatting/);assert.equal(s.writes,0);
  c.applyEdit(token,'ae');assert.equal(s.value,'ae');assert.equal(s.styles.length,2);
});

test('emoji replacement keeps surrogate pairs complete',()=>{
  const {context:c,state:s}=fixture('A😀B');const {token}=c.loadSelection();
  c.applyEdit(token,'A😁B');assert.equal(s.value,'A😁B');assert.equal(s.styles.length,4);
  const bad=fixture('A😀B',1,2);assert.throws(()=>bad.context.loadSelection(),/complete characters/);
});

test('invalid inputs, multiline, excessive length and malformed Unicode never mutate',()=>{
  for(const edited of ['a\nb','x'.repeat(4001),'\uD800',null]) {
    const {context:c,state:s}=fixture();const {token}=c.loadSelection();
    assert.throws(()=>c.applyEdit(token,edited),/one paragraph/);assert.equal(s.writes,0);
  }
});

test('cache eviction fails closed and supplied extra client offsets cannot change the target',()=>{
  const {context:c,state:s,cache}=fixture('Keep this',5,9);const {token}=c.loadSelection();
  c.applyEdit(token,'that',{start:0,end:9});assert.equal(s.value,'Keep that');
  const next=c.loadSelection();cache.clear();assert.throws(()=>c.applyEdit(next.token,'bad'),/expired/);
});

test('API failure after write reports possible partial edits and makes replay impossible',()=>{
  const {context:c,state:s}=fixture();const {token}=c.loadSelection();s.failStyle=true;
  assert.throws(()=>c.applyEdit(token,'Goodbye world'),/Some changes may have been applied/);
  assert.ok(s.writes>0);assert.throws(()=>c.applyEdit(token,'Goodbye world'),/expired|already applied/);
});

test('paragraphs containing links reject before edits and unchanged requests do not write',()=>{
  const a=fixture();a.state.styles[1]={LINK_URL:'https://example.org'};
  assert.throws(()=>a.context.loadSelection(),/hyperlinks/);
  const b=fixture();const {token}=b.context.loadSelection();
  assert.equal(b.context.applyEdit(token,b.state.value).changed,false);assert.equal(b.state.writes,0);
});


test('identical adjacent paragraph insertion or removal invalidates the old body position',()=>{
  for (const mutate of [s=>s.before.push(s.value),s=>s.before.pop()]) {
    const {context:c,state:s}=fixture();
    s.before.push(s.value);s.after.push(s.value);
    const {token}=c.loadSelection();
    // The old index still resolves to identical text/style, but is the wrong paragraph.
    mutate(s);
    assert.throws(()=>c.applyEdit(token,'Goodbye world'),/document body changed/);
    assert.equal(s.writes,0);
  }
});

test('an unrelated body edit invalidates the selection; oversized tabs fail closed',()=>{
  const {context:c,state:s}=fixture();s.after.push('Surrounding text');
  const {token}=c.loadSelection();s.after[0]='Changed surrounding text';
  assert.throws(()=>c.applyEdit(token,'Goodbye world'),/document body changed/);assert.equal(s.writes,0);
  for(const excess of [Array(1001).fill('x'),['x'.repeat(200001)]]) {
    const a=fixture();a.state.after=excess;
    assert.throws(()=>a.context.loadSelection(),/document tab is too large/);
    assert.equal(a.state.writes,0);
  }
});
