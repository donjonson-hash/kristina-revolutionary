/** Small, curated English phrasebook. No model, network, or provenance scoring. */
const phrases=Object.freeze({
 'utilize':['use','make use of'], 'utilizes':['uses','makes use of'], 'utilized':['used','made use of'], 'utilizing':['using','making use of'],
 'commence':['start','begin'], 'commences':['starts','begins'], 'commenced':['started','began'],
 'assist':['help','support'], 'assistance':['help','support'], 'obtain':['get','acquire'], 'provide':['give','supply'],
 'additional':['extra','further'], 'numerous':['many','a large number of'], 'sufficient':['enough','adequate'],
 'approximately':['about','roughly'], 'frequently':['often','regularly'], 'currently':['now','at present'],
 'subsequently':['later','afterward'], 'however':['but','nevertheless'], 'therefore':['so','consequently'],
 'furthermore':['also','in addition'], 'moreover':['also','furthermore'], 'important':['significant','notable'],
 'improve':['enhance','make better'], 'reduce':['decrease','cut'], 'increase':['raise','boost'],
 'demonstrate':['show','illustrate'], 'indicate':['show','suggest'], 'require':['need','call for'],
 'enable':['allow','make possible'], 'ensure':['make sure','guarantee'], 'evaluate':['assess','review'],
 'purchase':['buy','acquire'], 'choose':['select','pick'], 'difficult':['hard','challenging'],
 'simple':['straightforward','easy'], 'clear':['plain','understandable'], 'fast':['quick','rapid'],
 'in order to':['to'], 'due to the fact that':['because'], 'at this point in time':['now','currently'],
 'in the event that':['if'], 'prior to':['before'], 'subsequent to':['after'], 'with regard to':['about','regarding'],
 'in relation to':['about','concerning'], 'a large number of':['many','numerous'], 'a small number of':['few'],
 'on a daily basis':['daily','every day'], 'on a regular basis':['regularly'], 'at the present time':['now','currently'],
 'for the purpose of':['for'], 'has the ability to':['can','is able to'], 'is able to':['can'],
 'take into consideration':['consider','take into account'], 'make a decision':['decide'], 'make an attempt':['try','attempt'],
 'reach a conclusion':['conclude'], 'in addition':['also','furthermore'], 'as a result':['consequently','therefore'],
 'in my opinion':['I think','I believe'], 'please be advised that':['please note that'],
});
const wordChar=c=>!!c&&/[\p{L}\p{N}\p{M}_'-]/u.test(c);
export function wordingOptions(text,start,end){
 if(typeof text!=='string'||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>text.length||end<=start||end-start>100)return [];
 if(wordChar(text[start-1])||wordChar(text[end]))return [];
 const selected=text.slice(start,end);if(selected.trim()!==selected||! /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(selected))return [];
 const lower=selected.toLowerCase(),variants=phrases[lower]||[];
 const upper=selected===selected.toUpperCase(),title=selected===lower[0].toUpperCase()+lower.slice(1);
 if(selected!==lower&&!upper&&!title)return [];
 return variants.map(s=>upper?s.toUpperCase():title?s[0].toUpperCase()+s.slice(1):s);
}
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function mountWordingOptions(host,{field,context,apply}){
 const toggle=el('button','Wording options');toggle.type='button';toggle.className='button secondary';toggle.dataset.wordingOpen='';toggle.setAttribute('aria-expanded','false');
 const panel=el('section');panel.className='wording-panel';panel.hidden=true;panel.setAttribute('aria-label','Wording options');
 const hint=el('p','Select a whole English word or short phrase in Selected text, then choose Wording options. Built-in suggestions cover common expressions and do not evaluate context. Check the meaning before applying.');
 const choices=el('select');choices.setAttribute('aria-label','Suggested wording');const preview=el('p');preview.className='wording-preview';
 const accept=el('button','Apply replacement');accept.type='button';accept.className='button primary';accept.dataset.wordingApply='';
 const close=el('button','Close');close.type='button';close.className='button secondary';const status=el('p');status.setAttribute('role','status');
 const actions=el('div');actions.className='wording-actions';actions.append(accept,close);panel.append(hint,choices,preview,actions,status);host.append(toggle,panel);
 let saved=null,disposed=false;
 function valid(){const current=context();return saved&&!field.disabled&&current.key===saved.key&&current.revision===saved.revision&&field.value===saved.text&&field.selectionStart===saved.start&&field.selectionEnd===saved.end;}
 function paint(){preview.replaceChildren();if(!saved||!choices.value)return;preview.append(el('del',saved.text.slice(saved.start,saved.end)),document.createTextNode(' → '),el('ins',choices.value));}
 function refresh(){if(disposed)return;toggle.disabled=field.disabled||!context().key;if(!panel.hidden&&saved&&!valid()){saved=null;accept.disabled=true;choices.disabled=true;status.textContent='Text or selection changed. Select the phrase and open Wording options again.';}}
 toggle.addEventListener('click',()=>{
  panel.hidden=false;toggle.setAttribute('aria-expanded','true');const start=field.selectionStart,end=field.selectionEnd,options=wordingOptions(field.value,start,end);choices.replaceChildren();
  saved={...context(),text:field.value,start,end};for(const text of options){const option=el('option',text);option.value=text;choices.append(option);}
  accept.disabled=choices.disabled=!options.length;status.textContent=options.length?'Review the replacement, then apply it. Undo restores this change.':'No built-in alternatives for this selection. Try a common English word or phrase, such as “utilize” or “in order to”.';paint();
 });
 choices.addEventListener('change',paint);
 accept.addEventListener('click',()=>{
  if(!valid()){refresh();return;}if(accept.disabled||!choices.value)return;
  const current=saved,replacement=choices.value,next=current.text.slice(0,current.start)+replacement+current.text.slice(current.end);
  try{apply(next);saved=null;accept.disabled=true;choices.disabled=true;field.focus({preventScroll:true});field.setSelectionRange(current.start,current.start+replacement.length);status.textContent='Replacement applied. Use Undo edit to restore it.';}
  catch(error){status.textContent=error.message;refresh();}
 });
 close.addEventListener('click',()=>{panel.hidden=true;saved=null;toggle.setAttribute('aria-expanded','false');field.focus({preventScroll:true});});
 const events=['input','select','keyup','mouseup'];for(const event of events)field.addEventListener(event,refresh);
 panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close.click();}});
 return {refresh,open:()=>toggle.click(),dispose(){disposed=true;for(const event of events)field.removeEventListener(event,refresh);panel.remove();toggle.remove();}};
}

// Group offsets match the text shown in the selected-text editor, including
// multiple source blocks belonging to one comparison group.
export function scanWording(entries,limit=50){
 const grouped=new Map();for(const entry of entries){const previous=grouped.get(entry.key);grouped.set(entry.key,previous===undefined?entry.text:previous+'\n'+entry.text);}
 const pattern=new RegExp(Object.keys(phrases).sort((a,b)=>b.length-a.length).join('|'),'giu'),hits=[];
 for(const [key,text] of grouped){pattern.lastIndex=0;let match;while((match=pattern.exec(text))){const start=match.index,end=start+match[0].length,options=wordingOptions(text,start,end);if(!options.length)continue;hits.push({key,text,start,end,options});if(hits.length>=limit)return hits;}}
 return hits;
}
export function mountWordingReview(host,{entries,revision,choose}){
 const panel=el('section');panel.className='wording-review';panel.dataset.wordingReview='';panel.setAttribute('aria-label','Available wording options');
 const title=el('h3','Available wording options');title.tabIndex=-1;const status=el('p');status.setAttribute('role','status');const list=el('ol');const hint=el('p','Local English phrasebook only. These are optional alternatives, not corrections. Whole-sentence rewriting and context analysis are not available.');hint.className='hint';panel.append(title,status,list,hint);host.append(panel);
 let seen=-1,disposed=false,timer=null;
 function render(){if(disposed)return;const current=revision();if(current===seen)return;seen=current;const hits=scanWording(entries(),51);list.replaceChildren();
  status.textContent=!hits.length?'No built-in alternatives found in this text. You can edit it manually; the local phrasebook cannot suggest changes for every text.':hits.length>50?'Showing the first 50 matching expressions. Choose one to review its alternatives.':`${hits.length} matching ${hits.length===1?'expression':'expressions'}. Choose one to review its alternatives.`;
  for(const hit of hits.slice(0,50)){const row=el('li'),preview=el('p');preview.append(document.createTextNode((hit.start>45?'…':'')+hit.text.slice(Math.max(0,hit.start-45),hit.start)),el('mark',hit.text.slice(hit.start,hit.end)),document.createTextNode(hit.text.slice(hit.end,hit.end+60)+(hit.end+60<hit.text.length?'…':'')));
   const button=el('button',`Review “${hit.text.slice(hit.start,hit.end)}”`);button.type='button';button.className='button secondary';button.dataset.wordingReviewHit='';button.addEventListener('click',async()=>{if(disposed)return;if(revision()!==current){render();status.textContent='Text changed. Choose an updated suggestion.';return;}button.disabled=true;try{await choose(hit,current);}catch(error){if(!disposed)status.textContent=error.message;}finally{if(!disposed&&button.isConnected)button.disabled=false;}});row.append(preview,button);list.append(row);
  }
 }
 function refresh(){clearTimeout(timer);if(seen<0)render();else if(seen!==revision())timer=setTimeout(render,150);}
 refresh();return {refresh,dispose(){disposed=true;clearTimeout(timer);panel.remove();}};
}
