import {sheetCellColors} from './sheet-display.mjs';
import {utils} from './xlsx-vendor.mjs';
/** Capture before async generation, retaining displayed values and the real header row. */
export function captureSheetPdf(doc,{name='Table'}={}){
 if(doc.formulaStatus().pending)throw Error('Some calculated cells need Excel to update. Download Excel, open and save it there, then reopen it here to create a PDF.');
 const bounds={s:{...doc.range.s},e:{r:doc.endRow(),c:doc.range.e.c}};
 if(doc.xlsx){
  // A worksheet !ref may include a million empty rows. Bound the actual cells first.
  const addresses=Object.entries(doc.workbook.Sheets[doc.meta.sheet]).filter(([a,c])=>/^[A-Z]+[1-9]\d*$/.test(a)&&(c.v!==undefined&&c.v!==''||c.f!==undefined||c.F!==undefined)).map(([a])=>{const p=utils.decode_cell(a);return {...p,r:doc.mapRow(p.r)};});
  for(const [a]of doc.snapshot().patches)addresses.push(utils.decode_cell(a));
  for(const merge of doc.merges()){addresses.push(merge.s,merge.e);}
  if(addresses.length){bounds.s={r:Infinity,c:Infinity};bounds.e={r:0,c:0};for(const p of addresses){bounds.s.r=Math.min(bounds.s.r,p.r);bounds.s.c=Math.min(bounds.s.c,p.c);bounds.e.r=Math.max(bounds.e.r,p.r);bounds.e.c=Math.max(bounds.e.c,p.c);}}
 }
 const headerAddress=doc.meta.header_cells?.[doc.meta.headers?.[0]],headerRow=headerAddress?doc.mapRow(utils.decode_cell(headerAddress).r):bounds.s.r;
 bounds.s.r=Math.min(bounds.s.r,headerRow);
 const count=(bounds.e.r-bounds.s.r+1)*(bounds.e.c-bounds.s.c+1);
 if(!Number.isFinite(count)||count<1||count>200000||bounds.e.c-bounds.s.c>=200)throw Error('This table is too large for a PDF. Download the spreadsheet or select a smaller sheet.');
 const rows=[];let chars=0;
 for(let r=bounds.s.r;r<=bounds.e.r;r++){
  const cells=[];for(let c=bounds.s.c;c<=bounds.e.c;c++){const a=utils.encode_cell({r,c}),cell=doc.get(a),merge=doc.mergeInfo(a),covered=!!merge&&merge.anchor!==a,text=covered?'':String(doc.display(a)??'');chars+=text.length;if(chars>2000000)throw Error('This table has too much text for a PDF. Download the spreadsheet instead.');const colors=sheetCellColors(cell.s);cells.push({text,covered,rowSpan:merge&&!covered?merge.rowSpan:1,colSpan:merge&&!covered?merge.colSpan:1,align:cell.t==='n'?'right':'left',fill:colors?.background||null,foreground:colors?.foreground||null});}
  rows.push({number:r+1,cells});
 }
 return {name,sheet:doc.meta.sheet||'Table',columns:Array.from({length:bounds.e.c-bounds.s.c+1},(_,i)=>utils.encode_col(bounds.s.c+i)),header:headerRow-bounds.s.r,rows};
}
