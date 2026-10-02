/** One-document entry point. Existing editors receive a stable original reference,
 * with comparison decisions and the reference panel disabled in single mode. */
import {sheetMerges} from './sheet-merges.mjs';
import {validateZip} from './xlsx-source.mjs';
import {read, utils} from './xlsx-vendor.mjs';
import {parseCsv} from './sheet-document.mjs';
const fail=message=>{throw Error(message);};
export function sourceBytes(source){
 if(!source||typeof source.name!=='string'||!source.name.trim()||source.name.length>255||typeof source.data!=='string'||source.data.length>4*Math.ceil(2097152/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)||source.data.length%4)fail('Choose a valid file up to 2 MB.');
 const bytes=Uint8Array.from(atob(source.data),c=>c.charCodeAt(0));if(bytes.length>2097152)fail('Choose a file up to 2 MB.');return bytes;
}
export async function inspectSingleSource(source){
 const raw=sourceBytes(source),format=/\.(docx|pdf|xlsx|csv|tsv)$/i.exec(source.name)?.[1].toLowerCase();
 if(!format)fail('Choose a Word (.docx), text-based PDF, Excel (.xlsx), or CSV file.');
 if(format==='docx'||format==='pdf')return {format};
 if(format==='xlsx'){
  await validateZip(raw);const book=read(raw,{type:'array',bookSheets:true});if(book.SheetNames.length>100)fail('This workbook has more than 100 sheets. Choose a smaller workbook.');
  return {format,sheets:book.SheetNames};
 }
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('Save this CSV as UTF-8, then open it again.');}
 const scores=[',',';','\t'].map(delimiter=>{try{const rows=parseCsv(text,delimiter).slice(0,20),width=rows[0]?.length||1;return {delimiter,width,consistent:rows.every(r=>r.length===width)};}catch{return {delimiter,width:0};}});
 const best=scores.filter(s=>s.consistent&&s.width>1).sort((a,b)=>b.width-a.width)[0];return {format,delimiter:format==='tsv'?'\t':best?.delimiter||','};
}
export async function singleSheetMetadata(source,{sheet,delimiter=','}={}){
 const raw=sourceBytes(source),xlsx=/\.xlsx$/i.test(source.name);let grid,range;
 if(xlsx){
  await validateZip(raw);const book=read(raw,{type:'array',cellFormula:true});if(book.SheetNames.length>100)fail('Choose a workbook with at most 100 sheets.');
  if(!sheet||!book.SheetNames.includes(sheet))fail('Choose a worksheet.');grid=book.Sheets[sheet];
  const entries=Object.entries(grid).filter(([a])=>/^[A-Z]+[1-9]\d*$/.test(a));
  if(entries.length>100000)fail('This sheet has too many cells. Choose a smaller sheet.');
  range=sheetMerges(grid).bounds;
 }else{
  if(![',',';','\t'].includes(delimiter))fail('Choose comma, semicolon, or tab.');
  const rows=parseCsv(new TextDecoder('utf-8',{fatal:true}).decode(raw),delimiter);if(rows.length>5000)fail('Open a table with up to 5,000 rows.');const width=rows.reduce((max,row)=>Math.max(max,row.length),1);range={s:{r:0,c:0},e:{r:rows.length-1,c:width-1}};
 }
 const height=range.e.r-range.s.r+1,width=range.e.c-range.s.c+1;
 if(height>5000||width>200||height*width>200000)fail('Open a table with up to 5,000 rows, 200 columns and 200,000 cells.');
 return {name:source.name,format:xlsx?'xlsx':'csv',sheet:xlsx?sheet:undefined,headers:[],header_cells:{}};
}
export async function mountSingleEditor(root,{source,sheet,delimiter=',',signal,onRevision=()=>{},onStateChange=()=>{},restoredState}){
 const info=await inspectSingleSource(source);let report,mount;
 if(info.format==='docx'||info.format==='pdf'){
  const {readTextSource}=await import('./text-source.mjs'),{meta,blocks}=await readTextSource(source);
  report={kind:'text',status:'complete',sources:{left:meta,right:meta},matched:blocks.map(b=>({key:'text:'+b.record,left:b,right:structuredClone(b)}))};
  ({mountVisualReview:mount}=await import('./visual-review.mjs'));
 }else{
  const meta=await singleSheetMetadata(source,{sheet:sheet||info.sheets?.[0],delimiter});
  report={status:'complete',sources:{left:meta,right:meta},rules:{delimiter,key:['',''],fields:[],strip:false},matched:[]};
  ({mountSheetReview:mount}=await import('./sheet-review.mjs'));
 }
 if(signal?.aborted)throw new DOMException('Canceled','AbortError');
 const view=await mount(root,{report,sources:{left:source,right:source},single:true,signal,onRevision,onStateChange,restoredState});
 let position=restoredState?.kind==='sheet'?restoredState.singleUi:restoredState?.scroll?.left;
 view.restoreViewport=()=>{if(!position)return;const scroll=root.querySelector('.visual-column:not([hidden]) .visual-scroll');if(scroll){scroll.scrollTop=position.top;scroll.scrollLeft=position.left;position=null;}};
 return view;
}
