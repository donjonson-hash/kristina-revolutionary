/** Full, local PDF page rendering and bounded edits of existing text areas. */
import {getDocument} from './pdf-reader-vendor.mjs';
import {PDFDocument, fontkit, rgb} from './pdf-vendor.mjs';
import fontBase64 from './pdf-font.mjs';
import {refineRasterBounds} from './pdf-raster-bounds.mjs';
import {createPdfEditFonts} from './pdf-edit-fonts.mjs';

const MAX_BYTES = 2 * 1024 * 1024, MAX_PIXELS = 16_000_000;
const fail = message => { throw new Error(`PDF: ${message}`); };
const abort = signal => { if (signal?.aborted) throw new DOMException("Canceled", 'AbortError'); };
class NoExternalData {
  async fetch() { fail("this page requires external fonts or data. Save the PDF with embedded fonts."); }
}
function bytes(source) {
  if (typeof source?.data !== 'string' || source.data.length > Math.ceil(MAX_BYTES / 3) * 4) fail("files up to 2 MiB are supported.");
  let raw;
  try { raw = Uint8Array.from(atob(source.data), value => value.charCodeAt(0)); } catch { fail("couldn't read the file."); }
  if (!raw.length || raw.length > MAX_BYTES) fail("a nonempty file up to 2 MiB is required.");
  return raw;
}
export function pdfBlockRects(block) {
  return (block?.source_blocks || [block]).flatMap(part => {
    const visual = part?.visual;
    if (!visual || !(visual.width > 0) || !(visual.height > 0)) return [];
    return visual.rects.map(rect => ({page: visual.page, x: rect.x / visual.width, y: rect.y / visual.height,
      width: rect.width / visual.width, height: rect.height / visual.height}));
  });
}
/** Conservative starting area shared by inline fitting and the block dialog. */
export function defaultPdfBlockBox(block, blocks = []) {
  const {rects,width,height,page}=block.visual, x=Math.min(...rects.map(r=>r.x)), y=Math.min(...rects.map(r=>r.y));
  const minWidth=Math.max(...rects.map(r=>r.x+r.width))-x, minHeight=Math.max(...rects.map(r=>r.y+r.height))-y;
  const fontSize=Math.min(...rects.map(r=>r.fontSize)), ceil=v=>Math.ceil(v*100)/100;
  const nextX=blocks.filter(b=>b.record!==block.record&&b.visual?.page===page).flatMap(b=>b.visual.rects).filter(r=>r.x>=x+minWidth&&r.y<y+Math.max(minHeight,fontSize*1.3)&&r.y+r.height>y).map(r=>r.x-x-r.fontSize*1.5-3);
  return {width:Math.min(width-x,ceil(Math.max(minWidth,Math.min(minWidth*1.5,...nextX)))),height:Math.min(height-y,ceil(Math.max(minHeight,fontSize*1.3))),fontSize};
}
export function fitPdfBlockFont(text, box, originalSize, font) {
  const lines=text.replace(/\r\n?/g,'\n').split('\n'), natural=Math.max(0,...lines.map(line=>font.widthOfTextAtSize(line,originalSize)));
  const size=Math.max(originalSize*.8,Math.min(originalSize,natural?originalSize*box.width/natural:originalSize,box.height/(lines.length*1.3)));
  return Math.max(originalSize*.8,Math.floor(size*100)/100);
}
/** Validation shared by preview and export; never truncate an overflowing edit. */
export function planPdfEdits(edits, pageNumber, font, blocks = []) {
  const plans = [];
  for (const edit of edits) {
    if (edit.text === edit.block?.text && !edit.box) continue;
    if (typeof edit.text !== 'string' || edit.text.length > 500000) fail("invalid replacement text.");
    const visual = edit.block?.visual;
    if (visual?.rasterBoundsUncertain) fail('the visible text boundaries cannot be determined safely.');
    if (!visual?.rects?.length) fail("to add or move sections, save a text version.");
    if (visual.page !== pageNumber) continue;
    if (visual.rects.some(rect => ![rect.x, rect.y, rect.width, rect.height, rect.fontSize, rect.angle].every(Number.isFinite) || rect.width < 0 || rect.height <= 0 || Math.abs(rect.angle) > 1)) fail("rotated text can currently only be saved in a text version.");
    const x = Math.min(...visual.rects.map(rect => rect.x)), y = Math.min(...visual.rects.map(rect => rect.y));
    const right = Math.max(...visual.rects.map(rect => rect.x + rect.width)), bottom = Math.max(...visual.rects.map(rect => rect.y + rect.height));
    if (x < 0 || y < 0 || right > visual.width || bottom > visual.height) fail("the section extends beyond the page boundaries.");
    let size = Math.min(...visual.rects.map(rect => rect.fontSize));
    if(edit.box){
      const box=edit.box;
      if(box.fontSize!==undefined){if(!Number.isFinite(box.fontSize)||box.fontSize<1||box.fontSize>512)fail('Choose a valid text size.');size=box.fontSize;}
      if(![box.width,box.height].every(v=>Number.isFinite(v)&&v>0)||box.width<right-x||box.height<bottom-y||x+box.width>visual.width||y+box.height>visual.height)fail('The replacement block must cover the old text and stay on the page.');
      const lines=[];for(const paragraph of edit.text.replace(/\r\n?/g,'\n').split('\n')){let line='';for(const word of paragraph.split(/\s+/u)){if(font.widthOfTextAtSize(word,size)>box.width)fail('A word does not fit. Widen the block or shorten the text.');const next=line?line+' '+word:word;if(line&&font.widthOfTextAtSize(next,size)>box.width){lines.push(line);line=word;}else line=next;}lines.push(line);}
      const lineHeight=size*1.3;if(lines.length*lineHeight>box.height+.01)fail('The text needs more room. Widen the block or make it taller.');
      plans.push({x,y,width:box.width,height:box.height,size,text:edit.text,page:pageNumber,record:edit.block.record,lines,lineHeight,sourceRect:{x,y,width:right-x,height:bottom-y}});continue;
    }
    if (/\r|\n/.test(edit.text)) fail("the new paragraph doesn't fit on the original line. Save a text version.");
    const naturalWidth = font.widthOfTextAtSize(edit.text, size);
    if (naturalWidth > right - x) size *= (right - x) / naturalWidth;
    if (size < Math.min(...visual.rects.map(rect => rect.fontSize)) * 0.8) {
      const box=defaultPdfBlockBox(edit.block,blocks);box.fontSize=fitPdfBlockFont(edit.text,box,box.fontSize,font);
      // Only a one-line replacement may grow sideways automatically. The renderer
      // checks neighboring text, images and the complete added area before painting.
      if(font.widthOfTextAtSize(edit.text,box.fontSize)>box.width+.001)fail("the new text doesn't fit. Adjust the text area.");
      const [plan]=planPdfEdits([{...edit,box}],pageNumber,font,blocks);plans.push({...plan,autoFit:true});continue;
    }
    plans.push({x, y, width: right - x, height: bottom - y, size, text: edit.text, page: pageNumber});
  }
  return plans;
}
let measurePromise, screenFontPromise;
async function measureFont() {
  return measurePromise ||= (async () => {
    const document = await PDFDocument.create();
    document.registerFontkit(fontkit);
    return document.embedFont(Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)), {subset: true, features: {liga: false}});
  })();
}
export async function validatePdfEdits(edits, {blocks = [], viewer} = {}) {
  for (const edit of edits) {
    const selected = viewer && edit.text !== edit.block?.text ? await viewer.editFont(edit.block, edit.text) : null;
    planPdfEdits([edit], edit.block?.visual?.page, selected?.font || await measureFont(), blocks);
  }
}
/** Use the same source font when fitting the block dialog. */
export async function measurePdfBlockFont(source, block, text) {
  const viewer = await openPdfVisual(source);
  try { return (await viewer.editFont(block, text))?.font || await measureFont(); }
  finally { await viewer.dispose(); }
}
async function screenFont() {
  if (!screenFontPromise) screenFontPromise = (async () => {
    const face = new FontFace('KristinaPdfRevision', Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)));
    await face.load(); document.fonts.add(face);
  })().catch(error => { screenFontPromise = undefined; throw error; });
  return screenFontPromise;
}
function samplePatch(context, plan, scale, canvas, {padding=2,ignoreRects=[]}={}) {
  const x = Math.max(0, Math.floor(plan.x * scale) - padding), y = Math.max(0, Math.floor(plan.y * scale) - padding);
  const width = Math.min(canvas.width - x, Math.ceil(plan.width * scale) + padding*2);
  const height = Math.min(canvas.height - y, Math.ceil(plan.height * scale) + padding*2);
  const {data} = context.getImageData(x, y, width, height);
  const colorAt = (cx, cy) => Array.from(data.subarray((cy * width + cx) * 4, (cy * width + cx) * 4 + 3));
  const samples = [];
  const sample=(cx,cy)=>{const px=(x+cx)/scale,py=(y+cy)/scale;if(!ignoreRects.some(r=>px>=r.x-.5&&px<=r.x+r.width+.5&&py>=r.y-.5&&py<=r.y+r.height+.5))samples.push(colorAt(cx,cy));};
  for (let index = 0; index < width; index += Math.max(1, Math.floor(width / 24))) {sample(index, 0);sample(index, height - 1);}
  for (let index = 0; index < height; index += Math.max(1, Math.floor(height / 12))) {sample(0, index);sample(width - 1, index);}
  if(!samples.length)fail('the text background cannot be determined.');
  const background = samples[0], distance = color => Math.max(...color.map((value, i) => Math.abs(value - background[i])));
  if (samples.some(color => distance(color) > 35)) fail("the background behind the text is not uniform. Save a text version for this edit.");
  let foreground = [0, 0, 0], contrast = 0;
  for (let index = 0; index < data.length; index += 4) {
    const color = Array.from(data.subarray(index, index + 3)), delta = distance(color);
    if (delta > contrast) { foreground = color; contrast = delta; }
  }
  return {...plan, patch: {x, y, width, height}, background, foreground};
}
async function paintPlans(canvas, plans, scale, {text = true, blocks = [], images = []} = {}) {
  const context = canvas.getContext('2d');
  // Validate every background before touching the canvas.
  const sampled = plans.map(plan => {
    if(!plan.lines)return samplePatch(context, plan, scale, canvas);
    if(!blocks.length)fail('The full document is required to replace a block.');
    const source=plan.sourceRect,overlap=(a,b)=>a.x<b.x+b.width+1&&a.x+a.width>b.x-1&&a.y<b.y+b.height+1&&a.y+a.height>b.y-1;
    const target=blocks.find(b=>b.record===plan.record&&b.visual.page===plan.page);
    if(!target)fail('The original block could not be located.');
    if(blocks.some(b=>b.record!==target.record&&b.visual.page===plan.page&&b.visual.rects.some(r=>overlap(plan,r)))||plans.some(p=>p!==plan&&overlap(plan,p)))fail('The replacement block overlaps nearby text. Resize it to leave that text visible.');
    if(images.some(i=>overlap(plan,i)&&!(i.width>=canvas.width/scale*.9&&i.height>=canvas.height/scale*.9)))fail('The replacement block overlaps an image.');
    const sample=samplePatch(context,source,scale,canvas),area=context.getImageData(Math.floor(plan.x*scale),Math.floor(plan.y*scale),Math.ceil(plan.width*scale),Math.ceil(plan.height*scale));
    for(let y=0;y<area.height;y++)for(let x=0;x<area.width;x++){const px=plan.x+x/scale,py=plan.y+y/scale;if(px<=source.x+source.width+1&&py<=source.y+source.height+1)continue;const at=(y*area.width+x)*4;if(sample.background.some((v,i)=>Math.abs(area.data[at+i]-v)>35))fail('The extra space contains artwork or another background. Resize the block.');}
    return {...plan,...{patch:sample.patch,background:sample.background,foreground:sample.foreground}};
  });
  if (text && sampled.some(plan => plan.text && (!plan.editFont || plan.editFont.name === 'DejaVuSans'))) await screenFont();
  for (const plan of sampled) {
    context.fillStyle = `rgb(${plan.background.join(',')})`;
    context.fillRect(plan.patch.x, plan.patch.y, plan.patch.width, plan.patch.height);
    if (text && plan.text) {
      context.fillStyle = `rgb(${plan.foreground.join(',')})`;
      const selected = plan.editFont;
      context.font = `${selected?.style || 'normal'} ${selected?.weight || 'normal'} ${plan.size * scale}px ${selected?.family || 'KristinaPdfRevision'}`;
      context.fontKerning = 'none'; context.textBaseline = 'alphabetic';
      if(plan.lines)plan.lines.forEach((line,i)=>context.fillText(line,plan.x*scale,(plan.y+plan.size+i*plan.lineHeight)*scale));else context.fillText(plan.text, plan.x * scale, (plan.baseline ?? plan.y + plan.height * 0.8) * scale);
    }
  }
  return sampled;
}

export async function openPdfVisual(source, {signal, generated = false} = {}) {
  abort(signal);
  const data = generated ? source?.data : bytes(source);
  if (generated && (!(data instanceof Uint8Array) || !data.length || data.length > 64 * 1024 * 1024)) fail('the generated preview is too large.');
  const loading = getDocument({data: generated ? data.slice() : data, stopAtErrors: true, isEvalSupported: false,
    disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    useWasm: false, enableXfa: false, disableAutoFetch: true,
    disableStream: true, disableRange: true, verbosity: 0, BinaryDataFactory: NoExternalData});
  let disposed = false;
  const tasks = new Set();
  const dispose = async () => { if (disposed) return; disposed = true; signal?.removeEventListener('abort', cancelled); for (const task of tasks) task.cancel(); await loading.destroy(); };
  const cancelled = () => { void dispose().catch(() => {}); };
  signal?.addEventListener('abort', cancelled, {once: true});
  try {
    const doc = await loading.promise;
    abort(signal);
    if (doc.numPages < 1 || doc.numPages > (generated ? 500 : 100)) fail("documents with 1 to 100 pages are supported.");
    let parsedBlocks;
    const editFont = createPdfEditFonts(doc, async () => {
      parsedBlocks ||= import('./pdf-source.mjs').then(({readPdfBytes}) => readPdfBytes(bytes(source))).then(result => result.blocks);
      return parsedBlocks;
    });
    return {pageCount: doc.numPages, rects: pdfBlockRects, dispose, editFont,
      async refineBlocks(blocks) {
        let result=blocks.slice();
        for(const number of new Set(blocks.filter(b=>b.visual?.rasterBoundsVersion!==2).map(b=>b.visual.page))){
          abort(signal); const canvas=document.createElement('canvas');
          try {const {width,height,images}=await this.renderPage(number,canvas,{scale:2,trackImages:true});
            if(images.length){const refined=refineRasterBounds(canvas,result.filter(b=>b.visual.page===number),width,height,images,2),map=new Map(refined.map(b=>[b.record,b]));result=result.map(b=>map.get(b.record)||b);}
          } finally {canvas.width=canvas.height=0;}
        }
        return result;
      },
      async renderPage(pageNumber, canvas, {scale = 1, edits = [], eraseOnly = false, trackImages = false, blocks = []} = {}) {
        abort(signal); if (disposed) fail("the preview is already closed.");
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) fail("page not found.");
        if (!Number.isFinite(scale) || scale <= 0 || scale > 4) fail("unsupported page scale.");
        const page = await doc.getPage(pageNumber), viewport = page.getViewport({scale});
        if (viewport.width * viewport.height > MAX_PIXELS) fail("the page is too large to display.");
        const plans = [];
        for (const edit of edits.filter(edit => edit.block?.visual?.page === pageNumber)) {
          if (edit.text === edit.block.text && !edit.box) continue;
          const selected = await editFont(edit.block, edit.text);
          plans.push(...planPdfEdits([edit], pageNumber, selected?.font || await measureFont(), blocks).map(plan => ({...plan, editFont:selected, baseline:edit.block.visual.rasterBoundsVersion === 2 ? undefined : edit.block.visual.rects[0].baselineY})));
        }
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const task = page.render({canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)', annotationMode: 0, recordImages: trackImages || plans.some(p=>p.lines)});
        tasks.add(task);
        try { await task.promise; abort(signal);
          const images=[];const coords=trackImages||plans.some(p=>p.lines)?page.imageCoordinates:[];for(let i=0;coords&&i+5<coords.length;i+=6){const [x0,y0,x1,y1,x2,y2]=coords.slice(i,i+6),xs=[x0,x1,x2,x1+x2-x0],ys=[y0,y1,y2,y1+y2-y0];images.push({x:Math.min(...xs)*viewport.width/scale,y:Math.min(...ys)*viewport.height/scale,width:(Math.max(...xs)-Math.min(...xs))*viewport.width/scale,height:(Math.max(...ys)-Math.min(...ys))*viewport.height/scale});}
          const painted=await paintPlans(canvas,plans,scale,{text:!eraseOnly,blocks,images});
          return {width: viewport.width / scale, height: viewport.height / scale, painted, images};
        } finally { tasks.delete(task); page.cleanup(); }
      }
    };
  } catch (error) { await dispose().catch(() => {}); throw error; }
}

/** Preserve each original run's font in the rebuilt searchable layer as well.
 * This keeps later edits of untouched text tied to its original typeface.
 */
export async function drawPdfOriginalText(page, block, viewer, output, fallback, {height, offsetY = 0} = {}) {
  const runs = block.visual.textRuns || block.visual.rects;
  for (const rect of runs) {
    const text = Number.isInteger(rect.textStart) ? block.text.slice(rect.textStart, rect.textEnd) : block.text;
    if (!text) continue;
    let font = fallback;
    try {
      const part = Number.isInteger(rect.textItemIndex) ? {...block, visual:{...block.visual, fontItems:[rect.textItemIndex]}} : block;
      font = (await viewer.editFont(part, text, output))?.font || fallback;
    } catch (error) {
      // An unsupported font in untouched raster artwork must not prevent edits
      // elsewhere. The explicit text-only export remains available for it.
      if (!error.message?.startsWith('PDF:')) throw error;
    }
    page.drawText(text, {x:rect.x, y:height-offsetY-(rect.baselineY ?? rect.y+rect.height*.8),
      size:rect.fontSize, font, opacity:0, rotate:{type:'degrees',angle:-rect.angle}});
    if (!Number.isInteger(rect.textStart)) break;
  }
}

/** A flattened copy: original pixels plus corrections, never original hidden text. */
export async function renderPdfRevision(source, edits, {signal, blocks} = {}) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 2000) fail("saving requires the full document text. Run the comparison again.");
  const ordered = blocks.slice().sort((a, b) => a.record - b.record), originals = new Map(ordered.map(block => [block.record, block]));
  if (originals.size !== ordered.length || ordered.some((block, index) => block.record !== index + 1 || typeof block.text !== 'string' || !block.visual?.rects?.length)) fail("saving requires the full document text. Run the comparison again.");
  const replacements = new Map();
  for (const edit of edits) {
    if (!originals.has(edit.block?.record) || originals.get(edit.block.record).text !== edit.block.text || replacements.has(edit.block.record)) fail("to add or move sections, save a text version.");
    replacements.set(edit.block.record, edit.text);
  }
  const viewer = await openPdfVisual(source, {signal});
  try {
    const refined=await viewer.refineBlocks(ordered),byRecord=new Map(refined.map(b=>[b.record,b]));
    ordered.splice(0,ordered.length,...refined);edits=edits.map(edit=>({...edit,block:byRecord.get(edit.block.record)}));
    const output = await PDFDocument.create(); output.registerFontkit(fontkit);
    const font = await output.embedFont(Uint8Array.from(atob(fontBase64), char => char.charCodeAt(0)), {subset: true, features: {liga: false}});
    let imageBytes = 0;
    // Validate edits with missing coordinates even if the document has no matching page.
    for (const edit of edits) if (edit.text !== edit.block?.text && (!edit.block?.visual || edit.block.visual.page < 1 || edit.block.visual.page > viewer.pageCount)) fail("to add sections, save a text version.");
    for (let pageNumber = 1; pageNumber <= viewer.pageCount; pageNumber++) {
      abort(signal);
      const canvas = document.createElement('canvas');
      try {
        const {width, height, painted} = await viewer.renderPage(pageNumber, canvas, {scale: 2, edits, eraseOnly:true, blocks:ordered});
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Couldn't save the page.")), 'image/png'));
        imageBytes += blob.size;
        if (imageBytes > 32 * 1024 * 1024) fail("the edited document is too large. Save a text version or split the document.");
        const image = await output.embedPng(await blob.arrayBuffer()), page = output.addPage([width, height]);
        page.drawImage(image, {x: 0, y: 0, width, height});
        // Regenerate the complete text layer, including unchanged text. The old
        // source PDF is never embedded, so replaced words cannot survive hidden.
        for (const block of ordered.filter(block => block.visual.page === pageNumber)) {
          const text = replacements.has(block.record) ? replacements.get(block.record) : block.text;
          if (!text) continue;
          const rect = block.visual.rects[0], angle = -rect.angle;
          const changed = replacements.has(block.record) && (text !== block.text || edits.find(e=>e.block.record===block.record)?.box);
          if (!changed) { await drawPdfOriginalText(page, block, viewer, output, font, {height}); continue; }
          const selected = await viewer.editFont(block, text, output);
          const plan = changed ? planPdfEdits([{block, text,box:edits.find(e=>e.block.record===block.record)?.box}], pageNumber, selected?.font || font, ordered)[0] : null;
          const patch = changed ? painted.find(p => Math.abs(p.x-plan.x)<.01 && Math.abs(p.y-plan.y)<.01) : null;
          const drawFont = selected?.font || font, color = rgb(...(patch?.foreground || [0,0,0]).map(v=>v/255));
          if(plan?.lines){for(let i=0;i<plan.lines.length;i++)if(plan.lines[i])page.drawText(plan.lines[i],{x:plan.x,y:height-plan.y-plan.size-i*plan.lineHeight,size:plan.size,font:drawFont,color});continue;}
          page.drawText(text, {x: plan?.x ?? rect.x, y: height - ((block.visual.rasterBoundsVersion === 2 ? undefined : rect.baselineY) ?? (plan?.y ?? rect.y) + (plan?.height ?? rect.height) * 0.8),
            size: plan?.size ?? rect.fontSize, font:drawFont, color, opacity: changed ? 1 : 0,
            rotate: {type: 'degrees', angle}});
        }
      } finally { canvas.width = canvas.height = 0; }
    }
    abort(signal); return output.save();
  } finally { await viewer.dispose(); }
}

/** Editable text in its current order, reflowed into a fresh searchable PDF.
 * No source pages are embedded: removed or replaced text cannot leak through.
 */
export async function renderReflowedPdf(entries, {signal, pageSize} = {}) {
  abort(signal);
  if (!Array.isArray(entries) || entries.some(e => typeof e?.text !== 'string') || entries.reduce((n,e)=>n+e.text.length,0)>500000) fail('invalid document text.');
  const output = await PDFDocument.create(); output.registerFontkit(fontkit);
  const font = await output.embedFont(Uint8Array.from(atob(fontBase64), c=>c.charCodeAt(0)), {subset:true,features:{liga:false}});
  const [width,height] = Array.isArray(pageSize) && pageSize.length===2 && pageSize.every(n=>Number.isFinite(n)&&n>=200&&n<=2000) ? pageSize : [612,792];
  const margin=40,size=11,lineHeight=16,available=width-2*margin;
  let page,y,drawn=0;
  const newPage=()=>{abort(signal);page=output.addPage([width,height]);y=height-margin-size;};
  const draw=async line=>{abort(signal);if(!page||y<margin)newPage();if(line)page.drawText(line,{x:margin,y,size,font,color:rgb(0,0,0)});y-=lineHeight;if(++drawn%64===0){await new Promise(resolve=>setTimeout(resolve,0));abort(signal);}};
  async function wrap(line) {
    let current='';
    for(const token of line.match(/\s+|\S+/gu)||[]) {
      let rest=token;
      if(current.length+rest.length<=2048&&font.widthOfTextAtSize(current+rest,size)<=available){current+=rest;continue;}
      if(current){await draw(current.trimEnd());current='';}
      if(/^\s+$/u.test(rest))continue;
      // Binary-search chunks, so even a very long URL is split without clipping.
      const chars=Array.from(rest);let start=0;
      while(start<chars.length) {
        let low=1,high=Math.min(64,chars.length-start);
        while(high<chars.length-start&&font.widthOfTextAtSize(chars.slice(start,start+high).join(''),size)<=available){low=high;high=Math.min(high*2,chars.length-start);}
        while(low<high){const mid=Math.ceil((low+high)/2);if(font.widthOfTextAtSize(chars.slice(start,start+mid).join(''),size)<=available)low=mid;else high=mid-1;}
        rest=chars.slice(start,start+low).join('');start+=low;
        if(start<chars.length)await draw(rest);else current=rest;
      }
    }
    await draw(current.trimEnd());
  }
  for(let index=0;index<entries.length;index++) {
    abort(signal);
    const text=entries[index].text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ');
    for(const line of text.split('\n'))await wrap(line);
    // Yield so a replaced comparison can cancel a long export.
    if(index%25===24)await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(!page)newPage();
  output.setTitle('Edited document');output.setCreator('Compare These Texts');output.setProducer('Compare These Texts');
  abort(signal);return output.save();
}

export {measureFont as measurePdfFont, samplePatch as samplePdfPatch};
