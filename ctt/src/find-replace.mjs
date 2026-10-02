const MAX_CHARS=500000;
export function findTextMatches(entries,query,matchCase=false){
 if(!query)return [];
 if(query.length>5000)throw Error('Search for a shorter phrase (up to 5,000 characters).');
 const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase?'gu':'giu'),matches=[],offsets=new Map();
 entries.forEach((entry,index)=>{const base=offsets.get(entry.key)||0;pattern.lastIndex=0;let match;while((match=pattern.exec(entry.text)))matches.push({index,key:entry.key,start:match.index,end:match.index+match[0].length,offset:base+match.index,record:entry.record});offsets.set(entry.key,base+entry.text.length+1);});
 return matches;
}
export function replacementPatches(entries,matches,replacement,{maxChars=MAX_CHARS,maxEntryChars=MAX_CHARS}={}){
 if(typeof replacement!=='string')throw Error('Enter replacement text.');
 const grouped=new Map();let size=entries.reduce((n,e)=>n+e.text.length,Math.max(0,entries.length-1));
 for(const match of matches){const entry=entries[match.index];if(!entry||match.start<0||match.end>entry.text.length||match.start>=match.end)throw Error('Search again before replacing.');size+=replacement.length-(match.end-match.start);if(!grouped.has(match.index))grouped.set(match.index,[]);grouped.get(match.index).push(match);}
 if(size>maxChars)throw Error('The replacement would make this document too large. Use shorter text.');
 return [...grouped].map(([index,hits])=>{const before=entries[index].text;if(before.length+hits.reduce((n,h)=>n+replacement.length-(h.end-h.start),0)>maxEntryChars)throw Error('The replacement would make a cell too long. Use shorter text.');let text='',position=0;for(const hit of hits){if(hit.start<position)throw Error('Search again before replacing.');text+=before.slice(position,hit.start)+replacement;position=hit.end;}return {index,key:entries[index].key,before,text:text+before.slice(position)};});
}
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
export function mountFindReplace(host,{single=false,getEntries,apply,undo,canUndo,jump,highlight,prepare=()=>{},limits,scopeHint='',showAddress=false}){
 const toggle=el('button','Find & replace');toggle.type='button';toggle.className='button secondary';toggle.setAttribute('aria-expanded','false');host.append(toggle);
 const panel=el('section');panel.className='find-replace-panel';panel.setAttribute('aria-label','Find and replace');panel.hidden=true;host.append(panel);if(scopeHint){const hint=el('p',scopeHint);hint.className='find-replace-notice';panel.append(hint);}
 const row=el('div');row.className='find-replace-fields';panel.append(row);
 const scope=el('select');scope.setAttribute('aria-label','Document to search');for(const [value,label]of [['left','Version A'],['right','Version B']]){const option=el('option',label);option.value=value;scope.append(option);}scope.value=single?'left':'right';scope.hidden=single;row.append(scope);
 const field=(caption,name)=>{const label=el('label',caption),input=el('input');input.type='text';input.setAttribute('aria-label',caption);input.dataset.findField=name;input.maxLength=500000;label.append(input);row.append(label);return input;};
 const query=field('Find','query'),replacement=field('Replace with','replacement');query.maxLength=5000;
 const caseLabel=el('label','Match case'),matchCase=el('input');matchCase.type='checkbox';caseLabel.prepend(matchCase);row.append(caseLabel);
 const actions=el('div');actions.className='find-replace-actions';panel.append(actions);
 const button=(label,fn)=>{const b=el('button',label);b.type='button';b.className='button secondary';b.addEventListener('click',fn);actions.append(b);return b;};
 const previous=button('Previous',()=>move(-1)),next=button('Next',()=>move(1)),replaceOne=button('Replace',()=>replace(false)),replaceAll=button('Replace all',()=>replace(true));
 const undoButton=button('Undo',()=>{if(busy)return;undo(scope.value);notice.textContent='Last change undone.';refresh();void reveal();});
 const count=el('span');count.className='find-replace-count';count.setAttribute('role','status');actions.append(count);button('Close',()=>close());
 const preview=el('p');preview.className='find-replace-preview';panel.append(preview);
 const notice=el('p');notice.className='find-replace-notice';notice.setAttribute('role','status');panel.append(notice);
 let matches=[],current=0,busy=false,disposed=false,generation=0;
 function selected(){return matches[current];}
 function paint(){
  const hit=selected(),entry=hit&&getEntries(scope.value)[hit.index];
  count.textContent=!query.value?'Enter text to find':!matches.length?'No matches':`${current+1} of ${matches.length}`;
  undoButton.disabled=busy||!canUndo(scope.value);previous.disabled=next.disabled=busy||matches.length<2;replaceOne.disabled=replaceAll.disabled=busy||!matches.length;
  preview.replaceChildren();preview.hidden=!hit;if(hit&&entry){const mark=el('mark',entry.text.slice(hit.start,hit.end));preview.append(document.createTextNode((showAddress?entry.key+' · ':'')+(hit.start>40?'…':'')+entry.text.slice(Math.max(0,hit.start-40),hit.start)),mark,document.createTextNode(entry.text.slice(hit.end,hit.end+60)+(hit.end+60<entry.text.length?'…':'')));}
  highlight(panel.hidden?[]:matches,scope.value,hit);
 }
 function refresh(){if(disposed||panel.hidden)return;const old=selected();try{matches=findTextMatches(getEntries(scope.value),query.value,matchCase.checked);}catch(error){matches=[];current=0;notice.textContent=error.message;paint();return;}if(old){const same=matches.findIndex(m=>m.index===old.index&&m.start===old.start);current=same<0?Math.min(current,Math.max(0,matches.length-1)):same;}else current=Math.min(current,Math.max(0,matches.length-1));paint();}
 async function reveal(focus=false){const hit=selected();if(!hit||disposed)return;const ticket=++generation;busy=true;paint();try{await jump(scope.value,hit,focus,()=>!disposed&&ticket===generation&&!panel.hidden);}catch(error){if(!disposed)notice.textContent=error.message;}finally{if(!disposed&&ticket===generation){busy=false;refresh();}}}
 function ready(){try{prepare();return true;}catch(error){generation++;busy=false;matches=[];current=0;notice.textContent=error.message;paint();return false;}}
 function search(){if(!ready())return;generation++;busy=false;current=0;matches=[];notice.textContent='';refresh();void reveal();}
 function move(delta){if(!ready())return;refresh();if(!matches.length)return;current=(current+delta+matches.length)%matches.length;void reveal(true);}
 async function replace(all){if(busy||disposed||!ready())return;refresh();const hit=selected();if(!hit)return;const entries=getEntries(scope.value),hits=all?matches:[hit];try{const patches=replacementPatches(entries,hits,replacement.value,limits),n=hits.length;apply(scope.value,patches);matches=findTextMatches(getEntries(scope.value),query.value,matchCase.checked);current=0;if(!all){const after=hit.start+replacement.value.length;const nextIndex=matches.findIndex(m=>m.index>hit.index||m.index===hit.index&&m.start>=after);current=nextIndex<0?0:nextIndex;}notice.textContent=`Replaced ${n} ${n===1?'match':'matches'}. Undo restores this change.`;paint();await reveal();}catch(error){notice.textContent=error.message;paint();}}
 function close(){generation++;busy=false;panel.hidden=true;toggle.setAttribute('aria-expanded','false');highlight([],scope.value);toggle.focus();}
 toggle.addEventListener('click',()=>{if(!panel.hidden){close();return;}panel.hidden=false;toggle.setAttribute('aria-expanded','true');if(ready())refresh();query.focus();});
 query.addEventListener('input',search);replacement.addEventListener('input',paint);matchCase.addEventListener('change',search);scope.addEventListener('change',search);
 panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}else if(event.key==='Enter'&&event.target===query){event.preventDefault();move(event.shiftKey?-1:1);}});
 return {refresh,dispose(){disposed=true;generation++;highlight([],scope.value);host.replaceChildren();}};
}
