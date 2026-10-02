/** A final check always describes the current draft and exact review decisions. */
export function createFinalCheck(parent,{beforeCheck,onGo,scope,matchLabel='No differences in checked text.'}) {
 const make=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
 const check=make('button','Check again');check.type='button';check.className='button secondary';check.dataset.reviewAction='check';
 const panel=make('section');panel.className='final-check';panel.hidden=true;panel.dataset.checkState='idle';panel.setAttribute('aria-label','Final check');
 const result=make('strong');result.setAttribute('role','status');result.setAttribute('aria-live','polite');result.dataset.checkResult='';
 const hint=make('p'),go=make('button','Go to remaining differences');go.type='button';go.className='button secondary';go.dataset.reviewAction='remaining';go.hidden=true;
 const details=make('details'),summary=make('summary','What was checked');details.append(summary,make('p',scope));panel.append(result,hint,go,details);parent.append(check,panel);
 let current=[],queue,token=null,checkedToken=null;
 function dirty(){if(checkedToken===null)return;checkedToken=null;panel.hidden=false;panel.dataset.checkState='stale';result.textContent='Changes made. Check again.';hint.textContent='The previous result no longer describes the current versions.';go.hidden=true;}
 function update(items,nextQueue,revision){
  current=items;queue=nextQueue;
  const next=JSON.stringify([revision,items.map(i=>[i.key,i.differs,i.signature,nextQueue.reviewed(i.key)])]);
  if(token!==next)dirty();token=next;
 }
 check.addEventListener('click',()=>{
  if(beforeCheck()===false){dirty();return;}
  const differences=current.filter(i=>i.differs),pending=differences.filter(i=>!queue.reviewed(i.key)),kept=differences.length-pending.length;
  checkedToken=token;panel.hidden=false;panel.dataset.checkState=pending.length?'remaining':kept?'kept':'match';
  result.textContent=pending.length?`${pending.length} ${pending.length===1?'difference still needs':'differences still need'} review.`:kept?'Review complete. Your chosen differences were kept.':matchLabel;
  hint.textContent=pending.length?(kept?`${kept} other ${kept===1?'difference was':'differences were'} kept by your choice.`:'Open the remaining differences to edit them or keep B.'):(kept?`${kept} ${kept===1?'difference remains':'differences remain'} in your documents. You can download B below.`:'The current versions have been checked. You can download B below.');
  go.hidden=!pending.length;
 });
 go.addEventListener('click',()=>{if(checkedToken!==null)onGo();});
 return {update,dirty};
}
