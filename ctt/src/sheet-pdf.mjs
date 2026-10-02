import {sheetPdfFont} from './sheet-pdf-font.mjs';
import {PDFDocument,fontkit,rgb} from './pdf-vendor.mjs';
import normalBytes from './pdf-font.mjs';
import boldBytes from './word-font-bold.mjs';
const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const abort=signal=>{if(signal?.aborted)throw new DOMException('Canceled','AbortError');};
const color=s=>rgb(...[1,3,5].map(i=>parseInt(s.slice(i,i+2),16)/255));
const ink=rgb(.10,.19,.15),grid=rgb(.74,.80,.77),head=rgb(.88,.93,.90);

/** Keep every column on the same page width, expanding the PDF when needed. */
export async function renderSheetPdf(model,{signal,onLayout}={}){
 abort(signal);if(!model?.rows?.length||!model.columns?.length||!model.rows[model.header])throw Error('The table header could not be found.');
 const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
 const baseNormal=await pdf.embedFont(decode(normalBytes),{subset:true,features:{liga:false}}),baseBold=await pdf.embedFont(decode(boldBytes),{subset:true,features:{liga:false}});
 const boldChars=new Set(baseBold.getCharacterSet()),ordinary=new Set(baseNormal.getCharacterSet().filter(cp=>boldChars.has(cp)));
 const needsFallback=text=>Array.from(String(text)).some(c=>!/[\s\p{Default_Ignorable_Code_Point}]/u.test(c)&&!ordinary.has(c.codePointAt(0)))||(/\p{Extended_Pictographic}/u.test(text)&&/[\u200d\ufe0f]/u.test(text));
 let emoji=baseNormal;
 if(needsFallback(model.name)||needsFallback(model.sheet)||model.rows.some(row=>row.cells.some(cell=>needsFallback(cell.text)))){
  const {default:emojiBytes}=await import('./sheet-emoji-font.mjs');
  // Keep the static font intact: fontkit subsetting drops outlines for some emoji.
  emoji=await pdf.embedFont(decode(emojiBytes),{subset:false});
 }
 const normal=sheetPdfFont(baseNormal,emoji),bold=sheetPdfFont(baseBold,emoji);
 const pad=5,margin=32,layout=[];let size=9.5,lineHeight=13,work=0;
 async function yieldWork(){if(++work%100===0){await new Promise(r=>setTimeout(r,0));abort(signal);}}
 const clean=text=>text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ');
 function check(text,font){font.check(text);}
 // Measure display values, not original Excel column widths. Headers may wrap.
 const metrics=model.columns.map(()=>({preferred:0,word:0,numeric:0,hasValue:false,allNumeric:true}));
 const number=/^[+-]?(?:[$€£]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/;
 for(let r=0;r<model.rows.length;r++){
  for(let c=0;c<metrics.length;c++){
   const text=clean(model.rows[r].cells[c].text),font=r===model.header?bold:normal,m=metrics[c];check(text,font);
   for(const line of text.split('\n')){
    const width=font.widthOfTextAtSize(line,9.5);m.preferred=Math.max(m.preferred,Math.min(180,width));
    for(const token of line.match(/\S+/gu)||[])m.word=Math.max(m.word,Math.min(86,font.widthOfTextAtSize(token,9.5)));
   }
   if(r!==model.header&&text.trim()){
    m.hasValue=true;const numeric=!text.includes('\n')&&(model.rows[r].cells[c].align==='right'||number.test(text.trim())||/^\d{4}-\d{2}-\d{2}$/.test(text));
    m.allNumeric&&=numeric;if(numeric)m.numeric=Math.max(m.numeric,font.widthOfTextAtSize(text,9.5));
   }
  }await yieldWork();
 }
 const sum=values=>values.reduce((a,b)=>a+b,0),portrait=595.28-margin*2,wide=841.89-margin*2;
 function measures(fontSize){const scale=fontSize/9.5;
  const minima=metrics.map(m=>m.hasValue&&m.allNumeric?Math.max(28*scale,m.numeric*scale,Math.min(44,m.word)*scale)+pad*2:Math.max(44,m.word)*scale+pad*2);
  const preferred=metrics.map((m,i)=>Math.max(minima[i],m.preferred*scale+pad*2));return {minima,preferred};
 }
 const base=measures(9.5),landscape=sum(base.preferred)>portrait;let pageWidth=landscape?841.89:595.28,pageHeight=landscape?595.28:841.89,available=pageWidth-margin*2;
 let widths,bands;
 for(const candidate of [9.5,9,8.5]){
  const {minima,preferred}=measures(candidate),minimum=sum(minima),natural=sum(preferred);if(minimum>available)continue;
  const ratio=natural>available?(available-minimum)/(natural-minimum):1;
  widths=minima.map((min,i)=>min+(preferred[i]-min)*ratio);size=candidate;lineHeight=13*size/9.5;
  const headerHeight=Math.max(...widths.map((width,c)=>wrap(model.rows[model.header].cells[c].text,bold,width-pad*2).length))*lineHeight+pad*2;
  if(headerHeight>Math.min(180,(pageHeight-margin-15-68)/2))continue;
  bands=[widths.map((_,i)=>i)];break;
 }
 if(!bands){
  size=9.5;lineHeight=13;
  // A wider digital page preserves the table instead of cutting columns into parts.
  widths=metrics.map(m=>Math.max(66,Math.min(190,m.preferred+pad*2)));
  pageWidth=Math.max(841.89,sum(widths)+margin*2);pageHeight=841.89;available=pageWidth-margin*2;
  if(pageWidth>14400)throw Error('This table is too wide for one PDF page. Select fewer columns.');
  bands=[widths.map((_,i)=>i)];
 }
 function wrap(text,font,width){
  const lines=[];let line='';
  for(const paragraph of clean(text).split('\n')){
   for(const token of paragraph.match(/\s+|\S+/gu)||[]){const w=font.widthOfTextAtSize(line+token,size);if(w<=width){line+=token;continue;}if(line){lines.push(line.trimEnd());line='';}if(/^\s+$/u.test(token))continue;
    if(font.widthOfTextAtSize(token,size)<=width){line=token;continue;}
    for(const char of font.graphemes(token)){if(font.widthOfTextAtSize(line+char,size)>width){if(!line)throw Error('A column is too narrow for its text.');lines.push(line);line='';}line+=char;}
   }
   lines.push(line.trimEnd());line='';
  }
  return lines;
 }
 let page,y,pageInfo=[];
 function clipped(text,font,max){text=String(text).replace(/[\r\n\t]/g,' ');check(text,font);if(font.widthOfTextAtSize(text,11)<=max)return text;while(text&&font.widthOfTextAtSize(text+'…',11)>max)text=font.graphemes(text).slice(0,-1).join('');return text+'…';}
 if(model.rows.some(row=>row.cells.some(cell=>cell.colSpan>1||cell.rowSpan>1))){
  const {drawMergedSheet}=await import('./sheet-pdf-merged.mjs');
  await drawMergedSheet({pdf,model,widths,pageWidth,pageHeight,normal,bold,size,lineHeight,pad,margin,wrap,clipped,color,ink,grid,head,layout,pageInfo,abort:()=>abort(signal),yieldWork});
 }else{
 for(let part=0;part<bands.length;part++){
  const cols=bands[part],width=cols.reduce((n,c)=>n+widths[c],0),header=model.rows[model.header],headerLines=cols.map(c=>wrap(header.cells[c].text,bold,widths[c]-pad*2)),headerHeight=Math.max(...headerLines.map(l=>l.length))*lineHeight+pad*2;
  const top=68,bottom=pageHeight-margin-15;
  if(headerHeight>Math.min(180,(bottom-top)/2))throw Error('The column headings are too long to repeat clearly. Shorten the headings or download the spreadsheet.');
  function drawRow(row,lines,start,count,isHeader=false,continued=false){let x=margin;const height=count*lineHeight+pad*2;
   for(let i=0;i<cols.length;i++){const c=cols[i],cell=row.cells[c],w=widths[c],font=isHeader?bold:normal;page.drawRectangle({x,y:pageHeight-y-height,width:w,height,borderWidth:.45,borderColor:grid,color:isHeader?head:cell.fill?color(cell.fill):rgb(1,1,1)});
    for(let l=0;l<count;l++){const text=lines[i][start+l]??'',tw=font.widthOfTextAtSize(text,size),tx=x+(cell.align==='right'?w-pad-tw:pad);if(text)font.drawText(page,text,{x:tx,y:pageHeight-y-pad-size-l*lineHeight,size,color:!isHeader&&cell.foreground?color(cell.foreground):ink});}
    layout.push({page:pdf.getPageCount(),part:part+1,row:row.number,column:model.columns[c],header:isHeader,continued,x,y,width:w,height,fontSize:size,pageWidth,pageHeight,padding:pad,lineWidths:lines[i].slice(start,start+count).map(text=>font.widthOfTextAtSize(text,size)),lines:lines[i].slice(start,start+count)});x+=w;
   }y+=height;
  }
  function newPage(continued=false){abort(signal);if(pdf.getPageCount()>=500)throw Error('This table would exceed 500 PDF pages. Select a smaller sheet.');page=pdf.addPage([pageWidth,pageHeight]);y=top;bold.drawText(page,clipped(model.name,bold,available),{x:margin,y:pageHeight-margin-11,size:11,font:bold,color:ink});
   const columnLabel=cols.map(c=>model.columns[c]),range=part?`${columnLabel[0]}, ${columnLabel.length===2?columnLabel[1]:columnLabel[1]+'–'+columnLabel.at(-1)}`:`${columnLabel[0]}–${columnLabel.at(-1)}`,subtitle=`${model.sheet} · Columns ${range}${bands.length>1?` · Part ${part+1} of ${bands.length}`:''}${continued?' · Continued row':''}`;
   normal.drawText(page,clipped(subtitle,normal,available),{x:margin,y:pageHeight-margin-27,size:9,font:normal,color:ink});pageInfo.push({page,part});drawRow(header,headerLines,0,Math.max(...headerLines.map(l=>l.length)),true);
  }
  newPage();
  for(let r=0;r<model.rows.length;r++){
   if(r===model.header)continue;const row=model.rows[r],lines=cols.map(c=>wrap(row.cells[c].text,normal,widths[c]-pad*2)),length=Math.max(...lines.map(l=>l.length)),height=length*lineHeight+pad*2,capacity=bottom-top-headerHeight;
   if(height<=capacity&&y+height>bottom)newPage();let start=0;
   while(start<length){const count=Math.min(length-start,Math.floor((bottom-y-pad*2)/lineHeight));if(count<1){newPage(start>0);continue;}drawRow(row,lines,start,count,false,start>0);start+=count;if(start<length)newPage(true);await yieldWork();}
  }
 }
 }
 const pages=pdf.getPageCount();for(let i=0;i<pageInfo.length;i++){const {page}=pageInfo[i],label=`${i+1} / ${pages}`;normal.drawText(page,label,{x:pageWidth-margin-normal.widthOfTextAtSize(label,8),y:18,font:normal,size:8,color:ink});}
 abort(signal);pdf.setCreator('Compare These Texts');const bytes=await pdf.save();abort(signal);if(bytes.length>32*1024*1024)throw Error('The PDF is too large. Download the spreadsheet instead.');onLayout?.(layout);return bytes;
}
