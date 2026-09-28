/** Local semantic DOCX presentation and lossless-package paragraph edits. */
import {readTextSource, readDocxPackage, validateDocxDrawing, MAX_TEXT_CHARS, MAX_TEXT_BLOCKS, MAX_TEXT_SOURCE_BYTES} from './text-source.mjs';
import {renderDocxNumbering} from './docx-numbering.mjs';
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main']);
const elements = node => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1);
const is = (node, name) => W.has(node.namespaceURI) && node.localName === name;
const child = (node,name) => elements(node).find(n => is(n,name));
const attr = (node,name='val') => { if (!node) return null; for (const ns of W) { const value=node.getAttributeNS(ns,name); if (value !== null) return value; } return null; };
const all = root => { const result=[]; function visit(n) { result.push(n); for (const c of elements(n)) visit(c); } visit(root); return result; };
const textOf = node => is(node,'t') ? node.textContent : is(node,'tab') ? '\t' : is(node,'noBreakHyphen') ? '\u2011' : is(node,'softHyphen') ? '\u00ad' : '\n';
const textual = node => W.has(node.namespaceURI) && ['t','tab','br','cr','noBreakHyphen','softHyphen'].includes(node.localName);
const enabled = node => node && !['0','false','off'].includes(attr(node));
const finite = (value,min,max) => value !== null && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
function stylesFor(checked) {
  const root=checked.docs.get('word/styles.xml')?.documentElement, styles=new Map(); let defaultParagraph=null;
  for (const node of elements(root)) if (is(node,'style')) {
    styles.set(attr(node,'styleId'),node);
    if (attr(node,'type')==='paragraph' && ['1','true','on'].includes(attr(node,'default'))) defaultParagraph=attr(node,'styleId');
  }
  const defaults=child(root,'docDefaults');
  function properties(pPr,rPr) {
    const style={};
    for (const [key,name,on,off] of [['fontWeight','b','bold','normal'],['fontStyle','i','italic','normal']]) { const n=child(rPr,name); if(n) style[key]=enabled(n)?on:off; }
    const size=attr(child(rPr,'sz')); if(finite(size,2,192)) style.fontSize=`${Number(size)/2}pt`;
    const color=attr(child(rPr,'color')); if (/^[a-f\d]{6}$/i.test(color||'')) style.color=`#${color}`;
    const font=attr(child(rPr,'rFonts'),'ascii'); if(font && /^[\p{L}\p{N} _-]{1,80}$/u.test(font)) style.fontFamily=font;
    const underline=child(rPr,'u'),strike=child(rPr,'strike');
    if(underline || strike) style.textDecoration=[underline && attr(underline)!=='none' && 'underline', enabled(strike) && 'line-through'].filter(Boolean).join(' ') || 'none';
    const jc=attr(child(pPr,'jc')); if(['left','right','center','both','start','end'].includes(jc)) style.textAlign=jc==='both'?'justify':jc;
    const spacing=child(pPr,'spacing');
    for(const [key,name] of [['marginTop','before'],['marginBottom','after']]) { const val=attr(spacing,name); if(finite(val,0,2880)) style[key]=`${Number(val)/20}pt`; }
    const line=attr(spacing,'line'); if(finite(line,120,720) && (attr(spacing,'lineRule')||'auto')==='auto') style.lineHeight=String(Number(line)/240);
    const indent=child(pPr,'ind'); for(const [key,name] of [['paddingLeft','left'],['paddingRight','right'],['textIndent','firstLine']]) { const val=attr(indent,name); if(finite(val,0,2880)) style[key]=`${Number(val)/20}pt`; }
    const outline=attr(child(pPr,'outlineLvl')); const heading=finite(outline,0,5)?Number(outline)+1:null;
    return {style,heading};
  }
  function chain(id,seen=new Set()) {
    if (!id) return {style:{},heading:null};
    if(seen.has(id)||seen.size>=64) throw new Error('DOCX: циклическое наследование стилей.');
    const node=styles.get(id); if(!node) return {style:{},heading:null}; seen.add(id);
    const base=chain(attr(child(node,'basedOn')),seen), own=properties(child(node,'pPr'),child(node,'rPr'));
    const name=attr(child(node,'name'))||id, match=/^(?:heading|заголовок)\s*([1-6])$/i.exec(name);
    return {style:{...base.style,...own.style},heading:own.heading|| (match?Number(match[1]):base.heading)};
  }
  const defaultStyle=properties(child(child(defaults,'pPrDefault'),'pPr'),child(child(defaults,'rPrDefault'),'rPr'));
  return {
    paragraph(node) { const pPr=child(node,'pPr'),base=chain(attr(child(pPr,'pStyle'))||defaultParagraph),own=properties(pPr,child(pPr,'rPr')); return {style:{...defaultStyle.style,...base.style,...own.style},heading:own.heading||base.heading}; },
    run(node) { return {...chain(attr(child(child(node,'rPr'),'rStyle'))).style,...properties(null,child(node,'rPr')).style}; },
  };
}
async function load(source) {
  if(!/\.docx$/i.test(source?.name||'')) throw new Error('Ожидается документ DOCX.');
  await readTextSource(source);
  return readDocxPackage(Uint8Array.from(atob(source.data),c=>c.charCodeAt(0)));
}
function base64(bytes) { let result=''; for(let i=0;i<bytes.length;i+=32768) result+=String.fromCharCode(...bytes.subarray(i,i+32768)); return btoa(result); }
export async function readDocxVisual(source) {
  const checked=await load(source), formatting=stylesFor(checked), body=child(checked.doc.documentElement,'body');
  const lists=renderDocxNumbering(checked.listData);
  const imageSources=new Map();
  const blocks=elements(body).filter(n=>is(n,'p')).map((p,i)=>{
    const runs=[];
    function visit(node,style={}) {
      if (is(node,'r')) style={...style,...formatting.run(node)};
      if (textual(node)) { runs.push({text:textOf(node),style}); return; }
      if (is(node,'drawing')) { const img=validateDocxDrawing(node,checked.entries,checked.docs); if(!imageSources.has(img.path))imageSources.set(img.path,`data:${img.mime};base64,${base64(img.bytes)}`); runs.push({image:{src:imageSources.get(img.path),width:img.width,height:img.height,alt:img.alt}}); return; }
      if(is(node,'pPr')||is(node,'rPr')) return;
      for(const c of elements(node)) visit(c,style);
    }
    visit(p);
    return {record:i+1,text:checked.texts[i],...formatting.paragraph(p),runs,list:lists[i]};
  });
  const section=child(body,'sectPr'),size=child(section,'pgSz'),margin=child(section,'pgMar');
  const px=(node,name,fallback,min,max)=>finite(attr(node,name),min,max)?Number(attr(node,name))/15:fallback;
  const page={width:px(size,'w',794,1440,31680),height:px(size,'h',1123,1440,31680),marginTop:px(margin,'top',72,0,4320),marginRight:px(margin,'right',72,0,4320),marginBottom:px(margin,'bottom',72,0,4320),marginLeft:px(margin,'left',72,0,4320)};
  return {format:'docx',blocks,page,listData:checked.listData,notes:['Заголовки, списки, стили текста и встроенные фотографии сохранены. Разбиение на страницы в браузере может отличаться от Word.']};
}

function validateText(text) {
  if(typeof text!=='string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text) || [...text].some(c=>c.codePointAt(0)>=0xD800&&c.codePointAt(0)<=0xDFFF)) throw new Error('Текст содержит недопустимые символы.');
  return text.replace(/\r\n?/g,'\n');
}
function replaceLeaf(node,text) {
  const doc=node.ownerDocument, ns=node.namespaceURI, prefix=node.prefix?`${node.prefix}:`:'';
  for(const token of text.split(/([\t\n])/)) {
    if(!token) continue;
    const n=doc.createElementNS(ns,`${prefix}${token==='\t'?'tab':token==='\n'?'br':'t'}`);
    if(token!=='\t'&&token!=='\n') {n.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');n.appendChild(doc.createTextNode(token));}
    node.parentNode.insertBefore(n,node);
  }
  node.parentNode.removeChild(node);
}
function revisedParts(parts,text) {
  const old=parts.join(''); if(old===text)return parts;
  let start=0; while(start<old.length&&start<text.length&&old[start]===text[start])start++;
  // Keep Unicode scalar boundaries when the first different code unit is a low surrogate.
  if(start && /[\uD800-\uDBFF]/.test(old[start-1]))start--;
  let end=old.length,newEnd=text.length;
  while(end>start&&newEnd>start&&old[end-1]===text[newEnd-1]){end--;newEnd--;}
  if(end<old.length&&/[\uDC00-\uDFFF]/.test(old[end])){end++;newEnd++;}
  const addition=text.slice(start,newEnd); let offset=0,inserted=false;
  if(!parts.length)return [addition];
  return parts.map((original,i)=>{
    const next=offset+original.length;
    let updated=original.slice(0,Math.max(0,Math.min(original.length,start-offset)));
    if(!inserted && (start<next || i===parts.length-1)){updated+=addition;inserted=true;}
    updated+=original.slice(Math.max(0,Math.min(original.length,end-offset)));
    offset=next;return updated;
  });
}
function editParagraph(p,text) {
  const leaves=all(p).filter(textual),parts=leaves.map(textOf),updated=revisedParts(parts,text);
  for(let i=0;i<leaves.length;i++)if(parts[i]!==updated[i])replaceLeaf(leaves[i],updated[i]);
  if(!leaves.length&&text) {
    const ns=p.namespaceURI,prefix=p.prefix?`${p.prefix}:`:'',run=p.ownerDocument.createElementNS(ns,`${prefix}r`),t=p.ownerDocument.createElementNS(ns,`${prefix}t`);
    run.appendChild(t);p.appendChild(run);replaceLeaf(t,text);
  }
}
function revisedRuns(runs,text) {
  const parts=runs.filter(run=>!run.image).map(run=>run.text),updated=revisedParts(parts,text);let index=0;
  const result=runs.map(run=>run.image?run:{...run,text:updated[index++]}).filter(run=>run.image||run.text);
  if(!parts.length&&text)result.push({text,style:{}});
  return result;
}
/** Project exactly the paragraph content/styles/images that writeDocxVisual exports. */
export function projectDocxVisual(model,sequence) {
  if(!model||!Array.isArray(model.blocks)||!Array.isArray(sequence))throw new Error('Некорректная редакция DOCX.');
  const originals=new Map(model.blocks.map(block=>[block.record,block])),seen=new Set(),blocks=[];let chars=0;
  for(const item of sequence) {
    if(item.record!==undefined&&(!originals.has(item.record)||seen.has(item.record)))throw new Error('Некорректный или повторный номер абзаца.');
    if(item.record!==undefined)seen.add(item.record);
    const text=validateText(item.text);chars+=[...text].length;
    if(chars>MAX_TEXT_CHARS||blocks.length>=MAX_TEXT_BLOCKS)throw new Error('Редакция DOCX превышает ограничение по объёму текста.');
    const original=originals.get(item.record),template=original||blocks.at(-1)||model.blocks[0];
    blocks.push({record:item.record,sourceRecord:item.record,key:item.key,text,heading:template?.heading||null,style:{...template?.style},runs:original?revisedRuns(original.runs,text):[{text,style:{}}],list:template?.list||null});
  }
  for(const original of model.blocks)if(!seen.has(original.record)&&original.runs.some(run=>run.image)){
    const next=blocks.findIndex(block=>block.sourceRecord>original.record);
    blocks.splice(next===-1?blocks.length:next,0,{...original,key:undefined,sourceRecord:original.record,text:'',runs:revisedRuns(original.runs,''),retainedMedia:true});
  }
  if(blocks.length>MAX_TEXT_BLOCKS)throw new Error('Редакция DOCX содержит более 2000 абзацев.');
  // Word counts the final paragraph sequence, including a numbered paragraph
  // whose text was removed while its photograph was retained.
  const lists=renderDocxNumbering(model.listData,blocks.map(block=>block.list));
  for(let i=0;i<blocks.length;i++)blocks[i].list=lists[i];
  return {...model,blocks};
}

const encoder=new TextEncoder();
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
const concat=arrays=>{const out=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let offset=0;for(const a of arrays){out.set(a,offset);offset+=a.length;}return out;};
async function zip(entries) {
  const files=[],directory=[];let offset=0,total=0;
  for(const [name,bytes] of entries) {
    total+=bytes.length;if(total>16*1024*1024)throw new Error('DOCX после изменений превышает 16 МиБ.');
    const path=encoder.encode(name),packed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()),crc=crc32(bytes);
    const local=new Uint8Array(30+path.length),l=new DataView(local.buffer);l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(8,8,true);l.setUint32(14,crc,true);l.setUint32(18,packed.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,path.length,true);local.set(path,30);
    const central=new Uint8Array(46+path.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(10,8,true);c.setUint32(16,crc,true);c.setUint32(20,packed.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,path.length,true);c.setUint32(42,offset,true);central.set(path,46);files.push(local,packed);directory.push(central);offset+=local.length+packed.length;
  }
  const central=concat(directory),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,directory.length,true);e.setUint16(10,directory.length,true);e.setUint32(12,central.length,true);e.setUint32(16,offset,true);
  const result=concat([...files,central,end]);if(result.length>MAX_TEXT_SOURCE_BYTES)throw new Error('DOCX после изменений превышает 2 МиБ. Сократите текст.');return result;
}

/** edits changes existing records. Optional sequence replaces paragraph order, permits insertion/deletion. */
export async function writeDocxVisual(source,edits=[],options={}) {
  const checked=await load(source),body=child(checked.doc.documentElement,'body'),paragraphs=elements(body).filter(n=>is(n,'p'));
  if(!Array.isArray(edits)||options.sequence!==undefined&&!Array.isArray(options.sequence))throw new Error('Некорректная редакция DOCX.');
  const selected=options.sequence || paragraphs.map((_,i)=>({record:i+1,text:checked.texts[i]}));
  const patches=new Map();
  for(const edit of edits){if(!Number.isInteger(edit.record)||edit.record<1||edit.record>paragraphs.length||patches.has(edit.record))throw new Error('Некорректный номер абзаца.');patches.set(edit.record,validateText(edit.text));}
  const seen=new Set(),output=[];let chars=0;
  for(const item of selected){
    if(item.record!==undefined&&(!Number.isInteger(item.record)||item.record<1||item.record>paragraphs.length||seen.has(item.record)))throw new Error('Некорректный или повторный номер абзаца.');
    if(item.record!==undefined)seen.add(item.record);
    const text=validateText(patches.get(item.record)??item.text);chars+=[...text].length;if(chars>MAX_TEXT_CHARS||output.length>=MAX_TEXT_BLOCKS)throw new Error('Редакция DOCX превышает ограничение по объёму текста.');
    let p=item.record!==undefined?paragraphs[item.record-1]:null;
    if(!p){const template=output.at(-1)?.node||paragraphs[0],ns=body.namespaceURI,prefix=body.prefix?`${body.prefix}:`:'';p=checked.doc.createElementNS(ns,`${prefix}p`);const pr=template&&child(template,'pPr');if(pr)p.appendChild(pr.cloneNode(true));}
    editParagraph(p,text);output.push({record:item.record,node:p});
  }
  // Removing a textual paragraph must not remove an attached photograph.
  for(let i=0;i<paragraphs.length;i++)if(!seen.has(i+1)&&all(paragraphs[i]).some(n=>is(n,'drawing'))){
    const p=paragraphs[i];editParagraph(p,'');const next=output.findIndex(item=>item.record>i+1);output.splice(next===-1?output.length:next,0,{record:i+1,node:p});
  }
  if(output.length>MAX_TEXT_BLOCKS)throw new Error('Редакция DOCX содержит более 2000 абзацев.');
  for(const p of paragraphs)if(p.parentNode===body)body.removeChild(p);
  const section=child(body,'sectPr');for(const {node} of output)body.insertBefore(node,section||null);
  checked.entries.set('word/document.xml',encoder.encode(checked.doc.toString()));
  return zip(checked.entries);
}
