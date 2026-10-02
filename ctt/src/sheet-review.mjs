import {sheetColumnWidth,sheetCellColors} from './sheet-display.mjs';
import {mountFindReplace} from './find-replace.mjs';
import {createFinalCheck} from './final-check.mjs';
import {openSheetDocument} from './sheet-document.mjs';
import {captureSheetPdf} from './sheet-pdf-model.mjs';
import {comparisonCellValue} from './xlsx-source.mjs';
import {utils,SSF} from './xlsx-vendor.mjs';
import {createReviewQueue} from './review-queue.mjs';
const sides=['left','right'],letter=s=>s==='left'?'A':'B',other=s=>s==='left'?'right':'left';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(text,fn,cls='button secondary')=>{const n=el('button',text,cls);n.type='button';n.addEventListener('click',fn);return n;};
const normalizeNumber=value=>{const m=/^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);if(!m)return value;const whole=m[2].replace(/^0+(?=\d)/,''),fraction=(m[3]||'').replace(/0+$/,'');return (m[1]==='-'&&!(whole==='0'&&!fraction)?'-':'')+whole+(fraction?'.'+fraction:'');};
export async function mountSheetReview(root,{report,sources,single=false,restoredState,signal,onStateChange=()=>{},onRevision=()=>{},onSelectionChange=()=>{},onExplain=()=>{}}){
 const docs=Object.fromEntries(await Promise.all(sides.map(async s=>[s,await openSheetDocument(sources[s],report.sources[s],report.rules.delimiter)])));
 let finder=null,pdfDialog=null,disposed=false,selected=null,started=false,added=Object.create(null),undo=[],rows=[];const pages={left:0,right:0},ui={},alive=()=>!disposed&&!signal?.aborted;
 const base= ['matched','changed','only_left','only_right'].flatMap(category=>(report[category]||[]).map((g,i)=>({key:g.key,left:g.left|| (category==='only_left'?g.row:null),right:g.right||(category==='only_right'?g.row:null)}))).sort((a,b)=>(a.left?.record??Infinity)-(b.left?.record??Infinity)||(a.right?.record??0)-(b.right?.record??0));
 const columns=Object.fromEntries(sides.map(s=>[s,report.sources[s].headers]));
 const col=(s,name)=>report.sources[s].header_cells?.[name] ? utils.decode_cell(report.sources[s].header_cells[name]).c : columns[s].indexOf(name);
 const mappings=[[...report.rules.key,'text'],...report.rules.fields];
 const recordOf=(row,s)=>row[s]?docs[s].mapRow(row[s].record-1)+1:added[row.key]?.[s];
 function address(row,s,name){const record=recordOf(row,s);return record?utils.encode_cell({r:record-1,c:col(s,name)}):null;}
 function tasks(){return rows.flatMap((row,i)=>{if(!(row.left||added[row.key]?.left)||!(row.right||added[row.key]?.right))return [{key:`r${i}`,row,kind:'row',names:report.rules.key}];return mappings.map((map,j)=>({key:`r${i}c${j}`,row,kind:'cell',names:map.slice(0,2),mode:map[2]}));});}
 function cellValue(s,addr,name){const cell=docs[s].get(addr);if(!docs[s].xlsx)return String(cell.v??'');try{return comparisonCellValue(cell,addr,!!docs[s].workbook.Workbook?.WBProps?.date1904,report.rules.key[s==='left'?0:1]===name);}catch{return String(cell.v??'');}}
 function value(task,s){if(task.kind==='row'){if(!(task.row[s]||added[task.row.key]?.[s]))return null;return JSON.stringify(columns[s].map(name=>cellValue(s,address(task.row,s,name),name)));}const name=task.names[s==='left'?0:1],a=address(task.row,s,name);return a?cellValue(s,a,name):null;}
 function signature(task,s){if(task.kind==='row')return [value(task,s),columns[s].map(name=>{const addr=address(task.row,s,name);return addr?docs[s].type(addr):null;})];const a=address(task.row,s,task.names[s==='left'?0:1]);return [value(task,s),a?docs[s].type(a):null];}
 function differs(t){let a=value(t,'left'),b=value(t,'right');if(report.rules.strip){a=a?.trim();b=b?.trim();}if(t.mode==='number'&&a!==null&&b!==null){a=normalizeNumber(a);b=normalizeNumber(b);}return a!==b;}
 rows=base;let queue=createReviewQueue();
 function restoreReview(saved){if(saved?.kind!=='sheet'||saved.version!==1||!saved.added||Array.isArray(saved.added))throw Error('Could not restore spreadsheet review.');for(const s of sides)docs[s].restore(saved.drafts?.[s]);added=structuredClone(saved.added);for(const [key,pair]of Object.entries(added)){if(!base.some(r=>r.key===key)||!pair||Object.entries(pair).some(([s,r])=>!sides.includes(s)||!Number.isInteger(r)||r<=docs[s].range.s.r+1||r>docs[s].endRow()+1))throw Error('Could not restore copied rows.');}queue=createReviewQueue([],saved.review);started=saved.review?.started??false;}
 const coreSnapshot=()=>({version:1,kind:'sheet',drafts:Object.fromEntries(sides.map(s=>[s,docs[s].snapshot()])),added:structuredClone(added),review:queue.snapshot(started)});
 if(restoredState!==undefined){
  if(restoredState.undo!==undefined){if(!Array.isArray(restoredState.undo)||restoredState.undo.length>100||new TextEncoder().encode(JSON.stringify(restoredState.undo)).length>8*1024*1024)throw Error('Could not restore spreadsheet undo history.');for(const state of restoredState.undo){restoreReview(state);undo.push(coreSnapshot());}}
  restoreReview(restoredState);
 }
 const snapshot=()=>({...coreSnapshot(),undo:structuredClone(undo),...(single?{singleUi:{page:pages.left,editing:!inspector.hidden,address:ui.left.address,value:ui.left.input.value,type:ui.left.type.value,top:ui.left.scroll.scrollTop,left:ui.left.scroll.scrollLeft}}:{})});
 if(!alive())throw new DOMException('Canceled','AbortError');
 root.replaceChildren();root.className='visual-review sheet-review'+(single?' single-review':'');
 const toolbar=el('section',undefined,'review-flow'),progress=el('strong','','review-flow-progress');progress.setAttribute('role','status');
 const start=button('Start review',()=>{started=true;advance();notify();},'button primary');start.dataset.reviewAction='start';
 const undoButton=button('Undo last change',undoEdit);undoButton.dataset.sheetUndo='';
 const finish=button('Download updated B',()=>save('right'),'button primary');finish.dataset.reviewAction='download';
 const hint=el('p','Click a cell to edit. Use A or keep B, then continue.','review-flow-hint');toolbar.append(progress,start,undoButton,hint);
 const finalCheck=createFinalCheck(toolbar,{beforeCheck:()=>{if(!alive())return false;if(!commitVisible())return false;update();return true;},onGo:()=>{started=true;advance();notify();},matchLabel:'No differences in checked values.',scope:'Current values in the paired rows and selected columns are checked, using your text and number settings. Row pairing stays as originally compared. Column headings, unchecked columns, row order, formatting and images are not compared.'});
 toolbar.append(finish);root.append(toolbar);if(single){for(const n of [...toolbar.children])n.hidden=n!==undoButton;toolbar.prepend(el('strong','Your spreadsheet'));}
 const findHost=el('div',undefined,'document-find');root.append(findHost);
 const status=el('p','','visual-notice');status.hidden=true;status.setAttribute('role','status');root.append(status);
 const formulaNotice=el('p','','visual-notice');formulaNotice.hidden=true;root.append(formulaNotice);
 root.append(el('p',single?'Click a cell to edit. Download the workbook or preview the selected sheet as PDF. Images and charts stay in Excel.':'The selected sheets are compared. Unchecked columns remain visible. Copied rows are inserted in the same order as the source table. Copied dates and zero-padded identifiers are kept as text. Other workbook sheets, formatting and images are retained in the downloaded XLSX; images and charts are not shown in this grid.','visual-instruction'));
 const grid=el('div',undefined,'visual-columns');root.append(grid);
 const inspector=el('section',undefined,'visual-inspector');inspector.hidden=true;inspector.setAttribute('aria-label','Edit selected cell');
 const title=el('strong','Selected cell'),inspectorHead=el('div',undefined,'visual-inspector-head'),inspectorUndo=button('Undo last change',undoEdit);inspectorUndo.dataset.sheetUndo='inspector';inspectorHead.append(title,inspectorUndo);const actions=el('div',undefined,'review-decision-actions');
 const use=button('Use A',()=>decide('use'),'button primary');use.dataset.reviewAction='use-a';const keep=button('Keep B',()=>decide('keep'));keep.dataset.reviewAction='keep';
 const done=button('Done — next difference',()=>decide('keep'));actions.append(use,keep,button('Explain this change',()=>onExplain(context())),done);inspector.append(inspectorHead,actions);if(single)actions.hidden=true;
 const fields=el('div',undefined,'visual-edit-fields');inspector.append(fields);root.append(inspector);
 for(const s of sides){const panel=el('section',undefined,'visual-column'),head=el('div',undefined,'visual-column-heading');head.append(el('span',letter(s),'letter'),el('span',sources[s].name,'visual-file-name'));const download=button(single?'Download':'Download '+letter(s),()=>save(s),'button primary');download.dataset.saveSide=s;const format=el('select',undefined,'document-download-format');format.setAttribute('aria-label',single?'Download format':'Download format for '+letter(s));format.dataset.downloadFormat=s;for(const [value,label]of [['original',docs[s].xlsx?'Excel (.xlsx)':(/\.tsv$/i.test(sources[s].name)?'TSV (.tsv)':'CSV (.csv)')],['pdf','PDF (.pdf)']]){const option=el('option',label);option.value=value;format.append(option);}head.append(format,download);panel.append(head);if(single){panel.hidden=s==='right';head.querySelector('.letter').hidden=true;}
  const nav=el('div',undefined,'visual-page-nav'),pageLabel=el('span');const prev=button('Previous rows',()=>{pages[s]--;render(s);if(single)notify();}),next=button('Next rows',()=>{pages[s]++;render(s);if(single)notify();});nav.append(prev,pageLabel,next);panel.append(nav);
  const scroll=el('div',undefined,'visual-scroll sheet-scroll');scroll.setAttribute('aria-label','Spreadsheet '+letter(s));panel.append(scroll);grid.append(panel);
  const box=el('div',undefined,'visual-edit-label'),label=el('label',single?'Cell value':'Version '+letter(s)),input=el('textarea');input.rows=3;input.id=(single?'single-':'')+'sheet-edit-'+s;input.dataset.editSide=s;label.htmlFor=input.id;input.setAttribute('aria-label',single?'Edit cell value':'Edit version '+letter(s));
  const type=el('select');type.setAttribute('aria-label','Cell type in '+letter(s));for(const value of ['text','number','boolean']){const option=el('option',value[0].toUpperCase()+value.slice(1));option.value=value;type.append(option);}
  const apply=button('Apply cell edit',()=>mutate(()=>{docs[s].edit(ui[s].address,input.value,type.value);}));apply.dataset.applyCell=s;
  const copy=button('Use '+letter(other(s))+' in '+letter(s),()=>copyCell(s));copy.dataset.copyTo=s;
  const copyRow=button('Copy row to '+letter(other(s)),()=>transferRow(other(s)));copyRow.dataset.copyRowFrom=s;
  input.addEventListener('input',()=>{finalCheck.dirty();update();if(single)notify();});type.addEventListener('change',()=>{finalCheck.dirty();update();if(single)notify();});
  box.append(label,input,type,apply,copy,copyRow);fields.append(box);if(single){box.hidden=s==='right';copy.hidden=copyRow.hidden=true;}ui[s]={scroll,prev,next,pageLabel,input,type,apply,copy,copyRow,address:null,download,format};if(single)scroll.addEventListener('scroll',notify);
 }
 function message(text=''){status.textContent=text;status.hidden=!text;}
 function context(){const t=tasks().find(t=>t.key===selected);return {kind:'sheet',edited:sides.some(s=>docs[s].changed),count:tasks().filter(differs).length,textsEqual:!tasks().some(differs),structureDiffers:false,selected:t?{key:t.key,left:value(t,'left'),right:value(t,'right'),different:differs(t)}:null};}
 function notify(){if(alive()){onStateChange();onRevision(sides.some(s=>docs[s].changed));onSelectionChange(context());}}
 function checkpoint(){return coreSnapshot();}
 function mutate(fn){if(!alive())return;const before=checkpoint();try{fn();undo.push(before);while(undo.length>100||undo.length&&new TextEncoder().encode(JSON.stringify(undo)).length>8*1024*1024)undo.shift();message();paint();notify();return true;}catch(e){for(const s of sides)docs[s].restore(before.drafts[s]);added=before.added;message(e.message);return false;}}
 function undoEdit(){if(!alive())return;if(pendingEdits().length){fieldsFromSelection();update();notify();return;}if(!undo.length)return;const before=undo.pop();for(const s of sides)docs[s].restore(before.drafts[s]);added=before.added;queue=createReviewQueue([],before.review);started=before.review?.started??false;paint();notify();}
 function update(){const formulas=docs.left.formulaStatus();formulaNotice.hidden=!single||!formulas.count;formulaNotice.textContent=formulas.pending?'Some totals need Excel to update. You can keep editing and download Excel.':formulas.stored?'Formulas are kept. Some totals show the saved Excel result; Excel updates them when opened.':'Calculated cells update from your edits. Formulas are kept in the Excel download.';const all=tasks(),items=all.map(t=>({key:t.key,differs:differs(t),signature:JSON.stringify(sides.map(s=>signature(t,s)))}));queue.sync(items);finalCheck.update(items,queue,sides.map(s=>docs[s].revision));const p=queue.progress();progress.textContent=`Reviewed ${p.reviewed} of ${p.total}`;start.disabled=!p.pending;start.textContent=started?'Next to review':'Start review';finish.hidden=single||!!p.pending;const pending=pendingEdits().length>0;for(const control of [undoButton,inspectorUndo]){control.disabled=!undo.length&&!pending;control.textContent=pending?'Discard cell edit':'Undo last change';control.title=pending?'Discard unapplied changes in the cell editor':'Undo the most recent edit or review decision'+(single?'':' in either A or B');}
  const current=all.find(t=>t.key===selected);use.disabled=!current||current.kind==='row';keep.disabled=!current;done.disabled=!current;hint.textContent=p.total&&!p.pending?(items.some(i=>i.differs)?'All checked differences reviewed. Your chosen differences remain. Check again to finish.':'All checked differences reviewed. Check again, then download your updated file.'):'Click a cell to edit. Use A or keep B, then continue.';onSelectionChange(context());finder?.refresh();}
 function render(s){if(single&&s==='right')return;const d=docs[s],u=ui[s],first=d.range.s.r,last=d.endRow();pages[s]=Math.max(0,Math.min(pages[s],Math.floor((last-first)/50)));const from=first+pages[s]*50,to=Math.min(last,from+49);u.pageLabel.textContent=`${report.sources[s].sheet||'Table'} · Rows ${from+1}–${to+1} of ${last+1}`;u.prev.disabled=pages[s]===0;u.next.disabled=to===last;
  const table=el('table',undefined,'sheet-grid');table.setAttribute('aria-label','Cells in '+letter(s));if(d.xlsx){const cols=el('colgroup'),rowCol=el('col');rowCol.style.width='48px';cols.append(rowCol);let width=48;const sourceCols=d.workbook.Sheets[d.meta.sheet]['!cols']||[];for(let c=d.range.s.c;c<=d.range.e.c;c++){const column=el('col'),size=sheetColumnWidth(sourceCols[c]);column.style.width=size+'px';cols.append(column);width+=size;}table.classList.add('sheet-source-widths');table.style.width=width+'px';table.append(cols);}const head=el('tr');head.append(el('th',''));for(let c=d.range.s.c;c<=d.range.e.c;c++)head.append(el('th',utils.encode_col(c)));const thead=el('thead');thead.append(head);table.append(thead);const body=el('tbody');table.append(body);
  const all=tasks(),byAddress=new Map();for(const t of all){if(t.kind==='row'){if(t.row[s])for(const name of columns[s])byAddress.set(address(t.row,s,name),t);}else byAddress.set(address(t.row,s,t.names[s==='left'?0:1]),t);}
  for(let r=from;r<=to;r++){const tr=el('tr');tr.append(el('th',String(r+1)));for(let c=d.range.s.c;c<=d.range.e.c;c++){const physical=utils.encode_cell({r,c}),merge=d.mergeInfo(physical);if(merge&&(c!==merge.s.c||r!==Math.max(from,merge.s.r)))continue;const addr=merge?.anchor||physical,td=el('td'),t=byAddress.get(addr);if(merge){td.colSpan=merge.colSpan;td.rowSpan=Math.min(to,merge.e.r)-Math.max(from,merge.s.r)+1;}const cell=button(d.display(addr),()=>selectCell(s,addr,t),'sheet-cell');cell.dataset.cell=addr;cell.dataset.side=s;cell.setAttribute('aria-label',`${letter(s)} ${addr}: ${d.display(addr).slice(0,120)}`);if(t){cell.dataset.group=t.key;cell.classList.toggle('has-difference',differs(t));cell.classList.toggle('is-reviewed',queue.has(t.key)&&queue.reviewed(t.key));}else if(!single)cell.title='Not included in the comparison';cell.classList.toggle('is-selected',ui[s].address===addr&&!inspector.hidden);
   const colors=sheetCellColors(d.get(addr).s);if(colors){td.style.backgroundColor=colors.background;td.style.color=colors.foreground;}td.classList.toggle('has-difference',cell.classList.contains('has-difference'));td.classList.toggle('is-selected',cell.classList.contains('is-selected'));td.addEventListener('click',event=>{if(event.target===td)cell.click();});
   td.append(cell);tr.append(td);}body.append(tr);}u.scroll.replaceChildren(table);finder?.refresh();
 }
 function paint(){if(!inspector.hidden)fieldsFromSelection();update();for(const s of sides)render(s);}
 function fieldsFromSelection(){const t=tasks().find(t=>t.key===selected);for(const s of sides){const u=ui[s];if(t)u.address=t.kind==='cell'?address(t.row,s,t.names[s==='left'?0:1]):address(t.row,s,report.rules.key[s==='left'?0:1]);u.input.value=u.address?docs[s].input(u.address):'';u.type.value=u.address?docs[s].type(u.address):'text';const calculated=!!u.address&&docs[s].isFormula(u.address);u.input.disabled=!u.address;u.input.readOnly=calculated;u.type.disabled=u.apply.disabled=!u.address||calculated;u.input.title=calculated?'Calculated cell. Edit its input cells to update this value.':'';u.copy.disabled=!t||t.kind!=='cell';u.copyRow.hidden=!t;u.copyRow.disabled=!t||!u.address;}
  if(single){title.textContent=(ui.left.address&&docs.left.isFormula(ui.left.address)?'Calculated cell ':'Cell ')+(ui.left.address||'');ui.left.copyRow.hidden=true;return;}title.textContent=t?.kind==='row'?'This row is missing in one version. Copy the whole row or keep B.':`Selected cell · A ${ui.left.address||'—'} · B ${ui.right.address||'—'}`;}
 function selectCell(s,addr,t){addr=docs[s].anchorAddress(addr);if(single&&!commitVisible())return;selected=t?.key??null;inspector.hidden=false;root.classList.add('is-editing');if(!t){for(const side of sides)ui[side].address=side===s?addr:null;}fieldsFromSelection();update();for(const side of sides)for(const node of ui[side].scroll.querySelectorAll('[data-cell]')){const active=node.dataset.cell===ui[side].address;node.classList.toggle('is-selected',active);node.parentElement.classList.toggle('is-selected',active);}if(single)notify();}
 async function select(key){const all=tasks(),t=all.find(t=>t.key===key)||all.find(t=>t.row.key===key);if(!t)throw Error('Cell not found.');selected=t.key;inspector.hidden=false;root.classList.add('is-editing');fieldsFromSelection();for(const s of sides){if(ui[s].address)pages[s]=Math.floor((utils.decode_cell(ui[s].address).r-docs[s].range.s.r)/50);render(s);}update();}
 function advance(){update();const key=queue.next(selected);if(key)void select(key);else{selected=null;inspector.hidden=true;root.classList.remove('is-editing');update();}}
 function copiedCell(target,source,addr,name){const cell=docs[source].get(addr);if(!docs[target].xlsx||docs[source].xlsx&&(SSF.is_date(cell.z||'General')||/^0+$/.test(cell.z||'')))return {t:'s',v:cellValue(source,addr,name)};return cell;}
 function copyCell(s){const t=tasks().find(t=>t.key===selected);if(!t||t.kind!=='cell')return;const from=other(s),name=t.names[s==='left'?1:0];mutate(()=>docs[s].copy([[address(t.row,s,t.names[s==='left'?0:1]),copiedCell(s,from,address(t.row,from,name),name)]]));}
 function insertionRecord(row,source,target){
  const sourceRecord=recordOf(row,source),ordered=rows.filter(r=>recordOf(r,source)&&recordOf(r,target)).sort((a,b)=>recordOf(a,source)-recordOf(b,source));
  const next=ordered.find(r=>recordOf(r,source)>sourceRecord);if(next)return recordOf(next,target);
  const previous=ordered.filter(r=>recordOf(r,source)<sourceRecord).at(-1);if(previous)return recordOf(previous,target)+1;
  const header=s=>report.sources[s].header_cells?.[columns[s][0]]?utils.decode_cell(report.sources[s].header_cells[columns[s][0]]).r:0;
  return Math.max(header(target)+2,Math.min(docs[target].endRow()+2,sourceRecord-header(source)+header(target)));
 }
 function transferRow(target){const t=tasks().find(t=>t.key===selected);if(!t)return;const source=other(target);mutate(()=>{
  const existing=recordOf(t.row,target),record=existing??insertionRecord(t.row,source,target);
  const changes=columns[target].map(name=>{const mapping=mappings.find(m=>m[target==='left'?0:1]===name),sourceName=mapping?.[source==='left'?0:1]??name;if(!columns[source].includes(sourceName))throw Error('This row has unmatched columns. Match all columns before copying the row.');return [utils.encode_cell({r:record-1,c:col(target,name)}),copiedCell(target,source,address(t.row,source,sourceName),sourceName)];});
  if(existing)docs[target].copy(changes);else{
   docs[target].insertRow(record-1,changes);
   for(const pair of Object.values(added))if(pair[target]>=record)pair[target]++;
   if(!Object.hasOwn(added,t.row.key))Object.defineProperty(added,t.row.key,{value:{},enumerable:true,writable:true,configurable:true});added[t.row.key][target]=record;
  }
 });if(started)advance();}
 function decide(action){const t=tasks().find(t=>t.key===selected);if(!t)return;if(action==='use')copyCell('right');else mutate(()=>queue.accept(t.key));advance();notify();}
 function pendingEdits(){return sides.filter(s=>ui[s].address&&!docs[s].isFormula(ui[s].address)&&!inspector.hidden&&(ui[s].input.value!==docs[s].input(ui[s].address)||ui[s].type.value!==docs[s].type(ui[s].address))).map(s=>[s,ui[s].address,ui[s].input.value,ui[s].type.value]);}
 function commitVisible(){
  const edits=pendingEdits();
  return !edits.length||mutate(()=>{for(const [s,a,value,type]of edits)docs[s].edit(a,value,type);});
 }
 function download(s,data,ext,mime){const url=URL.createObjectURL(new Blob([data],{type:mime})),a=el('a');a.href=url;a.download=sources[s].name.replace(/\.[^.]*$/,'')+(single?'-edited':'-version-'+letter(s))+'.'+ext;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function previewPdf(s){
  const model=captureSheetPdf(docs[s],{name:sources[s].name}),revision=docs[s].revision;pdfDialog?.close();
  const {openDocumentPdfDialog}=await import('./document-pdf-dialog.mjs');if(!alive()||pdfDialog)return;
  pdfDialog=openDocumentPdfDialog({host:root,label:single?sources[s].name:'Version '+letter(s),current:()=>alive()&&docs[s].revision===revision,
   description:(single?'Selected sheet only. All columns stay together. Wide sheets use a wider PDF page; long sheets continue downwards. Images and charts stay in XLSX.':'Selected sheet only. All columns stay together. Wide sheets use a wider PDF page; long sheets continue downwards. Images and charts are kept in XLSX, not included in this PDF.'),
   downloadedMessage:'PDF downloaded. Your spreadsheet is still editable.',
   prepare:async signal=>{const {renderSheetPdf}=await import('./sheet-pdf.mjs');return renderSheetPdf(model,{signal});},
   download:data=>download(s,data,'pdf','application/pdf'),onClose:()=>{pdfDialog=null;}});
 }
 async function save(s){if(!alive()||!commitVisible())return;try{if(ui[s].format.value==='pdf'){await previewPdf(s);return;}const data=docs[s].export(),ext=docs[s].xlsx?'xlsx':(/\.tsv$/i.test(sources[s].name)?'tsv':'csv');download(s,data,ext,docs[s].xlsx?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv;charset=utf-8');message(single?'Your file is ready to download.':'Version '+letter(s)+' is ready to download.');}catch(e){if(alive())message(e.message);}}
 finder=mountFindReplace(findHost,{
  single,showAddress:true,scopeHint:'Text cells on the selected sheet. Numbers and dates are skipped.',limits:{maxChars:8*1024*1024,maxEntryChars:131072},
  getEntries:s=>docs[s].textEntries(),canUndo:()=>undo.length>0||pendingEdits().length>0,undo:()=>undoEdit(),
  prepare:()=>{if(!alive()||!commitVisible())throw Error('Apply or undo the current cell edit before searching.');},
  apply:(s,patches)=>{if(!mutate(()=>docs[s].updateTexts(patches)))throw Error(status.textContent||'Could not replace the selected text.');},
  jump:async(s,hit,focus,current)=>{if(!alive()||!current())return;const addr=hit.key;pages[s]=Math.floor((utils.decode_cell(addr).r-docs[s].range.s.r)/50);selectCell(s,addr,null);render(s);const target=ui[s].scroll.querySelector(`[data-cell="${addr}"]`);target?.scrollIntoView?.({block:'nearest',inline:'nearest'});ui[s].input.setSelectionRange(hit.start,hit.end);if(focus)ui[s].input.focus({preventScroll:true});},
  highlight:(matches,s,active)=>{const keys=new Set(matches.map(m=>m.key));for(const side of sides)for(const cell of ui[side].scroll.querySelectorAll('[data-cell]')){cell.classList.toggle('has-search-match',side===s&&keys.has(cell.dataset.cell));cell.classList.toggle('is-search-current',side===s&&matches.length>0&&cell.dataset.cell===active?.key);}}
 });
 function dispose(){disposed=true;finder?.dispose();pdfDialog?.close();root.replaceChildren();}signal?.addEventListener('abort',dispose,{once:true});paint();
 if(single&&restoredState?.singleUi){
  const saved=restoredState.singleUi,d=docs.left;const invalid=()=>{throw Error('Could not restore the selected cell.');};
  if(!Number.isInteger(saved.page)||saved.page<0||saved.page>Math.floor((d.endRow()-d.range.s.r)/50)||typeof saved.editing!=='boolean'||typeof saved.value!=='string'||saved.value.length>2*1024*1024||!['text','number','boolean'].includes(saved.type)||![saved.top,saved.left].every(v=>Number.isFinite(v)&&v>=0&&v<=100000000))invalid();
  if(saved.address!==null){if(typeof saved.address!=='string'||!/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.test(saved.address))invalid();const {r,c}=utils.decode_cell(saved.address);if(r<d.range.s.r||r>d.endRow()||c<d.range.s.c||c>d.range.e.c)invalid();}else if(saved.editing)invalid();
  pages.left=saved.page;ui.left.address=saved.address;inspector.hidden=!saved.editing;root.classList.toggle('is-editing',saved.editing);fieldsFromSelection();ui.left.input.value=saved.value;ui.left.type.value=saved.type;render('left');ui.left.scroll.scrollTop=saved.top;ui.left.scroll.scrollLeft=saved.left;update();
 }
 return {snapshot,select,dispose,getAssistantContext:context,get changed(){return sides.some(s=>docs[s].changed||ui[s].address&&!docs[s].isFormula(ui[s].address)&&!inspector.hidden&&(ui[s].input.value!==docs[s].input(ui[s].address)||ui[s].type.value!==docs[s].type(ui[s].address)));}};
}
