/** Offline Word list resolution. Values are serializable; marker text is never editable body text.
 * Rules: ISO 29500 §17.9 (Microsoft Open XML SDK LevelRestart, LevelText,
 * StartNumberingValue, NumberingProperties). Symbol mappings: MS-VSDX §2.4.4.44.
 */
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main']);
const elements = n => Array.from(n?.childNodes || []).filter(n => n.nodeType === 1);
const is = (n,k) => !!n && W.has(n.namespaceURI) && n.localName === k;
const fail = reason => { throw new Error(`DOCX: ${reason}`); };
const attr = (n,k) => { for(const ns of W) { const v=n?.getAttributeNS(ns,k); if(v != null)return v; } return null; };
function child(n,k) { const a=elements(n).filter(n=>is(n,k)); if(a.length>1)fail(`неоднозначное свойство списка ${k}.`); return a[0]; }
const val = (n,k) => attr(child(n,k),'val');
function number(value,min=0,max=2147483647) { if(value==null||!/^\d+$/.test(value)||Number(value)<min||Number(value)>max)fail('некорректный номер или уровень списка.');return Number(value); }
const on = n => n && !['0','false','off'].includes(attr(n,'val'));
function childrenOnly(n, names) { for(const c of elements(n))if(!W.has(c.namespaceURI)||!names.includes(c.localName))fail(`свойство списка ${c.localName} пока не поддерживается.`); if(n?.textContent.trim())fail('неподдерживаемый текст в свойствах списка.'); }
function indent(pr) {
  const n=child(pr,'ind'), result={}; if(!n)return result;
  for(const name of ['leftChars','rightChars','firstLineChars','hangingChars','startChars','endChars'])if(attr(n,name)!=null)fail('отступы списка в символах пока не поддерживаются.');
  for(const [name,alias] of [['left','start'],['hanging'],['firstLine']]) {
    const raw=attr(n,alias||name)??attr(n,name); if(raw==null)continue;
    if(!/^-?\d+$/.test(raw)||Math.abs(Number(raw))>31680)fail('отступ списка выходит за поддерживаемые границы.');result[name]=Number(raw)/20;
  }
  return result;
}
function numProperties(pr, inStyle=false) {
  const n=child(pr,'numPr');if(!n)return {};
  childrenOnly(n,['ilvl','numId']); const result={};
  if(child(n,'numId'))result.numId=String(number(val(n,'numId')));
  if(child(n,'ilvl'))result.level=number(val(n,'ilvl'),0,8);
  if(inStyle&&result.level!=null)result.styleLevel=result.level;
  return result;
}
function styles(doc) {
  const root=doc?.documentElement, map=new Map(); let defaultId=null,defaults=null;
  if(!root)return {map,defaultId,defaults};if(!is(root,'styles'))fail('некорректный XML стилей Word.');
  for(const n of elements(root)) {
    if(is(n,'docDefaults'))defaults=child(child(n,'pPrDefault'),'pPr');
    if(!is(n,'style'))continue;
    const id=attr(n,'styleId');if(!id||map.has(id))fail('неоднозначные идентификаторы стилей.');map.set(id,n);
    if(attr(n,'type')==='paragraph'&&['1','true','on'].includes(attr(n,'default'))) {if(defaultId!==null)fail('несколько стилей абзаца по умолчанию.');defaultId=id;}
  }
  return {map,defaultId,defaults};
}
function styleChain(info,p) {
  let id=val(child(p,'pPr'),'pStyle')??info.defaultId;const chain=[],seen=new Set();
  while(id!=null) {if(seen.has(id)||seen.size>=64)fail('циклическое или слишком глубокое наследование стилей.');seen.add(id);const n=info.map.get(id);if(!n)fail('применённый стиль абзаца отсутствует в документе.');if(attr(n,'type')!=='paragraph')fail('применённый стиль не является стилем абзаца.');chain.unshift({id,pr:child(n,'pPr')});id=val(n,'basedOn');}
  return chain;
}
function bullet(text,font) {
  // Word's symbol-font bytes are commonly encoded in the F000 private-use block.
  const map=font.toLowerCase()==='symbol'?{183:'•'}:font.toLowerCase()==='wingdings'?{167:'▪',113:'□',118:'❖',216:'➢',252:'✓'}:null;
  if(map&&[...text].length===1) {let c=text.codePointAt(0);if(c>=0xf000&&c<=0xf0ff)c-=0xf000;if(map[c])return map[c];fail('этот символический маркер списка пока не поддерживается.');}
  if(/(?:wingdings|webdings|symbol)/i.test(font)||/[\uE000-\uF8FF]/u.test(text))fail('этот символический маркер списка пока не поддерживается.');
  return text;
}
function levelDefinition(n,index) {
  if(number(attr(n,'ilvl'),0,8)!==index)fail('уровень замены списка не совпадает с исходным.');
  childrenOnly(n,['start','numFmt','lvlRestart','pStyle','isLgl','suff','lvlText','lvlJc','pPr','rPr','tplc','tentative']);
  const fmt=val(n,'numFmt')??'decimal';if(!['decimal','decimalZero','upperLetter','lowerLetter','upperRoman','lowerRoman','bullet','none'].includes(fmt)||attr(child(n,'numFmt'),'format')!=null)fail('этот формат автоматической нумерации пока не поддерживается.');
  const start=child(n,'start')?number(val(n,'start')):0;
  const suffix=val(n,'suff')??'tab',align=val(n,'lvlJc')??'left';if(!['tab','space','nothing'].includes(suffix)||!['left','right','center','start','end'].includes(align))fail('это расположение маркера списка пока не поддерживается.');
  let text=val(n,'lvlText')??'';if(['1','true','on'].includes(attr(child(n,'lvlText'),'null')))text='';
  if(text.length>256||/[\u0000-\u001f\u007f]/.test(text))fail('слишком длинный или неподдерживаемый маркер списка.');
  const rPr=child(n,'rPr'),markerStyle={};
  if(child(rPr,'b'))markerStyle.fontWeight=on(child(rPr,'b'))?'bold':'normal';
  if(child(rPr,'i'))markerStyle.fontStyle=on(child(rPr,'i'))?'italic':'normal';
  const size=val(rPr,'sz');if(size!=null){const n=number(size,2,400);markerStyle.fontSize=`${n/2}pt`;}
  const color=val(rPr,'color');if(color&&/^[0-9a-f]{6}$/i.test(color))markerStyle.color=`#${color}`;
  if(on(child(rPr,'vanish'))||on(child(rPr,'webHidden')))fail('скрытые маркеры списка пока не поддерживаются.');
  const fontNode=child(rPr,'rFonts');let fontFamily=attr(fontNode,'ascii')??attr(fontNode,'hAnsi')??'';
  if(fmt==='bullet'){text=bullet(text,fontFamily);if(/symbol|wingdings/i.test(fontFamily))fontFamily='';}
  if(fontFamily&&!/^[\p{L}\p{N} _-]{1,80}$/u.test(fontFamily))fontFamily='';
  const rawRestart=child(n,'lvlRestart')?number(val(n,'lvlRestart'),0,9):index;
  // An out-of-range restart is ignored, reverting to the previous level.
  const restart=rawRestart>index?index:rawRestart;
  const pPr=child(n,'pPr');if(child(pPr,'numPr')||on(child(pPr,'bidi')))fail('вложенные или справа налево свойства списка пока не поддерживаются.');
  return {format:fmt,start,text,suffix,align:align==='start'?'left':align==='end'?'right':align,restart,legal:!!on(child(n,'isLgl')),indent:indent(pPr),fontFamily,markerStyle,styleId:val(n,'pStyle')};
}

/** docs are already bounded, safely parsed package XMLs. */
export function parseDocxNumbering(docs, sourceParagraphs) {
  const body=child(docs.get('word/document.xml')?.documentElement,'body'),paragraphs=sourceParagraphs || elements(body).filter(n=>is(n,'p'));
  const info=styles(docs.get('word/styles.xml')),effectInfo=docs.has('word/stylesWithEffects.xml')?styles(docs.get('word/stylesWithEffects.xml')):null;
  if(effectInfo) effectInfo.map=new Map([...info.map,...effectInfo.map]);
  const abstract=new Map(),instances=new Map(),definitions={};const root=docs.get('word/numbering.xml')?.documentElement;
  if(root&&!is(root,'numbering'))fail('некорректный XML автоматической нумерации.');
  for(const n of elements(root)) {
    const kind=is(n,'abstractNum')?'abstractNum':is(n,'num')?'num':null;if(!kind)continue;
    const id=String(number(attr(n,kind==='num'?'numId':'abstractNumId'))),map=kind==='num'?instances:abstract;
    if(map.has(id))fail('повторяющиеся определения списка.');map.set(id,n);
  }
  function definition(id) {
    if(definitions[id])return definitions[id];const instance=instances.get(id);if(!instance)fail('отсутствует определение автоматического списка.');
    childrenOnly(instance,['abstractNumId','lvlOverride']);const abstractId=String(number(val(instance,'abstractNumId'))),base=abstract.get(abstractId);if(!base)fail('отсутствует шаблон автоматического списка.');
    childrenOnly(base,['nsid','multiLevelType','tmpl','name','styleLink','numStyleLink','lvl']);
    if(child(base,'numStyleLink'))fail('связанный стиль автоматической нумерации пока не поддерживается.');
    for(const a of Array.from(base.attributes||[]))if(a.namespaceURI&&!W.has(a.namespaceURI)&&a.namespaceURI!=='http://www.w3.org/2000/xmlns/')fail('расширенные правила перезапуска списка пока не поддерживаются.');
    const rawLevels=new Map();for(const n of elements(base).filter(n=>is(n,'lvl'))){const i=number(attr(n,'ilvl'),0,8);if(rawLevels.has(i))fail('повторяющийся уровень списка.');rawLevels.set(i,n);}
    const overrides=new Map();for(const n of elements(instance).filter(n=>is(n,'lvlOverride'))){const i=number(attr(n,'ilvl'),0,8);if(overrides.has(i))fail('повторяющаяся замена уровня списка.');childrenOnly(n,['startOverride','lvl']);overrides.set(i,n);}
    // Parse levels lazily: unused picture bullets and exotic templates do not block a document.
    const result={levels:Array(9).fill(null)};definitions[id]=result;
    result._get=i=>{if(result.levels[i])return result.levels[i];const override=overrides.get(i),n=child(override,'lvl')??rawLevels.get(i);if(!n)fail('отсутствует используемый уровень списка.');const level=levelDefinition(n,i);if(child(override,'startOverride'))level.start=number(val(override,'startOverride'));result.levels[i]=level;for(const match of level.text.matchAll(/%([1-9])/g)){const ref=Number(match[1])-1;if(ref<=i&&ref!==i)result._get(ref);}return level;};
    result._styleLevel=ids=>{const found=[];for(const [i,n] of rawLevels){const effective=child(overrides.get(i),'lvl')??n;if(ids.includes(val(effective,'pStyle')))found.push(i);}if(found.length>1)fail('неоднозначная связь стиля и уровня списка.');return found[0];};
    return result;
  }
  function descriptor(p,styleInfo) {
    const chain=styleChain(styleInfo,p),direct=child(p,'pPr');let properties=numProperties(styleInfo.defaults),styleOwner=null;
    for(const item of chain) {const current=numProperties(item.pr,true);properties={...properties,...current};if(current.numId!=null)styleOwner=item.id;}
    const applied=numProperties(direct);properties={...properties,...applied};
    if(properties.numId==='0')return null;
    if(properties.numId==null){if(properties.level!=null)fail('уровень списка указан без определения нумерации.');return null;}
    let ind=indent(styleInfo.defaults);for(const item of chain)ind={...ind,...indent(item.pr)};ind={...ind,...indent(direct)};
    const def=definition(properties.numId);let level=applied.level;
    if(level==null&&styleOwner){const linked=def._styleLevel(chain.map(x=>x.id));if(linked!=null&&properties.styleLevel!=null&&linked!==properties.styleLevel)fail('неоднозначный уровень нумерации в стиле Word.');level=linked??properties.styleLevel;}
    level??=properties.level??0;def._get(level);
    return {numId:properties.numId,level,indent:ind};
  }
  const descriptors=paragraphs.map(p=>{
    const a=descriptor(p,info);if(effectInfo){const b=descriptor(p,effectInfo);if(JSON.stringify(a)!==JSON.stringify(b))fail('нумерация в stylesWithEffects отличается от основного стиля.');}return a;
  });
  // Also initialize referenced restart levels needed by future reordered projections.
  for(const def of Object.values(definitions)){delete def._get;delete def._styleLevel;}
  const data={definitions,paragraphs:descriptors};renderDocxNumbering(data);return data;
}
function formatNumber(n,format) {
  if(format==='decimal')return String(n);if(format==='decimalZero')return String(n).padStart(2,'0');if(format==='none')return '';
  if(n<1)fail('буквенная или римская нумерация должна начинаться с положительного числа.');
  if(format==='upperLetter'||format==='lowerLetter') {if(n>18278)fail('слишком длинная буквенная нумерация.');const s=String.fromCharCode(65+(n-1)%26).repeat(Math.floor((n-1)/26)+1);return format==='lowerLetter'?s.toLowerCase():s;}
  if(format==='upperRoman'||format==='lowerRoman'){if(n>3999)fail('римская нумерация больше 3999 пока не поддерживается.');let s='';for(const [v,k] of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']])while(n>=v){s+=k;n-=v;}return format==='lowerRoman'?s.toLowerCase():s;}
  fail('маркер списка нельзя использовать как числовой уровень.');
}
/** Recompute markers after insertion/deletion/reordering. Dimensions are points. */
export function renderDocxNumbering(data,descriptors=data.paragraphs) {
  const states=new Map();return descriptors.map(d=>{
    if(!d)return null;const def=data.definitions[d.numId],rule=def?.levels[d.level];if(!rule)fail('отсутствует правило отображения списка.');
    let counters=states.get(d.numId);if(!counters){counters=Array(9).fill(null);states.set(d.numId,counters);}
    for(let i=0;i<d.level;i++)if(counters[i]==null&&def.levels[i])counters[i]=def.levels[i].start;
    const n=counters[d.level]==null?rule.start:counters[d.level]+1;if(n>2147483647)fail('слишком большой номер списка.');counters[d.level]=n;
    // Word also restarts descendants when an earlier ancestor is used, even if
    // intermediate levels have no displayed paragraphs (verified with native DOCX).
    for(let i=d.level+1;i<9;i++){const lower=def.levels[i];if(lower&&lower.restart>0&&d.level<lower.restart)counters[i]=null;}
    const label=rule.format==='none'?'':rule.format==='bullet'?rule.text:rule.text.replace(/%([1-9])/g,(_,digit)=>{const i=Number(digit)-1;if(i>d.level)return '';const referenced=def.levels[i];if(!referenced)fail('отсутствует уровень составного номера.');return formatNumber(counters[i]??referenced.start,rule.legal?'decimal':referenced.format);});
    return {...d,label,suffix:rule.suffix,align:rule.align,fontFamily:rule.fontFamily,markerStyle:rule.markerStyle,indent:{left:0,hanging:0,firstLine:0,...rule.indent,...d.indent}};
  });
}
