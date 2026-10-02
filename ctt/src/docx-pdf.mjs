/** Local, searchable PDF of the same edited Word model shown in the editor. */
import {PDFDocument, fontkit, rgb} from './pdf-vendor.mjs';
import regularBytes from './pdf-font.mjs';
import boldBytes from './word-font-bold.mjs';
const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const pt=(s,fallback=0)=>typeof s==='number'?s:typeof s==='string'&&/^\d+(?:\.\d+)?(?:pt|px)?$/.test(s)?parseFloat(s)*(s.endsWith('px')?.75:1):fallback;
const color=(s,fallback='#202820')=>{const value=/^#[a-f\d]{6}$/i.test(s||'')?s:fallback;return rgb(...[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255));};
const fail=message=>{throw new Error(message);};
const abort=signal=>{if(signal?.aborted)throw new DOMException('Canceled','AbortError');};

export async function renderDocxPdf(model,{signal,onLayout}={}) {
  abort(signal);
  if(!model?.blocks?.length||!model.page)fail('The Word document could not be prepared. Download DOCX to keep editing.');
  if(model.pdfUnsupported?.length)fail(model.pdfUnsupported[0]);
  const pageWidth=model.page.width*.75,pageHeight=model.page.height*.75;
  const margins=Object.fromEntries(['Left','Right','Top','Bottom'].map(k=>[k.toLowerCase(),model.page['margin'+k]*.75]));
  const usable=pageWidth-margins.left-margins.right,bodyHeight=pageHeight-margins.top-margins.bottom;
  if(![pageWidth,pageHeight,usable,bodyHeight].every(n=>Number.isFinite(n)&&n>24))fail('The page margins leave too little room for a PDF.');
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
  const fonts={regular:await pdf.embedFont(decode(regularBytes),{subset:true,features:{liga:false}}),bold:await pdf.embedFont(decode(boldBytes),{subset:true,features:{liga:false}})};
  const supported=new Map(Object.values(fonts).map(f=>[f,new Set(f.getCharacterSet())]));
  const pictures=new Map(),layout=[];let work=0;
  const cooperate=async()=>{if(++work%20===0){await new Promise(r=>setTimeout(r,0));abort(signal);}};
  function typography(style={},heading){return {font:style.fontWeight==='bold'||!style.fontWeight&&heading?fonts.bold:fonts.regular,size:pt(style.fontSize,heading?Math.max(12,24-heading*2):11),color:color(style.color),italic:style.fontStyle==='italic',decoration:style.textDecoration||''};}
  function checkText(text,font){for(const c of text)if(!supported.get(font).has(c.codePointAt(0)))fail('This document contains a character that the PDF fonts cannot display. Download DOCX to preserve it.');}
  async function imageFor(image){
    if(!pictures.has(image.src)){const match=/^data:image\/(png|jpeg);base64,([A-Za-z\d+/=]+)$/.exec(image.src);if(!match)fail('An image could not be included in the PDF.');const bytes=decode(match[2]);pictures.set(image.src,await(match[1]==='png'?pdf.embedPng(bytes):pdf.embedJpg(bytes)));}
    return pictures.get(image.src);
  }
  async function paragraph(block,width){
    if(!block)fail('A paragraph is missing from the Word document.');
    const style=block.style||{},base=typography(style,block.heading),left=block.list?Math.max(0,block.list.indent?.left??(block.list.level+1)*36):pt(style.paddingLeft),right=pt(style.paddingRight);
    const indent=block.list?0:pt(style.textIndent),available=width-left-right;
    if(available<8)fail('A paragraph is too narrow. Download DOCX to adjust its indentation.');
    const before=pt(style.marginTop,block.heading?10:0),after=pt(style.marginBottom,block.heading?7:6),ratio=Math.max(1.15,Number(style.lineHeight)||1.3);
    const fragments=[];let items=[],used=0,first=true,forced=false;
    function flush(force=false){if(!items.length&&!force)return;const textHeight=Math.max(base.size*ratio,...items.filter(i=>!i.image).map(i=>i.size*ratio));const height=Math.max(textHeight,...items.filter(i=>i.image).map(i=>i.height));const shift=['center'].includes(style.textAlign)?Math.max(0,(available-(first?indent:0)-used)/2):['right','end'].includes(style.textAlign)?Math.max(0,available-(first?indent:0)-used):0;fragments.push({height,items:items.map(i=>({...i,x:i.x+left+(first?indent:0)+shift})),key:block.key,record:block.record,first,breakBefore:forced});items=[];used=0;first=false;forced=false;}
    const room=()=>available-(first?indent:0);
    function addText(text,format){
      text=text.replace(/\t/g,'    ').replace(/\r\n?/g,'\n');checkText(text.replace(/\n/g,''),format.font);
      for(const token of text.match(/\n|[^\S\n]+|[^\s]+/gu)||[]){
        if(token==='\n'){flush(true);continue;}
        const space=/^\s+$/u.test(token),tokenWidth=format.font.widthOfTextAtSize(token,format.size);
        if(used+tokenWidth>room()&&items.length){flush();if(space)continue;}
        if(tokenWidth<=room()){items.push({...format,text:token,x:used,width:tokenWidth});used+=tokenWidth;continue;}
        // Long unbroken identifiers must wrap too, never get clipped at a cell edge.
        let chunk='';for(const c of token){const next=chunk+c,w=format.font.widthOfTextAtSize(next,format.size);if(w>room()&&chunk){const cw=format.font.widthOfTextAtSize(chunk,format.size);items.push({...format,text:chunk,x:0,width:cw});used=cw;flush();chunk=c;}else chunk=next;if(format.font.widthOfTextAtSize(c,format.size)>room())fail('A character is wider than its table cell. Download DOCX to widen the column.');}
        if(chunk){const cw=format.font.widthOfTextAtSize(chunk,format.size);items.push({...format,text:chunk,x:used,width:cw});used+=cw;}
      }
    }
    for(const run of block.runs||[{text:block.text,style:{}}]){
      if(run.pageBreak&&run.text==='\n'){flush();forced=true;continue;}
      if(run.image){const image=await imageFor(run.image),w=run.image.width*.75,h=run.image.height*.75,scale=Math.min(1,available/w,(bodyHeight-20)/h);if(!(w>0&&h>0&&scale>0))fail('An image has invalid dimensions.');if(used+w*scale>room())flush();items.push({image,width:w*scale,height:h*scale,x:used});used+=w*scale;}
      else addText(run.text,typography({...style,...run.style},block.heading));
      await cooperate();
    }
    flush(!fragments.length||forced);
    if(block.list&&fragments.length){const fmt=typography({...style,...block.list.markerStyle}),label=block.list.label;checkText(label,fmt.font);const w=fmt.font.widthOfTextAtSize(label,fmt.size);fragments[0].items.unshift({...fmt,text:label,x:Math.max(0,left-w-5),width:w});}
    if(fragments.length){fragments[0].before=before;fragments[0].breakBefore ||= block.pageBreakBefore;fragments.at(-1).after=after;}
    return fragments;
  }
  let page,y;
  function newPage(){abort(signal);if(pdf.getPageCount()>=500)fail('The PDF would exceed 500 pages. Shorten the document.');page=pdf.addPage([pageWidth,pageHeight]);y=margins.top;}
  newPage();
  function drawFragment(fragment,x,top){
    for(const item of fragment.items){
      if(item.image){page.drawImage(item.image,{x:x+item.x,y:pageHeight-top-fragment.height,width:item.width,height:item.height});continue;}
      const baseline=pageHeight-top-fragment.height+item.size*.24;
      page.drawText(item.text,{x:x+item.x,y:baseline,font:item.font,size:item.size,color:item.color,...(item.italic?{xSkew:{type:'degrees',angle:12}}:{})});
      for(const [kind,offset]of [['underline',-.1],['line-through',.3]])if(item.decoration.includes(kind))page.drawLine({start:{x:x+item.x,y:baseline+item.size*offset},end:{x:x+item.x+item.width,y:baseline+item.size*offset},thickness:Math.max(.4,item.size*.05),color:item.color});
    }
    layout.push({page:pdf.getPageCount(),key:fragment.key,record:fragment.record,x,y:top,width:usable,height:fragment.height});
  }
  async function flowParagraph(block){const lines=await paragraph(block,usable);for(const line of lines){if(line.breakBefore&&y>margins.top)newPage();const before=line.before||0;if(y+before+line.height>pageHeight-margins.bottom)newPage();if(line.height>bodyHeight)fail('A text line is taller than the PDF page.');y+=before;drawFragment(line,margins.left,y);y+=line.height+(line.after||0);}}
  const blocks=new Map(model.blocks.map(b=>[b.record,b]));
  async function table(table){
    const specified=table.style?.width,gridTotal=table.widths.reduce((n,w)=>n+w,0);let width=typeof specified==='string'&&specified.endsWith('%')?usable*parseFloat(specified)/100:pt(specified,gridTotal?gridTotal/20:usable);width=Math.min(usable,Math.max(24,width));
    const widths=table.widths.map(w=>gridTotal?w/gridTotal*width:width/table.widths.length),offsets=[0];for(const w of widths)offsets.push(offsets.at(-1)+w);
    const tableX=margins.left+(table.style?.marginLeft==='auto'?(usable-width)/(table.style?.marginRight==='auto'?2:1):0),heights=table.rows.map(()=>0),cells=[];
    for(let row=0;row<table.rows.length;row++)for(const cell of table.rows[row].cells){
      const style=cell.style||{},col=cell.column-1,w=offsets[col+cell.colSpan]-offsets[col],padding={top:pt(style.paddingTop,4),bottom:pt(style.paddingBottom,4),left:pt(style.paddingLeft,5),right:pt(style.paddingRight,5)},lines=[];
      for(const p of cell.content)lines.push(...await paragraph(blocks.get(p.record),w-padding.left-padding.right));
      if(lines.some(l=>l.breakBefore))fail('A page break inside a table cell cannot be exported yet. Download DOCX to preserve it.');
      let top=padding.top;for(const line of lines){top+=line.before||0;line.top=top;top+=line.height+(line.after||0);}const needed=top+padding.bottom;
      if(cell.rowSpan===1)heights[row]=Math.max(heights[row],needed);
      cells.push({row,span:cell.rowSpan,col,width:w,style,padding,lines,needed});
    }
    for(let i=0;i<heights.length;i++)heights[i]=Math.max(heights[i],12);
    for(const cell of cells){const total=heights.slice(cell.row,cell.row+cell.span).reduce((a,b)=>a+b,0);if(total<cell.needed)heights[cell.row+cell.span-1]+=cell.needed-total;}
    const tops=[0];for(const height of heights)tops.push(tops.at(-1)+height);
    for(const cell of cells){cell.top=tops[cell.row];cell.height=tops[cell.row+cell.span]-cell.top;const spare=cell.height-cell.needed,shift=cell.style.verticalAlign==='middle'?spare/2:cell.style.verticalAlign==='bottom'?spare:0;for(const line of cell.lines)line.top+=cell.top+shift;}
    // Row groups connected by vertical merges stay together when they fit a page.
    const groups=[];for(let start=0;start<heights.length;){let end=start+1;for(let r=start;r<end;r++)for(const cell of cells.filter(c=>c.row===r))end=Math.max(end,r+cell.span);groups.push({top:tops[start],bottom:tops[end]});start=end;}
    function border(value,x1,y1,x2,y2){if(!value||/\bnone\b/.test(value))return;const parts=value.split(' '),thickness=pt(parts[0],.5);page.drawLine({start:{x:x1,y:pageHeight-y1},end:{x:x2,y:pageHeight-y2},thickness,color:color(parts.at(-1),'#333333'),...(/dotted|dashed/.test(value)?{dashArray:[thickness*(value.includes('dotted')?1:3),thickness*2]}:{})});if(value.includes('double'))page.drawLine({start:{x:x1,y:pageHeight-y1-2},end:{x:x2,y:pageHeight-y2-2},thickness:thickness/2,color:color(parts.at(-1),'#333333')});}
    for(const group of groups){const height=group.bottom-group.top;if(height<=bodyHeight&&y+height>pageHeight-margins.bottom)newPage();let start=group.top;
      while(start<group.bottom-.01){abort(signal);let end=Math.min(group.bottom,start+pageHeight-margins.bottom-y);
        const relevant=cells.filter(c=>c.top<group.bottom&&c.top+c.height>group.top),lines=relevant.flatMap(c=>c.lines);
        // Move the cut to a gap shared by all cells, never through a text line or image.
        for(;;){const crossing=lines.filter(l=>l.top<end-.01&&l.top+l.height>end+.01&&l.top+l.height>start+.01);if(!crossing.length)break;end=Math.min(...crossing.map(l=>l.top));}
        if(end<=start+.01){if(y>margins.top){newPage();continue;}fail('A table image or line is taller than the page. Download DOCX to adjust it.');}
        for(const cell of relevant){const from=Math.max(start,cell.top),to=Math.min(end,cell.top+cell.height);if(to<=from)continue;const x=tableX+offsets[cell.col],top=y+from-start,h=to-from,s=cell.style;
          if(s.backgroundColor)page.drawRectangle({x,y:pageHeight-top-h,width:cell.width,height:h,color:color(s.backgroundColor)});
          border(s.borderLeft,x,top,x,top+h);border(s.borderRight,x+cell.width,top,x+cell.width,top+h);border(s.borderTop,x,top,x+cell.width,top);border(s.borderBottom,x,top+h,x+cell.width,top+h);
          for(const line of cell.lines)if(line.top>=start-.01&&line.top+line.height<=end+.01)drawFragment(line,x+cell.padding.left,y+line.top-start);
        }
        y+=end-start;start=end;if(start<group.bottom-.01)newPage();await cooperate();
      }
    }
    y+=8;
  }
  if(model.hasTables){for(const item of model.content){if(item.type==='table')await table(item);else await flowParagraph(blocks.get(item.record));await cooperate();}}
  else for(const block of model.blocks){await flowParagraph(block);await cooperate();}
  abort(signal);pdf.setCreator('Compare These Texts');const bytes=await pdf.save();abort(signal);if(bytes.length>32*1024*1024)fail('The PDF is too large. Reduce image sizes in the Word document.');onLayout?.(layout);return bytes;
}
