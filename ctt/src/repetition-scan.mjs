// Exact local repeats, not semantic similarity or an assessment of authorship.
const stop=new Set('a an the and or but of to in on at for with from by is are was were be it its this that these those as if not only he she they we you i his her their our your и а но или в во на к ко с со у о об от до из по за для не ни же бы ли это то как он она они мы вы я его ее её их наш ваш'.split(' '));
const word=/[\p{L}][\p{L}\p{M}]*(?:['’\-][\p{L}\p{M}]+)*/gu;
const norm=s=>s.normalize('NFC').toLowerCase().replaceAll('’',"'");
export function groupedText(entries){const map=new Map();for(const {key,text} of entries)map.set(key,map.has(key)?map.get(key)+'\n'+text:text);return map;}
export function sentences(entries,limit=20000){
 const result=[];let total=0,partial=false;
 outer:for(const [key,text] of groupedText(entries)){
  const segmenter=new Intl.Segmenter(/[А-Яа-яЁё]/u.test(text)?'ru':'en',{granularity:'sentence'});
  for(const line of text.matchAll(/[^\r\n\u2028\u2029]+/gu))for(const segment of segmenter.segment(line[0])){
   const offset=line.index+segment.index,context=segment.segment.trim();
   const tokens=[];for(const m of segment.segment.matchAll(word)){
    const start=offset+m.index,end=start+m[0].length;
    // Do not extract words from identifiers, URLs, or number-bearing tokens.
    if(/[\p{L}\p{M}\p{N}_/@#.:\-]/u.test(text[start-1]||' ')||/[\p{L}\p{M}\p{N}_/@#:\-]/u.test(text[end]||' '))continue;
    if(total++>=limit){partial=true;break outer;}
    tokens.push({start,end,value:norm(m[0])});
   }
   if(tokens.length)result.push({key,text,context,tokens,index:result.length,start:offset,end:offset+segment.segment.length});
  }
 }
 return {items:result,partial};
}
function clusters(hits,minimum,gap=2){
 const out=[];let current=[];
 for(const hit of hits){if(current.length&&hit.sentence-current.at(-1).sentence>gap){if(new Set(current.map(h=>h.sentence)).size>=minimum)out.push(current);current=[];}current.push(hit);}
 if(new Set(current.map(h=>h.sentence)).size>=minimum)out.push(current);return out;
}
export function scanRepetitions(entries){
 const {items,partial}=sentences(entries),phrases=new Map(),openings=new Map();
 function add(map,name,hit){if(!map.has(name))map.set(name,[]);map.get(name).push(hit);}
 for(const s of items){
  const {tokens}=s;
  for(let i=0;i<tokens.length;i++)for(let n=2;n<=5&&i+n<=tokens.length;n++){
   const selected=tokens.slice(i,i+n);if(selected.every(t=>stop.has(t.value)))continue;
   if(selected.some((t,j)=>j&& !/^\s+$/u.test(s.text.slice(selected[j-1].end,t.start))))continue;
   const name=selected.map(t=>t.value).join(' '),hit={key:s.key,text:s.text,start:selected[0].start,end:selected.at(-1).end,context:s.context,sentence:s.index,words:n};add(phrases,name,hit);
  }
  // Ignore sentence fragments whose first token was skipped as a URL/identifier.
  if(!/^[\s“”"'«»‘’—–-]*$/u.test(s.text.slice(s.start,tokens[0].start)))continue;
  for(let n=1;n<=3&&n<=tokens.length;n++){
   const selected=tokens.slice(0,n);if(n>1&&selected.every(t=>stop.has(t.value)))continue;
   if(selected.some((t,j)=>j&&!/^\s+$/u.test(s.text.slice(selected[j-1].end,t.start))))continue;
   add(openings,selected.map(t=>t.value).join(' '),{key:s.key,text:s.text,start:tokens[0].start,end:selected.at(-1).end,context:s.context,sentence:s.index,words:n});
  }
 }
 const candidates=[];
 for(const [kind,map] of [['opening',openings],['phrase',phrases]])for(const [label,hits] of map){
  const words=hits[0].words;for(const cluster of clusters(hits,kind==='opening'&&words===1?3:2,kind==='opening'?1:2))candidates.push({id:kind+':'+label,kind,label,words,hits:cluster,explanation:kind==='opening'?'Nearby sentences start with the same wording. Keep the rhythm or vary an opening.':'The same 2–5 words occur in nearby sentences. Consider shortening a repeat, rewording it, or keeping it.'});
 }
 // Prefer the longest span covering the same occurrences. Opening observations
 // also absorb duplicate phrase observations at those exact positions.
 candidates.sort((a,b)=>b.words-a.words||(a.kind==='opening'?-1:1));
 const accepted=[],coverage=new Map();
 for(const group of candidates){
  if(group.hits.every(h=>(coverage.get(h.sentence)||[]).some(c=>c.start<=h.start&&c.end>=h.end)))continue;
  accepted.push(group);for(const h of group.hits){if(!coverage.has(h.sentence))coverage.set(h.sentence,[]);coverage.get(h.sentence).push(h);}
 }
 accepted.sort((a,b)=>a.hits[0].sentence-b.hits[0].sentence||a.hits[0].start-b.hits[0].start);
 return {groups:accepted,partial,sentences:items};
}
// Compact, deterministic identity for saved editorial choices (not security).
export function observationKey(group){
 const value=JSON.stringify([group.id,group.hits.map(h=>[h.key,h.context||h.text])]);let a=2166136261,b=5381;
 for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}
 return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
export function validateStyleKept(value){if(value===undefined)return [];if(!Array.isArray(value)||value.length>10000||value.some(k=>typeof k!=='string'||! /^[a-f0-9]{16}$/.test(k)))throw Error("Couldn't restore saved style choices: invalid data.");return [...new Set(value)];}
