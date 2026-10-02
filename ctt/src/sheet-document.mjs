/** Editable source cells. XLSX exports patch worksheet XML, retaining all other parts. */
import {createSheetCalculator} from './sheet-formulas.mjs';
import {sheetMerges} from './sheet-merges.mjs';
import {read, utils, CFB, SSF} from './xlsx-vendor.mjs';
import {validateZip} from './xlsx-source.mjs';
import {DOMParser} from './xml-vendor.mjs';
import {insertWorkbookRows} from './sheet-row-insert.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
const decode = bytes => new TextDecoder('utf-8', {fatal:true}).decode(bytes);
const encode = text => new TextEncoder().encode(text);
const fail = message => { throw new Error(message); };
const children = (node,name) => Array.from(node.childNodes || []).filter(n=>n.nodeType===1 && (!name || n.localName===name));
const descendants = (node,name) => Array.from(node.getElementsByTagName('*')).filter(n=>n.localName===name);
const parseXML = bytes => {const text=decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(text))fail('Unsupported workbook XML.');return new DOMParser({onError:()=>fail('Invalid workbook XML.')}).parseFromString(text,'application/xml');};
export function parseCsv(text, delimiter) {
 const rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<text.length;i++) {const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){value+='"';i++;}else if(ch==='"')quoted=false;else value+=ch;}else if(ch==='"'&&!value)quoted=true;else if(ch===delimiter){row.push(value);value='';}else if(ch==='\r'||ch==='\n'){row.push(value);rows.push(row);row=[];value='';if(ch==='\r'&&text[i+1]==='\n')i++;}else value+=ch;}
 if(quoted)fail('Unclosed CSV quote.');if(value||row.length||!rows.length){row.push(value);rows.push(row);}return rows;
}
export async function openSheetDocument(source, meta, delimiter=',') {
 const raw=Uint8Array.from(atob(source.data),c=>c.charCodeAt(0)),xlsx=meta.format==='xlsx';
 const sheetPaths=new Map();let workbook,grid,archive,sheetPath,xml,range,newline='\n',bom=false,ending=true;
 if(xlsx){await validateZip(raw);workbook=read(raw,{type:'array',cellStyles:true,cellNF:true,cellFormula:true,cellText:true});grid=workbook.Sheets[meta.sheet];if(!grid)fail('Selected sheet is missing.');range=utils.decode_range(grid['!ref']||'A1');archive=CFB.read(raw,{type:'array'});
  const part=name=>{const file=CFB.find(archive,'/'+name);if(!file)fail('Workbook part is missing.');return file.content;};
  const wb=parseXML(part('xl/workbook.xml'));const rels=parseXML(part('xl/_rels/workbook.xml.rels'));
  for(const item of descendants(wb,'sheet')){const rid=Array.from(item.attributes).find(a=>a.localName==='id')?.value,target=descendants(rels,'Relationship').find(r=>r.getAttribute('Id')===rid)?.getAttribute('Target');if(target&&!target.includes('..')&&!target.includes('://'))sheetPaths.set(item.getAttribute('name'),target.startsWith('/')?target.slice(1):'xl/'+target);}
  const sheet=descendants(wb,'sheet').find(s=>s.getAttribute('name')===meta.sheet);const id=Array.from(sheet.attributes).find(a=>a.localName==='id')?.value;
  const target=descendants(rels,'Relationship').find(r=>r.getAttribute('Id')===id)?.getAttribute('Target');
  if(!target||target.includes('..')||target.includes('://'))fail('Unsupported sheet path.');sheetPath=target.startsWith('/')?target.slice(1):'xl/'+target;xml=parseXML(part(sheetPath));
 }else{let text=decode(raw);bom=raw[0]===239&&raw[1]===187&&raw[2]===191;newline=text.includes('\r\n')?'\r\n':text.includes('\r')?'\r':'\n';ending=/[\r\n]$/.test(text);grid={};const rows=parseCsv(text,delimiter);rows.forEach((row,r)=>row.forEach((v,c)=>{grid[utils.encode_cell({r,c})]={t:'s',v};}));range={s:{r:0,c:0},e:{r:rows.length-1,c:Math.max(...rows.map(r=>r.length))-1}};}
 const mergeIndex=sheetMerges(grid);range=mergeIndex.ranges.length?mergeIndex.bounds:range;
 const initialEnd=range.e.r;let patches=new Map(),insertions=[],history=[],revision=0,textCache=null,textRevision=-1;
 const originalRow=r=>{for(let i=insertions.length-1;i>=0;i--){if(r===insertions[i])return null;if(r>insertions[i])r--;}return r;};
 const mapRow=r=>{for(const at of insertions)if(r>=at)r++;return r;};
 const merges=()=>mergeIndex.ranges.map(m=>({s:{r:mapRow(m.s.r),c:m.s.c},e:{r:mapRow(m.e.r),c:m.e.c}}));
 const mergeInfo=addr=>{const p=utils.decode_cell(addr),r=originalRow(p.r);if(r===null)return null;const m=mergeIndex.cells.get(utils.encode_cell({r,c:p.c}));if(!m)return null;const s={r:mapRow(m.s.r),c:m.s.c},e={r:mapRow(m.e.r),c:m.e.c};return {s,e,anchor:utils.encode_cell(s),rowSpan:e.r-s.r+1,colSpan:e.c-s.c+1};};
 const anchorAddress=addr=>mergeInfo(addr)?.anchor||addr;
 const original=addr=>{const cell=utils.decode_cell(addr),r=originalRow(cell.r);return r===null?{t:'s',v:''}:grid[utils.encode_cell({...cell,r})]||{t:'s',v:''};};
 const rawGet=addr=>patches.has(addr)?{...original(addr),...patches.get(addr),w:undefined}:original(addr);
 const isFormula=addr=>{const cell=original(anchorAddress(addr));return cell.f!==undefined||cell.F!==undefined;};
 let calculator,calcRevision=-1;
 function calculate(sheet,addr){if(!xlsx||insertions.length)return {ok:false};if(calcRevision!==revision){calculator=createSheetCalculator(workbook,(name,a)=>name===meta.sheet?rawGet(a):workbook.Sheets[name]?.[a]);calcRevision=revision;}return calculator.result(sheet,addr);}
 const get=addr=>{const cell=rawGet(addr);if(cell.f===undefined&&cell.F===undefined)return cell;const result=calculate(meta.sheet,addr);if(!result.ok)return patches.size||insertions.length||cell.v===undefined?{...cell,t:'s',v:'Recalculate in Excel',w:undefined}:cell;return {...cell,t:typeof result.value==='number'?'n':typeof result.value==='boolean'?'b':'s',v:result.value??0,w:undefined};};
 function formulaStatus(){let count=0,pending=0,stored=0;if(xlsx)for(const [a,cell]of Object.entries(grid)){if(!/^[A-Z]+[1-9]\d*$/.test(a)||cell.f===undefined&&cell.F===undefined)continue;count++;const p=utils.decode_cell(a),addr=utils.encode_cell({...p,r:mapRow(p.r)});if(!calculate(meta.sheet,addr).ok){if(patches.size||insertions.length||cell.v===undefined)pending++;else stored++;}}return {count,pending,stored};}
 const typed=cell=>({t:['n','b'].includes(cell.t)?cell.t:'s',v:cell.v??''});
 function validAddress(addr){if(!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(addr))return false;const {r,c}=utils.decode_cell(addr);return r>=range.s.r&&r<=Math.min(1048575,initialEnd+5000)&&c>=range.s.c&&c<=range.e.c;}
 function validCell(cell){return cell&&['s','n','b'].includes(cell.t)&&(cell.t==='s'?typeof cell.v==='string'&&cell.v.length<=131072&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cell.v):cell.t==='n'?typeof cell.v==='number'&&Number.isFinite(cell.v):typeof cell.v==='boolean');}
 const snapshot=()=>({version:1,insertions:[...insertions],patches:[...patches].map(([a,c])=>[a,clone(c)])});
 function remember(){history.push(snapshot());if(history.length>100)history.shift();}
 function apply(changes){if(changes.some(([a])=>isFormula(a)))fail('This cell is calculated. Edit its input cells instead.');if(changes.some(([a,v])=>!validAddress(a)||anchorAddress(a)!==a||!validCell(v)))fail('Invalid cell value.');remember();for(const [addr,cell]of changes){if(utils.decode_cell(addr).r<=mapRow(initialEnd)&&originalRow(utils.decode_cell(addr).r)!==null&&JSON.stringify(typed(original(addr)))===JSON.stringify(cell))patches.delete(addr);else patches.set(addr,clone(cell));}revision++;}
 function endRow(){return [...patches.keys()].reduce((end,a)=>Math.max(end,utils.decode_cell(a).r),mapRow(initialEnd));}
 function textEntries(){
  if(textRevision!==revision){textCache=[];const last=endRow();for(let r=range.s.r;r<=last;r++)for(let c=range.s.c;c<=range.e.c;c++){const key=utils.encode_cell({r,c}),cell=get(key);if(anchorAddress(key)!==key)continue;if(cell.t==='s'&&typeof cell.v==='string'&&cell.v&&cell.f===undefined&&cell.F===undefined)textCache.push({key,text:cell.v});}textRevision=revision;}
  return textCache.map(entry=>({...entry}));
 }
 function updateTexts(edits){
  if(!Array.isArray(edits))fail('Invalid text replacements.');const entries=textEntries(),seen=new Set(),changes=[];
  for(const edit of edits){const entry=Number.isInteger(edit?.index)&&entries[edit.index];if(!entry||entry.key!==edit.key||entry.text!==edit.before||seen.has(edit.index)||!validCell({t:'s',v:edit.text}))fail('The cell changed or the replacement is invalid. Search again before replacing.');seen.add(edit.index);if(edit.text!==entry.text)changes.push([entry.key,{t:'s',v:edit.text}]);}
  let count=patches.size;for(const [addr,cell]of changes){const r=utils.decode_cell(addr).r,remove=r<=mapRow(initialEnd)&&originalRow(r)!==null&&JSON.stringify(typed(original(addr)))===JSON.stringify(cell);if(remove&&patches.has(addr))count--;else if(!remove&&!patches.has(addr))count++;}if(count>100000)fail('Too many edited cells. Replace a smaller set of values.');
  if(changes.length)apply(changes);
 }
 return {textEntries,updateTexts,isFormula,formulaStatus,mergeInfo,anchorAddress,merges,xlsx,meta,range,workbook,get,get revision(){return revision;},get changed(){return patches.size>0||insertions.length>0;},get canUndo(){return history.length>0;},endRow,mapRow,
  insertRow(at,changes){if(merges().some(m=>at>m.s.r&&at<=m.e.r))fail('Insert the row before or after the merged area.');if(!Number.isInteger(at)||at<=range.s.r||at>endRow()+1||endRow()>=Math.min(1048575,initialEnd+4999))fail('Cannot insert a row here.');if(changes.some(([a,v])=>!validAddress(a)||utils.decode_cell(a).r!==at||!validCell(typed(v))))fail('Invalid inserted row.');remember();patches=new Map([...patches].map(([a,v])=>{const cell=utils.decode_cell(a);if(cell.r>=at)cell.r++;return [utils.encode_cell(cell),v];}));insertions.push(at);for(const [a,v]of changes)patches.set(a,typed(v));revision++;},
  display(addr){const cell=get(addr);return cell.w??(xlsx?(cell.t==='n'?SSF.format(cell.z||'General',cell.v,{date1904:!!workbook.Workbook?.WBProps?.date1904}):utils.format_cell(cell)):String(cell.v??''));},
  input(addr){return String(get(addr).v??'');},type(addr){return get(addr).t==='n'?'number':get(addr).t==='b'?'boolean':'text';},
  edit(addr,text,type){addr=anchorAddress(addr);let cell={t:'s',v:text};if(type==='number'){if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)||!Number.isFinite(Number(text)))fail('Enter a number, or choose Text.');cell={t:'n',v:Number(text)};}if(type==='boolean'){if(!/^(true|false)$/i.test(text))fail('Enter TRUE or FALSE.');cell={t:'b',v:/^true$/i.test(text)};}apply([[addr,cell]]);},
  copy(changes){apply(changes.map(([addr,cell])=>[addr,typed(cell)]));},
  undo(){if(history.length){const saved=history.pop();patches=new Map(saved.patches);insertions=saved.insertions;revision++;}},
  snapshot,
  restore(saved){const positions=saved?.insertions??[];if(!Array.isArray(positions)||positions.length>5000||positions.some((r,i)=>!Number.isInteger(r)||r<=range.s.r||r>initialEnd+i+1||r>=1048576))fail('Could not restore inserted rows.');if(saved?.version!==1||!Array.isArray(saved.patches)||saved.patches.length>100000||saved.patches.some(e=>!Array.isArray(e)||e.length!==2||!validAddress(e[0])||!validCell(e[1]))||new Set(saved.patches.map(e=>e[0])).size!==saved.patches.length)fail('Could not restore spreadsheet edits.');const previous=insertions;insertions=[];try{for(const at of positions){if(merges().some(m=>at>m.s.r&&at<=m.e.r))fail('Could not restore a row inside a merged area.');insertions.push(at);}if(saved.patches.some(([a])=>isFormula(a)))fail('Could not restore an edit over a calculated cell.');if(saved.patches.some(([a])=>anchorAddress(a)!==a))fail('Could not restore edits inside a merged area.');}catch(e){insertions=previous;throw e;}patches=new Map(saved.patches.map(([a,cell])=>[a,typed(cell)]));revision++;},
  export(){
   if(!patches.size&&!insertions.length&&(!xlsx||!Object.values(workbook.Sheets).some(sheet=>Object.values(sheet).some(cell=>cell?.f!==undefined||cell?.F!==undefined))))return raw.slice();
   if(!xlsx){const rows=[];for(let r=0;r<=endRow();r++){const values=[];for(let c=0;c<=range.e.c;c++){const value=String(get(utils.encode_cell({r,c})).v??'');values.push(/["\r\n]/.test(value)||value.includes(delimiter)?'"'+value.replaceAll('"','""')+'"':value);}rows.push(values.join(delimiter));}return encode((bom?'\ufeff':'')+rows.join(newline)+(ending?newline:''));}
   const out=CFB.read(raw,{type:'array'});insertWorkbookRows(out,sheetPath,meta.sheet,insertions);
   const doc=insertions.length?parseXML(CFB.find(out,'/'+sheetPath).content):xml.cloneNode(true),ns=doc.documentElement.namespaceURI,data=descendants(doc,'sheetData')[0];if(!data)fail('Sheet data is missing.');
   const make=name=>doc.createElementNS(ns,name);
   for(const [addr,cell]of patches){const {r,c}=utils.decode_cell(addr);let row=children(data,'row').find(n=>Number(n.getAttribute('r'))===r+1);if(!row){row=make('row');row.setAttribute('r',String(r+1));const next=children(data,'row').find(n=>Number(n.getAttribute('r'))>r+1);data.insertBefore(row,next||null);}
    let node=children(row,'c').find(n=>n.getAttribute('r')===addr);if(!node){node=make('c');node.setAttribute('r',addr);const next=children(row,'c').find(n=>utils.decode_cell(n.getAttribute('r')).c>c);row.insertBefore(node,next||null);}
    for(const old of children(node).filter(n=>['f','v','is'].includes(n.localName)))node.removeChild(old);
    node.setAttribute('t',cell.t==='s'?'inlineStr':cell.t);const value=make(cell.t==='s'?'is':'v');if(cell.t==='s'){const t=make('t');t.setAttribute('xml:space','preserve');t.appendChild(doc.createTextNode(cell.v.replace(/_x[0-9a-f]{4}_/gi,m=>'_x005F_'+m.slice(1))));value.appendChild(t);}else value.appendChild(doc.createTextNode(cell.t==='b'?(cell.v?'1':'0'):String(cell.v)));node.appendChild(value);
   }
   const dimension=descendants(doc,'dimension')[0];if(dimension)dimension.setAttribute('ref',utils.encode_range({s:range.s,e:{r:endRow(),c:range.e.c}}));
   if(patches.size||insertions.length)CFB.utils.cfb_add(out,'/'+sheetPath,encode(doc.toString()));
   // Update result caches while retaining original formula XML and all unrelated parts.
   if(!insertions.length)for(const [name,sheet]of Object.entries(workbook.Sheets)){
    let changedDoc=null;const path=sheetPaths.get(name);if(!path)continue;
    for(const [addr,cell]of Object.entries(sheet)){if(!/^[A-Z]+[1-9]\d*$/.test(addr)||cell.f===undefined||cell.F!==undefined)continue;const result=calculate(name,addr);if(!result.ok)continue;const v=result.value??0,type=result.error?'e':typeof v==='number'?'n':typeof v==='boolean'?'b':'str';if(cell.v===v&&(cell.t===type||cell.t==='s'&&type==='str'))continue;
     changedDoc??=parseXML(CFB.find(out,'/'+path).content);const node=descendants(changedDoc,'c').find(n=>n.getAttribute('r')===addr);if(!node)continue;for(const old of children(node).filter(n=>['v','is'].includes(n.localName)))node.removeChild(old);node.setAttribute('t',type);const value=changedDoc.createElementNS(changedDoc.documentElement.namespaceURI,'v');value.appendChild(changedDoc.createTextNode(type==='b'?(v?'1':'0'):type==='str'?String(v).replace(/_x[0-9a-f]{4}_/gi,m=>'_x005F_'+m.slice(1)):String(v)));node.appendChild(value);
    }
    if(changedDoc)CFB.utils.cfb_add(out,'/'+path,encode(changedDoc.toString()));
   }
   if(Object.values(workbook.Sheets).some(sheet=>Object.values(sheet).some(cell=>cell&&typeof cell==='object'&&cell.f))){const wb=parseXML(CFB.find(out,'/xl/workbook.xml').content);let calc=descendants(wb,'calcPr')[0];if(!calc){calc=wb.createElementNS(wb.documentElement.namespaceURI,'calcPr');wb.documentElement.appendChild(calc);}calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');calc.setAttribute('calcMode','auto');CFB.utils.cfb_add(out,'/xl/workbook.xml',encode(wb.toString()));}const result=new Uint8Array(CFB.write(out,{type:'array',fileType:'zip',compression:true}));if(result.length>2*1024*1024)fail('The edited workbook exceeds 2 MiB.');return result;
  }
 };
}
