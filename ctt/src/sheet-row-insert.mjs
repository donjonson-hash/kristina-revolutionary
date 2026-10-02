/** Move worksheet rows and the workbook references that follow them. */
import {CFB} from './xlsx-vendor.mjs';
import {DOMParser} from './xml-vendor.mjs';
const elements=doc=>Array.from(doc.getElementsByTagName('*'));
const encode=s=>new TextEncoder().encode(s);
function shiftRef(ref,at){return ref.replace(/(\$?[A-Z]{1,3}\$?)([1-9][0-9]*)/g,(all,col,row)=>{const n=Number(row);if(n<at+1)return all;if(n>=1048576)throw Error('Inserting this row would exceed the Excel row limit.');return col+(n+1);});}
// Quoted strings and structured references are opaque. Range ends inherit their sheet.
function shiftFormula(text,at,sheet,local){
 return text.replace(/"(?:[^"]|"")*"|\[[^\]]*\]|(?<![\w.])(?:(('(?:[^']|'')*'|[\p{L}_][\p{L}\p{N}_.]*)!)?)(\$?[A-Z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Z]{1,3}\$?[1-9][0-9]*)?)(?![\w.(])/gu,(all,prefix,name,ref)=>{
  if(!ref)return all;const target=name?(name.startsWith("'")?name.slice(1,-1).replaceAll("''","'"):name):null;
  return (target?target.toLowerCase()===sheet.toLowerCase():local)?(prefix||'')+shiftRef(ref,at):all;
 });
}
export function insertWorkbookRows(archive,sheetPath,sheetName,insertions){
 if(!insertions.length)return;
 const docs=new Map(),originals=new Map(),get=path=>{if(docs.has(path))return docs.get(path);const part=CFB.find(archive,'/'+path);if(!part)return null;const text=new TextDecoder().decode(part.content);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Unsupported workbook XML.');const doc=new DOMParser({onError:()=>{throw Error('Invalid workbook XML.');}}).parseFromString(text,'application/xml');originals.set(path,doc.toString());docs.set(path,doc);return doc;};
 const selected=get(sheetPath),workbook=get('xl/workbook.xml');
 const relPath=sheetPath.replace(/([^/]+)$/,'_rels/$1.rels'),relations=get(relPath);
 const resolve=target=>{const parts=(target.startsWith('/')?target.slice(1):sheetPath.slice(0,sheetPath.lastIndexOf('/')+1)+target).split('/'),out=[];for(const p of parts){if(p==='..')out.pop();else if(p&&p!=='.')out.push(p);}return out.join('/');};
 const related=(relations?elements(relations):[]).filter(n=>n.localName==='Relationship'&&n.getAttribute('TargetMode')!=='External').map(n=>({path:resolve(n.getAttribute('Target')),type:n.getAttribute('Type')}));
 const tables=related.filter(r=>r.type.endsWith('/table')).map(r=>get(r.path)).filter(Boolean),drawings=related.filter(r=>r.type.endsWith('/drawing')).map(r=>get(r.path)).filter(Boolean);
 // Older VML drawings have a separate anchor encoding (notes/form controls).
 if(related.some(r=>r.type.endsWith('/vmlDrawing')))throw Error('This workbook has legacy drawing anchors. Save this table as CSV to insert rows.');
 const sheets=[];for(const path of archive.FullPaths){const name=path.slice(path.indexOf('/')+1);if(/^xl\/worksheets\/[^/]+\.xml$/.test(name))sheets.push({path:name,doc:get(name)});if(/^xl\/charts\/[^/]+\.xml$/.test(name))get(name);}
 for(const at of insertions){
  for(const node of elements(selected)){
   if(node.localName==='row'){const r=Number(node.getAttribute('r'));if(r>=at+1)node.setAttribute('r',String(r+1));}
   if(node.localName==='c'&&node.hasAttribute('r'))node.setAttribute('r',shiftRef(node.getAttribute('r'),at));
   for(const attr of ['ref','sqref','activeCell','topLeftCell'])if(node.hasAttribute(attr))node.setAttribute(attr,shiftRef(node.getAttribute(attr),at));
   if(node.localName==='pane'&&node.getAttribute('state')?.startsWith('frozen')&&Number(node.getAttribute('ySplit'))>at)node.setAttribute('ySplit',String(Number(node.getAttribute('ySplit'))+1));
   if(node.localName==='brk'&&node.parentNode.localName==='rowBreaks'&&Number(node.getAttribute('id'))>=at)node.setAttribute('id',String(Number(node.getAttribute('id'))+1));
  }
  for(const table of tables)for(const node of elements(table))if(node.hasAttribute('ref'))node.setAttribute('ref',shiftRef(node.getAttribute('ref'),at));
  for(const drawing of drawings)for(const node of elements(drawing))if(node.localName==='row'&&['from','to'].includes(node.parentNode.localName)&&Number(node.textContent)>=at)node.textContent=String(Number(node.textContent)+1);
  for(const [path,doc]of docs){const local=path===sheetPath||tables.includes(doc);for(const node of elements(doc)){
   if(['f','formula','formula1','formula2','calculatedColumnFormula','totalsRowFormula','definedName'].includes(node.localName)){
    const localName=node.localName==='definedName'&&node.hasAttribute('localSheetId')?elements(workbook).filter(n=>n.localName==='sheet')[Number(node.getAttribute('localSheetId'))]?.getAttribute('name')===sheetName:local;
    node.textContent=shiftFormula(node.textContent,at,sheetName,localName);
   }
  }}
  const chain=get('xl/calcChain.xml');if(chain){const sheetId=elements(workbook).find(n=>n.localName==='sheet'&&n.getAttribute('name')===sheetName)?.getAttribute('sheetId');let current=null;for(const node of elements(chain).filter(n=>n.localName==='c')){current=node.getAttribute('i')||current;if(current===sheetId)node.setAttribute('r',shiftRef(node.getAttribute('r'),at));}}
 }
 for(const [path,doc]of docs){const text=doc.toString();if(text!==originals.get(path))CFB.utils.cfb_add(archive,'/'+path,encode(text));}
}
