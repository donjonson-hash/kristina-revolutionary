import {scanRepetitions,observationKey,validateStyleKept} from './repetition-scan.mjs';
// Optional, local observations about repeated syntax; never an authorship score.
const rules = [
  {id:'ru-contrast', label:'не …, а …', pattern:/(?<![\p{L}\p{N}\p{M}_])не(?![\p{L}\p{N}\p{M}_])[^\S\r\n\u2028\u2029]+[^.!?;\r\n\u2028\u2029,]{1,120},[^\S\r\n\u2028\u2029]*а(?![\p{L}\p{N}\p{M}_])[^\S\r\n\u2028\u2029]+(?=[^\s.!?;,])/giu},
  {id:'en-contrast', label:'not … but …', pattern:/(?<![\p{L}\p{N}\p{M}_'-])not(?![\p{L}\p{N}\p{M}_'-])(?![^\S\r\n\u2028\u2029]+only\b)[^\S\r\n\u2028\u2029]+[^.!?;\r\n\u2028\u2029,]{1,120}?,?[^\S\r\n\u2028\u2029]+but(?![\p{L}\p{N}\p{M}_'-])[^\S\r\n\u2028\u2029]+(?=[^\s.!?;,])/giu}
];
export function scanContrasts(entries) {
  const grouped = new Map();
  for (const entry of entries) grouped.set(entry.key, grouped.has(entry.key) ? grouped.get(entry.key)+'\n'+entry.text : entry.text);
  return rules.map(rule => {
    const hits=[];
    for (const [key,text] of grouped) {
      rule.pattern.lastIndex=0;
      for (const match of text.matchAll(rule.pattern)) {
        const start=match.index, after=start+match[0].length;
        const tail=text.slice(after,after+120).match(/^[^.!?;\r\n\u2028\u2029,]*/u)[0];
        const next=tail.search(/(?<![\p{L}\p{N}\p{M}_'-])(?:не|not)(?![\p{L}\p{N}\p{M}_'-])/iu);
        const end=after+(next<0?tail:tail.slice(0,next)).trimEnd().length;
        hits.push({key,text,start,end});
      }
    }
    return {id:rule.id,label:rule.label,hits};
  }).filter(group=>group.hits.length>=2);
}
export function scanStyle(entries) {
 const repeated=scanRepetitions(entries),groups=scanContrasts(entries);
 for(const group of groups){group.kind='contrast';group.explanation='This contrast construction occurs more than once. Keep it intentionally or edit a passage.';
  for(const hit of group.hits)hit.context=repeated.sentences.find(s=>s.key===hit.key&&s.start<=hit.start&&s.end>=hit.end)?.context||hit.text;
 }
 groups.push(...repeated.groups);groups.partial=repeated.partial;return groups;
}
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
export function mountStyleReview(host,{entries,revision,choose,kept:restored,onChange=()=>{}}) {
 const kept=new Set(validateStyleKept(restored));
 const panel=el('section');panel.className='wording-review';panel.dataset.styleReview='';panel.setAttribute('aria-label','Style observations');
 const title=el('h3','Style observations');title.tabIndex=-1;
 const status=el('p');status.setAttribute('role','status');
 const content=el('div'),hint=el('p','Local checks for repeated phrases, sentence openings and “не …, а …” / “not … but …”. Repeats may be intentional. This check does not determine AI authorship.');hint.className='hint';
 panel.append(title,status,content,hint);host.append(panel);
 let seen=-1,disposed=false,timer=null;
 function render() {
  if(disposed||seen===revision())return;
  const current=revision();seen=current;content.replaceChildren();
  const groups=scanStyle(entries()),active=new Set(groups.map(observationKey));
  for(const key of kept)if(!active.has(key))kept.delete(key);
  status.textContent=(groups.length?'Review repeated wording. Keep it or edit individual passages. Choices are saved with your draft and reset when a related passage changes.':'No repeated wording found by these checks. Other aspects of style have not been checked.')+(groups.partial?' Phrase and opening checks cover only the first 20,000 words.':'');
  let groupCount=0;
  const moreGroups=el('button','Show more observations');moreGroups.type='button';moreGroups.className='button secondary';
  function showGroups(){
   for(const group of groups.slice(groupCount,groupCount+20)){
    const identity=observationKey(group),section=el('section');section.dataset.styleKind=group.kind;
    const heading=el('h4',`${group.kind==='opening'?'Sentence opening':group.kind==='phrase'?'Repeated phrase':'Repeated construction'}: “${group.label}” — ${group.hits.length} occurrences`),list=el('ol');
    const keep=el('button');keep.type='button';keep.className='button secondary';keep.dataset.styleKeep='';
    section.append(heading,el('p',group.explanation),keep,list);content.insertBefore(section,moreGroups);
    let shown=0;
    const more=el('button','Show more occurrences');more.type='button';more.className='button secondary';more.dataset.styleMore='';
    function paintKeep(){const accepted=kept.has(identity);keep.setAttribute('aria-pressed',String(accepted));keep.textContent=accepted?'Pattern kept — review again':'Keep this pattern';list.hidden=accepted;more.hidden=accepted||shown===group.hits.length;}
    keep.addEventListener('click',()=>{if(disposed)return;if(revision()!==current){render();return;}if(kept.has(identity))kept.delete(identity);else kept.add(identity);paintKeep();onChange();});
    function showMore(){
     const next=Math.min(shown+20,group.hits.length);
     for(const hit of group.hits.slice(shown,next)){
      const row=el('li'),preview=el('p');preview.append(document.createTextNode((hit.start>35?'…':'')+hit.text.slice(Math.max(0,hit.start-35),hit.start)),el('mark',hit.text.slice(hit.start,hit.end)),document.createTextNode(hit.text.slice(hit.end,hit.end+35)+(hit.end+35<hit.text.length?'…':'')));
      const edit=el('button','Edit this passage');edit.type='button';edit.className='button secondary';edit.dataset.styleEdit='';
      edit.addEventListener('click',async()=>{if(disposed)return;if(revision()!==current){render();status.textContent='Text changed. Choose an updated passage.';return;}edit.disabled=true;try{await choose(hit,current);}catch(error){if(!disposed)status.textContent=error.message;}finally{if(!disposed&&edit.isConnected)edit.disabled=false;}});
      row.append(preview,edit);list.append(row);
     }
     shown=next;paintKeep();
    }
    more.addEventListener('click',()=>{if(disposed)return;if(revision()!==current){render();return;}showMore();});section.append(more);showMore();
   }
   groupCount+=20;moreGroups.hidden=groupCount>=groups.length;
  }
  moreGroups.addEventListener('click',()=>{if(disposed)return;if(revision()!==current){render();return;}showGroups();});content.append(moreGroups);showGroups();
 }
 function refresh(){clearTimeout(timer);if(seen<0)render();else if(seen!==revision())timer=setTimeout(render,150);}
 refresh();return {refresh,snapshot(){render();return [...kept];},dispose(){disposed=true;clearTimeout(timer);panel.remove();}};
}
