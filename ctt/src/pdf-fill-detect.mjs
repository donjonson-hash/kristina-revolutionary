/** Conservative suggestions for printed blanks; all coordinates are scale-1 viewport points. */
import {getDocument} from './pdf-reader-vendor.mjs';
import {PDFDocument, fontkit} from './pdf-vendor.mjs';
import fontBase64 from './pdf-font.mjs';
import {planPdfFillField} from './pdf-fill.mjs';
const abort = signal => { if (signal?.aborted) throw new DOMException('Canceled', 'AbortError'); };
const identity = [1, 0, 0, 1, 0, 0];
const point = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const multiply = (a,b) => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],...point(a,b[4],b[5])];
class NoExternalData { async fetch() { throw new Error('PDF: External resources are not supported.'); } }
let measurePromise;
async function measureFont() {
  return measurePromise ||= (async () => {
    const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
    return doc.embedFont(Uint8Array.from(atob(fontBase64), c => c.charCodeAt(0)), {subset:true,features:{liga:false}});
  })();
}
/** Keep a printed blank on one line; general manually selected areas may wrap. */
export async function fitPdfFillText(field, {minFontSize = 8, signal} = {}) {
  abort(signal);
  const font = await measureFont(); abort(signal);
  if (!Number.isFinite(minFontSize) || minFontSize < 6 || minFontSize > 72) throw new Error('PDF: Choose a minimum size between 6 and 72.');
  const align = size => {
    if (!field.detected || !Number.isFinite(field.lineY)) return {...field,fontSize:size};
    const height=font.heightAtSize(size)+1;
    return {...field,fontSize:size,y:field.lineY-height-1,height};
  };
  const viewport = {width:field.x+field.width,height:Math.max(field.y+field.height,field.lineY||0),transform:identity};
  const maximum = field.fontSize;
  // Validation errors unrelated to fitting must retain their original explanation.
  const fits = size => {
    try {
      const aligned=align(size);
      if (Number.isFinite(field.fitAreaY) && aligned.y < field.fitAreaY-.001) return false;
      if (Number.isFinite(field.fitAreaHeight) && aligned.height > field.fitAreaHeight+.001) return false;
      const plan = planPdfFillField(aligned, viewport, font);
      return !field.detected || plan.lines.length === 1;
    } catch (error) {
      if (/does not fit|not fit vertically/.test(error.message)) return false;
      throw error;
    }
  };
  if (fits(maximum)) return align(maximum);
  const minimum = Math.min(maximum,minFontSize);
  if (!fits(minimum)) throw new Error('PDF: This text needs more room. Shorten it or open Format to enlarge the area.');
  let low=minimum, high=maximum;
  for(let i=0;i<14;i++){const mid=(low+high)/2;if(fits(mid))low=mid;else high=mid;}
  return align(Math.floor(low*100)/100);
}
export async function detectPdfFillAreas(source, {page = 1, signal, generated = false} = {}) {
  abort(signal);
  let raw;
  if(generated) raw=source?.data;
  else if(typeof source?.data==='string' && source.data.length<=Math.ceil(2*1024*1024/3)*4){
    try{raw=Uint8Array.from(atob(source.data),c=>c.charCodeAt(0));}catch{}
  }
  if(!(raw instanceof Uint8Array)||!raw.length||raw.length>(generated?64:2)*1024*1024)throw new Error('PDF: Invalid source for finding blank lines.');
  const loading=getDocument({data:raw.slice(),stopAtErrors:true,isEvalSupported:false,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,useWasm:false,enableXfa:false,disableAutoFetch:true,disableStream:true,disableRange:true,verbosity:0,BinaryDataFactory:NoExternalData});
  const cancel=()=>{void loading.destroy().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  try{
    const reader=await loading.promise;abort(signal);
    if(!Number.isInteger(page)||page<1||page>reader.numPages)throw new Error('PDF: Choose an existing page.');
    const sheet=await reader.getPage(page), viewport=sheet.getViewport({scale:1});
    const [content,ops,font]=await Promise.all([sheet.getTextContent(),sheet.getOperatorList(),measureFont()]);abort(signal);
    const lines=[], obstacles=[];
    const addLine=(p,q)=>{if(Math.abs(p[1]-q[1])<.65&&Math.abs(p[0]-q[0])>=8)lines.push({x:Math.min(p[0],q[0]),right:Math.max(p[0],q[0]),y:(p[1]+q[1])/2});};
    // Use actual glyph advances and TJ kerning, not character counts: labels and
    // underscores commonly share one text item and use a proportional font.
    const runs=[];let runFont;
    for(let n=0;n<ops.fnArray.length;n++){
      if(ops.fnArray[n]===37)runFont=ops.argsArray[n]?.[0];
      if(ops.fnArray[n]!==44)continue;
      let text='',advance=0;const offsets=[0];
      for(const glyph of ops.argsArray[n]?.[0]||[]){
        if(typeof glyph==='number'){advance-=glyph;offsets[text.length]=advance;continue;}
        const value=glyph.unicode||'',width=glyph.width||0;
        for(let k=0;k<value.length;k++)offsets.push(advance+width*(k+1)/value.length);
        text+=value;advance+=width;
      }
      if(text&&advance>0)runs.push({font:runFont,text,offsets});
    }
    for(const item of content.items){
      if(!item.str?.trim())continue;
      const m=multiply(viewport.transform,item.transform), size=Math.hypot(m[2],m[3]);
      if(Math.abs(m[1])>.01||m[0]<=0)continue;
      const width=item.width*Math.hypot(...viewport.transform.slice(0,2));
      const style=content.styles[item.fontName]||{}, ascent=Number.isFinite(style.ascent)?style.ascent:.85;
      const run=runs.find(r=>r.font===item.fontName&&r.text.includes(item.str));
      const start=run?.text.indexOf(item.str), total=run?run.offsets[start+item.str.length]-run.offsets[start]:0;
      const offset=i=>total>0?(run.offsets[start+i]-run.offsets[start])/total*width:i/item.str.length*width;
      const obstacle=(a,b)=>{if(item.str.slice(a,b).trim())obstacles.push({x:m[4]+offset(a),right:m[4]+offset(b),top:m[5]-size*ascent,bottom:m[5]+size*.15,size});};
      let cursor=0;
      for(const match of item.str.matchAll(/_{2,}/g)){
        obstacle(cursor,match.index);
        addLine([m[4]+offset(match.index),m[5]+size*.08],[m[4]+offset(match.index+match[0].length),m[5]+size*.08]);
        cursor=match.index+match[0].length;
      }
      obstacle(cursor,item.str.length);
    }
    // PDF.js 6.3 operator numbers and compact path commands are pinned by the bundled reader.
    let ctm=identity.slice(), lineWidth=1;const stack=[];
    for(let n=0;n<ops.fnArray.length;n++){
      const op=ops.fnArray[n],args=ops.argsArray[n];
      if(op===10||op===74){stack.push({ctm:ctm.slice(),lineWidth});if(op===74&&args?.[0])ctm=multiply(ctm,args[0]);}
      else if(op===11||op===75){const saved=stack.pop();if(saved){ctm=saved.ctm;lineWidth=saved.lineWidth;}}
      else if(op===12)ctm=multiply(ctm,args);
      else if(op===2)lineWidth=args[0];
      else if(op===91&&[20,21,22,23,24,25,26,27].includes(args?.[0])){
        const matrix=multiply(viewport.transform,ctm), data=args[1]?.[0];
        if(!ArrayBuffer.isView(data)&&!Array.isArray(data))continue;
        const segments=[];let cursor=null,start=null,curved=false;
        for(let k=0;k<data.length;){const command=data[k++];
          if(command===0){cursor=point(matrix,data[k++],data[k++]);start=cursor;}
          else if(command===1){const next=point(matrix,data[k++],data[k++]);if(cursor)segments.push([cursor,next]);cursor=next;}
          else if(command===4){if(cursor&&start)segments.push([cursor,start]);cursor=start;}
          else if(command===2||command===3){k+=command===2?6:4;cursor=null;curved=true;}
          else{curved=true;break;}
        }
        if(curved)continue;
        const coords=segments.flat();if(!coords.length)continue;
        const xs=coords.map(p=>p[0]),ys=coords.map(p=>p[1]);
        const spanY=Math.max(...ys)-Math.min(...ys);
        if([22,23].includes(args[0])){
          if(spanY<=2)addLine([Math.min(...xs),Math.min(...ys)],[Math.max(...xs),Math.min(...ys)]);
        }else if(lineWidth*Math.hypot(matrix[0],matrix[1])<=2){
          // Large closed rectangles are tables/borders, not handwriting blanks.
          if(spanY>3&&segments.length>2)continue;
          for(const [p,q] of segments)addLine(p,q);
        }
      }
    }
    const areas=[];
    for(const line of lines.sort((a,b)=>a.y-b.y||a.x-b.x)){
      const padding=line.right-line.x<32?1:2;
      const left=Math.max(0,line.x+padding),right=Math.min(viewport.width,line.right-padding);
      const nearby=obstacles.filter(o=>Math.abs(o.bottom-line.y)<24&&o.right>=left-120&&o.x<=right+40);
      const sizes=nearby.map(o=>o.size).filter(s=>s>=8&&s<=18).sort((a,b)=>a-b);
      const size=sizes.length?sizes[Math.floor(sizes.length/2)]:12;
      const minimumHeight=font.heightAtSize(8)+1;
      const previous=lines.filter(l=>l.y<line.y-2&&l.right>left&&l.x<right).reduce((max,l)=>Math.max(max,l.y),0);
      const previousGap=line.y-previous-minimumHeight-1<2?1:2;
      let fitAreaY=Math.max(0,line.y-font.heightAtSize(size)-2,previous+previousGap);
      // A label above a blank limits its height, not its width. Fit vertically
      // first so the first address/issuer line remains available end to end.
      for(const o of obstacles){
        if(o.right<=left||o.x>=right)continue;
        if(o.bottom+1<=line.y-minimumHeight-1)fitAreaY=Math.max(fitAreaY,o.bottom+1);
      }
      if(line.y>viewport.height)continue;
      let spans=[[left,right]];
      for(const o of obstacles){if(o.bottom<=fitAreaY||o.top>=line.y-1)continue;
        spans=spans.flatMap(([a,b])=>o.right<=a||o.x>=b?[[a,b]]:[[a,Math.max(a,o.x-1)],[Math.min(b,o.right+1),b]]);
      }
      for(const [x,end] of spans){if(end-x<6)continue;
        // An underline directly beneath text can leave tiny margins: require a useful blank.
        if(end-x<(right-left)*.2)continue;
        if(areas.some(a=>Math.abs(a.lineY-line.y)<2&&Math.abs(a.x-x)<4&&Math.abs(a.width-(end-x))<6))continue;
        const fitAreaHeight=line.y-fitAreaY-1;
        const fontSize=Math.min(size,(fitAreaHeight-1)/font.heightAtSize(1));
        if(fontSize<8-.001)continue;
        const actualHeight=font.heightAtSize(fontSize)+1;
        areas.push({id:`blank-${page}-${areas.length+1}`,page,x,y:line.y-actualHeight-1,width:end-x,height:actualHeight,fontSize,lineY:line.y,fitAreaY,fitAreaHeight,detected:true,text:''});
        if(areas.length>=100)break;
      }
      if(areas.length>=100)break;
    }
    return {width:viewport.width,height:viewport.height,areas};
  }finally{signal?.removeEventListener('abort',cancel);await loading.destroy();}
}
