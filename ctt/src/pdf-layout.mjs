/** Preserve untouched page pixels and graphics while expanding edited text bands. */
import {openPdfVisual, samplePdfPatch, measurePdfFont} from './pdf-visual.mjs';
import {PDFDocument, fontkit, rgb} from './pdf-vendor.mjs';
import fontBase64 from './pdf-font.mjs';
const fail=message=>{throw Error('PDF layout: '+message+' You can still download a text-only PDF.');};
const abort=signal=>{if(signal?.aborted)throw new DOMException('Canceled','AbortError');};
const bounds=block=>{const v=block.visual,rs=v?.rects;if(v?.rasterBoundsUncertain)fail('The visible text boundaries cannot be determined safely.');if(!rs?.length||rs.some(r=>Math.abs(r.angle)>1||![r.x,r.y,r.width,r.height,r.fontSize].every(Number.isFinite)))fail('This section has unsupported text geometry.');const x=Math.min(...rs.map(r=>r.x)),y=Math.min(...rs.map(r=>r.y));return {x,y,width:Math.max(...rs.map(r=>r.x+r.width))-x,height:Math.max(...rs.map(r=>r.y+r.height))-y,size:Math.min(...rs.map(r=>r.fontSize)),page:v.page};};
async function wrap(text,font,size,width,signal){
 const lines=[];let work=0;
 for(const paragraph of text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n')){
  let line='';
  for(const token of paragraph.match(/\s+|\S+/gu)||[]){
   if(line.length+token.length<2048&&font.widthOfTextAtSize(line+token,size)<=width){line+=token;continue;}
   if(line){lines.push(line.trimEnd());line='';}if(/^\s+$/u.test(token))continue;
   const chars=Array.from(token);let at=0;
   while(at<chars.length){let lo=1,hi=Math.min(64,chars.length-at);while(hi<chars.length-at&&font.widthOfTextAtSize(chars.slice(at,at+hi).join(''),size)<=width){lo=hi;hi=Math.min(hi*2,chars.length-at);}while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(font.widthOfTextAtSize(chars.slice(at,at+mid).join(''),size)<=width)lo=mid;else hi=mid-1;}const part=chars.slice(at,at+lo).join('');if(font.widthOfTextAtSize(part,size)>width+.01)fail('The text area is too narrow.');at+=lo;if(at<chars.length)lines.push(part);else line=part;if(++work%64===0){await new Promise(r=>setTimeout(r,0));abort(signal);}}
  }
  lines.push(line.trimEnd());if(++work%64===0){await new Promise(r=>setTimeout(r,0));abort(signal);}
 }
 return lines;
}
// Link wrapped display lines to offsets in the unmodified editable text.
function lineOffsets(text,lines){
 let normalized='',map=[];
 for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='\r'&&text[i+1]==='\n')continue;const part=ch==='\t'?'    ':ch==='\r'?'\n':ch;normalized+=part;for(let j=0;j<part.length;j++)map.push(i);}map.push(text.length);
 let cursor=0;return lines.map(line=>{const start=line?normalized.indexOf(line,cursor):cursor;if(start<0)throw Error('Could not locate the displayed text.');const end=start+line.length;cursor=end;if(!line&&normalized[cursor]==='\n')cursor++;return {text:line,start:map[start],end:map[end]};});
}
function collectChanges(entries,blocks){
 const groups=new Map();for(const b of blocks){if(!groups.has(b.key))groups.set(b.key,[]);groups.get(b.key).push(b);}
 const current=new Map();for(const e of entries){if(!current.has(e.key))current.set(e.key,[]);current.get(e.key).push(e.text);}
 const order=[...groups.keys()],positions=[...current.keys()].filter(k=>groups.has(k)).map(k=>order.indexOf(k));
 if(positions.some((v,i)=>i&&v<positions[i-1]))fail('Moving sections with their original page artwork is not supported yet.');
 const changes=[];
 for(const [key,parts]of groups){const text=current.has(key)?current.get(key).join('\n'):'';if(text===parts.map(p=>p.text).join('\n'))continue;for(let i=0;i<parts.length;i++)changes.push({key,block:parts[i],text:i===0?text:''});}
 for(const [key,texts]of current){if(groups.has(key))continue;const keys=[...current.keys()],i=keys.indexOf(key),next=keys.slice(i+1).find(k=>groups.has(k)),previous=keys.slice(0,i).reverse().find(k=>groups.has(k));const anchor=next?groups.get(next)[0]:previous?groups.get(previous).at(-1):blocks[0];if(!anchor)fail('An original text position is required.');const box=bounds(anchor);changes.push({key,text:texts.join('\n'),added:true,box:{...box,y:next?Math.max(0,box.y-2):box.y+box.height+2,height:0},block:anchor});}
 return changes;
}
export async function renderPreservedPdf(source,entries,{blocks,signal,onLayout}={}){
 abort(signal);
 if(entries?.some(e=>e.pdfBox))fail('A replacement block cannot be combined with page reflow yet. Adjust the other overflowing text first.');
 if(!Array.isArray(entries)||entries.some(e=>typeof e.text!=='string')||entries.reduce((n,e)=>n+e.text.length,0)>500000||!Array.isArray(blocks)||!blocks.length||blocks.some(b=>typeof b.key!=='string'))fail('Full document text is required.');
 const viewer=await openPdfVisual(source,{signal});
 try {blocks=await viewer.refineBlocks(blocks);} catch(error){await viewer.dispose();throw error;}
 let changes;try{changes=collectChanges(entries,blocks);}catch(error){await viewer.dispose();throw error;}
 const layout=[],removed=new Set(changes.filter(c=>!c.added).map(c=>c.block.record));
 const output=await PDFDocument.create();output.registerFontkit(fontkit);const font=await output.embedFont(Uint8Array.from(atob(fontBase64),c=>c.charCodeAt(0)),{subset:true,features:{liga:false}}),measure=await measurePdfFont();
 let bytes=0;
 try{for(let n=1;n<=viewer.pageCount;n++){
  abort(signal);const canvas=document.createElement('canvas'),scale=2;
  try{
   const {width,height,images}=await viewer.renderPage(n,canvas,{scale,trackImages:true}),ctx=canvas.getContext('2d');
   const originals=blocks.filter(b=>b.visual.page===n),pageChanges=changes.filter(c=>(c.box?.page??c.block.visual.page)===n),patches=[];
   for(const change of pageChanges){const box=change.box??bounds(change.block);
    if(box.width<=0||box.size<1||box.x<0||box.y<0||box.x+box.width>width+.1||box.y+box.height>height+.1)fail('The text area extends beyond the page.');
    const plan={...box,text:change.text},sample=change.added?{background:[255,255,255],foreground:[0,0,0],patch:{x:box.x*scale,y:box.y*scale,width:0,height:0}}:samplePdfPatch(ctx,plan,scale,canvas,{ignoreRects:originals.filter(b=>b.record!==change.block.record).flatMap(b=>b.visual.rects)});
    if(!change.added){const oldEnd=sample.patch.y+sample.patch.height;sample.patch.y=Math.max(sample.patch.y,Math.floor(box.y*scale));sample.patch.height=Math.min(oldEnd,Math.ceil((box.y+box.height)*scale))-sample.patch.y;}
    const top=sample.patch.y/scale,bottom=(sample.patch.y+sample.patch.height)/scale;
    if(images.some(i=>(top<i.y+i.height+2&&bottom>i.y-2&&box.x<i.x+i.width+2&&box.x+box.width>i.x-2)||(top>i.y-2&&top<i.y+i.height+2)||(bottom>i.y-2&&bottom<i.y+i.height+2)))fail('This edit shares a band with an image.');
    if(originals.some(b=>b.record!==change.block.record&&!removed.has(b.record)&&b.visual.rects.some(r=>r.x<(sample.patch.x+sample.patch.width)/scale&&r.x+r.width>sample.patch.x/scale&&r.y<bottom&&r.y+r.height>top)))fail('Text areas overlap here.');
    const lines=change.text?lineOffsets(change.text,await wrap(change.text,measure,box.size,box.width,signal)):[];
    patches.push({...plan,...sample,key:change.key,top,bottom,lines,lineHeight:box.size*1.4,added:change.added});
   }
   // Validate everything before erasing original words from the raster.
   for(const p of patches)if(!p.added){ctx.fillStyle=`rgb(${p.background.join(',')})`;ctx.fillRect(p.patch.x,p.patch.y,p.patch.width,p.patch.height);}
   const bands=[];for(const p of patches.sort((a,b)=>a.top-b.top)){let band=bands.at(-1);if(!band||p.top>band.bottom){band={top:p.top,bottom:p.bottom,patches:[]};bands.push(band);}band.bottom=Math.max(band.bottom,p.bottom);band.patches.push(p);}
   for(const band of bands){const placed=[];for(const p of band.patches){p.flowTop=p.top;for(const previous of placed)if(p.x<previous.x+previous.width&&p.x+p.width>previous.x)p.flowTop=Math.max(p.flowTop,previous.flowTop+previous.lines.length*previous.lineHeight);if(p.lines.length)placed.push(p);}}
   const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
   const blankRow=y=>{const iy=Math.max(0,Math.min(canvas.height-1,Math.floor(y*scale))),offset=iy*canvas.width*4;for(let x=0;x<canvas.width;x++){const at=offset+x*4;if(rgba[at]<250||rgba[at+1]<250||rgba[at+2]<250)return false;}return true;};
   let lastInk=canvas.height-1;while(lastInk>0&&blankRow(lastInk/scale))lastInk--;
   const sourceEnd=Math.min(height,Math.max((lastInk+1)/scale,...bands.map(b=>b.bottom),...originals.filter(b=>!removed.has(b.record)).flatMap(b=>b.visual.rects.map(r=>r.y+r.height)),...images.map(i=>i.y+i.height))+12);
   const nodes=[];let sourceY=0;
   for(const band of bands){if(band.top>sourceY)nodes.push({start:sourceY,original:band.top-sourceY,height:band.top-sourceY,patches:[]});const oldHeight=band.bottom-band.top;const needed=Math.max(oldHeight,...band.patches.map(p=>p.flowTop-band.top+2+p.lines.length*p.lineHeight));nodes.push({start:band.top,original:oldHeight,height:needed,patches:band.patches});sourceY=band.bottom;}
   if(sourceY<sourceEnd)nodes.push({start:sourceY,original:sourceEnd-sourceY,height:sourceEnd-sourceY,patches:[]});
   let page=output.addPage([width,height]),cursor=0;
   const newPage=()=>{abort(signal);if(output.getPageCount()>=500)fail('The edited document has too many pages.');page=output.addPage([width,height]);cursor=0;};
   for(const node of nodes){let offset=0;const lines=node.patches.flatMap(p=>p.lines.map((line,i)=>({key:p.key,text:line.text,textStart:line.start,textEnd:line.end,x:p.x,top:p.flowTop-node.start+2+i*p.lineHeight,size:p.size,height:p.lineHeight,color:p.foreground,background:p.background,width:p.width})));
    const protectedRanges=[...originals.filter(b=>!removed.has(b.record)).flatMap(b=>b.visual.rects.map(r=>[r.y-node.start-1,r.y+r.height-node.start+1])),...images.map(i=>[i.y-node.start-2,i.y+i.height-node.start+2]),...lines.map(l=>[l.top,l.top+l.height])];
    while(offset<node.height-.01){abort(signal);let length=Math.min(height-cursor,node.height-offset);
     if(length<node.height-offset-.01){let cut=offset+length;while(cut>offset+1){const hit=protectedRanges.find(([a,b])=>cut>a+.01&&cut<b-.01);if(hit){cut=hit[0];continue;}if(cut<node.original&&!blankRow(node.start+cut)){cut-=.5;continue;}break;}if(cut<=offset+1){if(cursor>0){newPage();continue;}fail('A page element cannot be split safely.');}length=cut-offset;}
     if(length<.5){newPage();continue;}
     const oldLength=Math.max(0,Math.min(length,node.original-offset));
     if(oldLength>0){const crop=document.createElement('canvas');try{crop.width=canvas.width;crop.height=Math.max(1,Math.round(oldLength*scale));crop.getContext('2d').drawImage(canvas,0,Math.round((node.start+offset)*scale),canvas.width,crop.height,0,0,crop.width,crop.height);const blob=await new Promise((resolve,reject)=>crop.toBlob(b=>b?resolve(b):reject(Error('Could not save page artwork.')),'image/png'));bytes+=blob.size;if(bytes>32*1024*1024)fail('The edited PDF is too large.');const image=await output.embedPng(await blob.arrayBuffer());page.drawImage(image,{x:0,y:height-cursor-oldLength,width,height:oldLength});}finally{crop.width=crop.height=0;}}
     for(const line of lines.filter(l=>l.top>=offset-.01&&l.top<offset+length-.01)){const top=cursor+line.top-offset;layout.push({key:line.key,textStart:line.textStart,textEnd:line.textEnd,page:output.getPageCount(),x:line.x/width,y:top/height,width:line.width/width,height:line.height/height});if(line.top+line.height>node.original)page.drawRectangle({x:line.x,y:height-top-line.height,width:line.width,height:line.height,color:rgb(...line.background.map(v=>v/255))});if(line.text)page.drawText(line.text,{x:line.x,y:height-top-line.size,size:line.size,font,color:rgb(...line.color.map(v=>v/255))});}
     for(const b of originals.filter(b=>!removed.has(b.record)))for(const r of b.visual.rects){const relative=r.y-node.start;if(relative>=offset-.01&&relative<offset+oldLength-.01)layout.push({key:b.key,record:b.record,page:output.getPageCount(),x:r.x/width,y:(cursor+relative-offset)/height,width:r.width/width,height:r.height/height});}
     for(const b of originals.filter(b=>!removed.has(b.record))){const r=b.visual.rects[0],relative=r.y-node.start;if(relative>=offset-.01&&relative<offset+oldLength-.01)page.drawText(b.text,{x:r.x,y:height-cursor-(relative-offset)-r.height*.8,size:r.fontSize,font,opacity:0,rotate:{type:'degrees',angle:-r.angle}});}
     offset+=length;cursor+=length;if(offset<node.height-.01)newPage();await new Promise(r=>setTimeout(r,0));
    }
   }
  }finally{canvas.width=canvas.height=0;}
 }
 output.setCreator('Compare These Texts');abort(signal);const data=await output.save();abort(signal);onLayout?.(layout);return data;
 }finally{await viewer.dispose();}
}
