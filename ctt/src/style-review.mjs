// Optional, local observations about repeated syntax; never an authorship score.
const rules = [
  {id:'ru-contrast', label:'не …, а …', pattern:/(?<![\p{L}\p{N}\p{M}_])не(?![\p{L}\p{N}\p{M}_])[^\S\r\n\u2028\u2029]+[^.!?;\r\n\u2028\u2029,]{1,120},[^\S\r\n\u2028\u2029]*а(?![\p{L}\p{N}\p{M}_])[^\S\r\n\u2028\u2029]+(?=[^\s.!?;,])/giu},
  {id:'en-contrast', label:'not … but …', pattern:/(?<![\p{L}\p{N}\p{M}_'-])not(?![\p{L}\p{N}\p{M}_'-])(?![^\S\r\n\u2028\u2029]+only\b)[^\S\r\n\u2028\u2029]+[^.!?;\r\n\u2028\u2029,]{1,120}?,?[^\S\r\n\u2028\u2029]+but(?![\p{L}\p{N}\p{M}_'-])[^\S\r\n\u2028\u2029]+(?=[^\s.!?;,])/giu}
];
export function scanStyle(entries) {
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
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
export function mountStyleReview(host,{entries,revision,choose}) {
  const panel=el('section');panel.className='wording-review';panel.dataset.styleReview='';panel.setAttribute('aria-label','Style observations');
  const title=el('h3','Style observations');title.tabIndex=-1;
  const status=el('p');status.setAttribute('role','status');
  const content=el('div'),hint=el('p','Local check for repeated “не …, а …” and “not … but …” constructions. These may be intentional. This check does not determine AI authorship.');hint.className='hint';
  panel.append(title,status,content,hint);host.append(panel);
  let seen=-1,disposed=false,timer=null;
  function render() {
    if(disposed || seen===revision())return;
    const current=revision();seen=current;content.replaceChildren();
    const groups=scanStyle(entries());
    status.textContent=groups.length?'Review repeated constructions. Keep them or edit individual passages. Choices last until the next text edit or reopening.':'No repeated constructions found by these two rules. Other aspects of style have not been checked.';
    for(const group of groups) {
      const section=el('section'),heading=el('h4',`“${group.label}” — ${group.hits.length} occurrences`),list=el('ol');
      const keep=el('button','Keep this pattern');keep.type='button';keep.className='button secondary';keep.dataset.styleKeep='';keep.setAttribute('aria-pressed','false');
      keep.addEventListener('click',()=>{if(disposed)return;if(revision()!==current){render();return;}const kept=keep.getAttribute('aria-pressed')!=='true';keep.setAttribute('aria-pressed',String(kept));keep.textContent=kept?'Pattern kept — review again':'Keep this pattern';list.hidden=kept;});
      section.append(heading,keep,list);content.append(section);
      let shown=0;
      const more=el('button','Show more occurrences');more.type='button';more.className='button secondary';more.dataset.styleMore='';
      function showMore() {
        const next=Math.min(shown+20,group.hits.length);
        for(const hit of group.hits.slice(shown,next)) {
          const row=el('li'),preview=el('p');preview.append(document.createTextNode((hit.start>35?'…':'')+hit.text.slice(Math.max(0,hit.start-35),hit.start)),el('mark',hit.text.slice(hit.start,hit.end)),document.createTextNode(hit.text.slice(hit.end,hit.end+35)+(hit.end+35<hit.text.length?'…':'')));
          const edit=el('button','Edit this passage');edit.type='button';edit.className='button secondary';edit.dataset.styleEdit='';
          edit.addEventListener('click',async()=>{if(disposed)return;if(revision()!==current){render();status.textContent='Text changed. Choose an updated passage.';return;}edit.disabled=true;try{await choose(hit,current);}catch(error){if(!disposed)status.textContent=error.message;}finally{if(!disposed&&edit.isConnected)edit.disabled=false;}});
          row.append(preview,edit);list.append(row);
        }
        shown=next;more.hidden=shown===group.hits.length;
      }
      more.addEventListener('click',()=>{if(disposed)return;if(revision()!==current){render();return;}showMore();});section.append(more);showMore();
      keep.addEventListener('click',()=>{more.hidden=list.hidden||shown===group.hits.length;});
    }
  }
  function refresh(){clearTimeout(timer);if(seen<0)render();else if(seen!==revision())timer=setTimeout(render,150);}
  refresh();return {refresh,dispose(){disposed=true;clearTimeout(timer);panel.remove();}};
}
