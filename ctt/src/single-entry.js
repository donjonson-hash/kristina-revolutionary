/* Independent local draft; switching modes retains both workspaces. */
(() => {
 const $=id=>document.getElementById(id),moduleURL=new URL('single-editor.mjs',document.currentScript.src),sessionURL=new URL('single-session.mjs',document.currentScript.src);
 let controller=null,view=null,generation=0,candidate=null,busy=false,operating=false,session=null;
 const note=(text,error=false)=>{const notice=$('single-notice');notice.classList.toggle('error',error);notice.setAttribute('role',error?'alert':'status');notice.setAttribute('aria-live',error?'assertive':'polite');notice.textContent=text;notice.hidden=!text;};
 function chooseMode(next){
  document.body.classList.toggle('single-mode',next==='single');$('single-workspace').hidden=next!=='single';$('compare-workspace').hidden=next!=='compare';
  for(const button of document.querySelectorAll('[data-work-mode]'))button.setAttribute('aria-pressed',String(button.dataset.workMode===next));if(next==='single')view?.restoreViewport?.();
 }
 function controls(){ $('single-open').disabled=$('single-file').disabled=busy||operating;if($('single-paste-open'))$('single-paste-open').disabled=busy||operating;$('single-editor-host').inert=busy||operating; }
 function setBusy(value){busy=value;session?.setBusy(value);controls();}
 function closeDocument(){
  generation++;controller?.abort();view?.dispose();controller=null;view=null;candidate=null;
  $('single-editor-host').replaceChildren();$('single-options').hidden=true;$('single-current').textContent='';$('single-current').hidden=true;note('');
 }
 const ready=import(sessionURL.href).then(({mountSingleSession})=>mountSingleSession($('single-session'),{
  onResume:async payload=>{await install(payload,true);chooseMode('single');},onFinish:closeDocument,
  onOperating:value=>{operating=value;if(value)generation++;controls();}
 })).then(ui=>{session=ui;session.setBusy(busy);return ui;}).catch(()=>{note('Automatic saving is unavailable. Download your edits before closing this tab.',true);return null;});
 document.querySelectorAll('[data-work-mode]').forEach(button=>button.addEventListener('click',()=>chooseMode(button.dataset.workMode)));
 async function install(payload,resuming=false){
  const ticket=++generation,abort=new AbortController(),stage=document.createElement('div');let next;setBusy(true);note(resuming?'Restoring your document…':'Opening your document…');
  try{
   const {mountSingleEditor}=await import(moduleURL.href);
   next=await mountSingleEditor(stage,{source:payload.source,sheet:payload.sheet,delimiter:payload.delimiter,restoredState:resuming?payload.review:undefined,signal:abort.signal,onStateChange:()=>{if(view===next)session?.changed();}});
   if(ticket!==generation){abort.abort();next.dispose();return;}
   await session?.flush();if(ticket!==generation){abort.abort();next.dispose();return;}
   controller?.abort();view?.dispose();controller=abort;view=next;$('single-editor-host').replaceChildren(stage);$('single-options').hidden=true;
   $('single-current').textContent=payload.source.name;$('single-current').hidden=false;note('');
   // Bind to the opened file, never the candidate for a later replacement.
   const {source,sheet,delimiter}=payload;
   session?.activate(()=>({version:1,kind:'single-editor',source,sheet:sheet||null,delimiter,review:next.snapshot()}));
  }catch(error){abort.abort();next?.dispose();if(ticket===generation)note(error.message,true);if(resuming)throw error;}
  finally{if(ticket===generation)setBusy(false);}
 }
 async function open(){
  await ready;if(!candidate||busy||operating)return;
  if((view?.changed||session?.hasSavedWork)&&!window.confirm('Replace this document and its saved draft? Download it first if you want to keep a separate copy.'))return;
  await install({source:candidate,sheet:$('single-sheet').value||null,delimiter:$('single-delimiter').value});
 }
 async function load(file){
  if(!file||busy||operating)return;const ticket=++generation;candidate=null;$('single-options').hidden=true;setBusy(true);
  try{
   if(file.size>2097152)throw Error('Choose a file up to 2 MB.');note('Reading your file…');
   const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   const source={name:file.name,data:btoa(binary)},{inspectSingleSource}=await import(moduleURL.href),info=await inspectSingleSource(source);if(ticket!==generation)return;candidate=source;
   $('single-sheet-label').hidden=info.format!=='xlsx';$('single-delimiter-label').hidden=!['csv','tsv'].includes(info.format);
   $('single-sheet').replaceChildren();for(const name of info.sheets||[]){const option=document.createElement('option');option.value=option.textContent=name;$('single-sheet').append(option);}
   $('single-delimiter').value=info.delimiter||',';note('');setBusy(false);
   if(info.format==='docx'||info.format==='pdf'||info.format==='txt'){await open();}else{$('single-options').hidden=false;$('single-pending').textContent=source.name;}
  }catch(error){if(ticket===generation)note(error.message,true);}
  finally{if(ticket===generation)setBusy(false);}
 }
 $('single-paste-open')?.addEventListener('click',()=>{const text=$('single-paste-text').value;if(!text.trim()){note('Paste some text first.',true);return;}const bytes=new TextEncoder().encode(text);void load({name:'pasted-text.txt',size:bytes.length,arrayBuffer:async()=>bytes.buffer});});
 $('single-file').addEventListener('change',event=>{void load(event.target.files[0]);event.target.value='';});
 const drop=$('single-drop');drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('is-dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));
 drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('is-dragging');void load(e.dataTransfer.files[0]);});$('single-open').addEventListener('click',()=>void open());
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&view)session?.changed();});
 window.addEventListener('beforeunload',e=>{if(view?.changed&&!session?.saved){e.preventDefault();e.returnValue='';}});
 window.addEventListener('pagehide',event=>{if(!event.persisted){session?.changed();const saving=session?.flush();controller?.abort();view?.dispose();void Promise.resolve(saving).finally(()=>session?.dispose());}});
})();
