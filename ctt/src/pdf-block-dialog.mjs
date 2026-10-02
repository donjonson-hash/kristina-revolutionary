import {openPdfVisual, renderPdfRevision, measurePdfFont, defaultPdfBlockBox, fitPdfBlockFont} from './pdf-visual.mjs';

const node = (tag, text, className) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
/** A staged edit: only Apply writes to the document and its undo history. */
export function openBlockDialog({host, source, block, blocks, entry, edits, current, apply, onClose}) {
  const visual=block.visual, rects=visual.rects;
  const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));
  const minWidth=Math.max(...rects.map(r=>r.x+r.width))-x,minHeight=Math.max(...rects.map(r=>r.y+r.height))-y;
  const maxWidth=visual.width-x,maxHeight=visual.height-y;
  const originalSize=Math.min(...rects.map(r=>r.fontSize));
  const returnFocus=document.activeElement,overlay=node('div',undefined,'pdf-block-overlay'),dialog=node('section',undefined,'pdf-block-dialog');
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Replace block');overlay.append(dialog);host.append(overlay);
  dialog.append(node('h2','Replace block'),node('p','Edit the text, then drag the corner to give it room. Preview before applying.'));
  const body=node('div',undefined,'pdf-block-body'),controls=node('div',undefined,'pdf-block-controls'),stage=node('div',undefined,'pdf-block-stage');
  const label=node('label','New text'),input=node('textarea');input.setAttribute('aria-label','Replacement text');input.value=entry.text;input.rows=4;input.maxLength=500000;label.append(input);controls.append(label);
  const width=node('input'),height=node('input');
  const ceil=v=>Math.ceil(v*100)/100;
  for(const [control,name,min,max] of [[width,'Width',minWidth,maxWidth],[height,'Height',minHeight,maxHeight]]){control.type='number';control.min=String(ceil(min));control.max=String(max);control.step='0.1';control.setAttribute('aria-label',`${name} in points`);const label=node('label',`${name} (pt)`);label.append(control);controls.append(label);}
  // Start with one line; a taller default can accidentally cover a subtitle.
  const initial=defaultPdfBlockBox(block,blocks);
  width.value=String(entry.pdfBox?.width??initial.width);
  height.value=String(entry.pdfBox?.height??initial.height);
  const size=node('input');size.type='number';size.min='1';size.max='512';size.step='0.1';size.value=String(entry.pdfBox?.fontSize??Math.round(originalSize*100)/100);size.setAttribute('aria-label','Text size in points');
  const sizeLabel=node('label','Text size (pt)');sizeLabel.append(size);controls.append(sizeLabel);
  const autoLabel=node('label',undefined,'pdf-block-auto'),auto=node('input');auto.type='checkbox';auto.checked=!entry.pdfBox;autoLabel.append(auto,document.createTextNode('Fit text automatically'));controls.append(autoLabel);
  controls.append(node('small','Auto-fit reduces text size by up to 20%. You can also choose a size yourself. Works on plain backgrounds with space around the text.'));
  const paper=node('div',undefined,'pdf-block-paper'),canvas=node('canvas'),outline=node('div',undefined,'pdf-block-outline'),handle=node('button','↘','pdf-block-resize');
  handle.type='button';handle.setAttribute('aria-label','Resize block. Use arrow keys or drag.');outline.append(handle);paper.append(canvas,outline);stage.append(paper);body.append(controls,stage);dialog.append(body);
  const status=node('p','Preparing preview…','pdf-block-status');status.setAttribute('role','status');dialog.append(status);
  const actions=node('div',undefined,'pdf-block-actions'),cancel=node('button','Cancel','button secondary'),save=node('button','Apply','button primary');cancel.type=save.type='button';save.disabled=true;actions.append(cancel,save);dialog.append(actions);
  let closed=false,generation=0,controller,timer,approved=null;
  const geometry=()=>({width:Number(width.value),height:Number(height.value),fontSize:Number(size.value)});
  function drawOutline(){const box=geometry();Object.assign(outline.style,{left:`${x/visual.width*100}%`,top:`${y/visual.height*100}%`,width:`${box.width/visual.width*100}%`,height:`${box.height/visual.height*100}%`});}
  function close(){if(closed)return;closed=true;generation++;controller?.abort();clearTimeout(timer);overlay.remove();canvas.width=canvas.height=0;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});onClose?.();}
  async function preview(ticket){
    controller?.abort();const pending=new AbortController();controller=pending;
    const text=input.value,box=geometry();let viewer;
    try{
      if(!current())throw new Error('The document changed. Cancel and open this block again.');
      if(![box.width,box.height].every(Number.isFinite)||box.width<minWidth||box.width>maxWidth||box.height<minHeight||box.height>maxHeight)throw new Error('Keep the block around the original text and within the page.');
      if(auto.checked){
        const font=await measurePdfFont();if(closed||ticket!==generation)return;
        box.fontSize=fitPdfBlockFont(text,box,originalSize,font);size.value=String(box.fontSize);
      }
      const data=await renderPdfRevision(source,edits(text,box),{blocks,signal:pending.signal});
      viewer=await openPdfVisual({data},{generated:true,signal:pending.signal});
      const rendered=node('canvas');
      try{await viewer.renderPage(visual.page,rendered,{scale:1.5});if(closed||ticket!==generation)return;canvas.width=rendered.width;canvas.height=rendered.height;canvas.getContext('2d').drawImage(rendered,0,0);}finally{rendered.width=rendered.height=0;}
      if(!current())throw new Error('The document changed. Cancel and open this block again.');
      approved={text,box};save.disabled=false;status.textContent=box.fontSize<originalSize-.02?'Ready to apply. Text size adjusted to fit; nearby content stays in place.':'Ready to apply. The rest of the page stays in place.';
    }catch(error){
      if(closed||ticket!==generation||pending.signal.aborted)return;
      approved=null;save.disabled=true;status.textContent=/visible text boundaries/i.test(error.message)?'We could not locate all of the old text. No changes have been applied.':error.message.replace(/^PDF:\s*/,'');
      // A failed proposal must not leave a successful older proposal on screen.
      await viewer?.dispose().catch(()=>{});viewer=null;
      try{viewer=await openPdfVisual(source,{signal:pending.signal});const rendered=node('canvas');try{await viewer.renderPage(visual.page,rendered,{scale:1.5});if(closed||ticket!==generation)return;canvas.width=rendered.width;canvas.height=rendered.height;canvas.getContext('2d').drawImage(rendered,0,0);status.textContent+=' Original page shown.';}finally{rendered.width=rendered.height=0;}}catch{}
    }finally{await viewer?.dispose().catch(()=>{});}
  }
  function schedule(immediate=false){approved=null;save.disabled=true;generation++;controller?.abort();clearTimeout(timer);drawOutline();status.textContent='Preparing preview…';const ticket=generation;if(immediate)void preview(ticket);else timer=setTimeout(()=>void preview(ticket),350);}
  for(const control of [input,width,height])control.addEventListener('input',()=>schedule());
  size.addEventListener('input',()=>{auto.checked=false;schedule();});auto.addEventListener('change',()=>schedule());
  cancel.addEventListener('click',close);
  save.addEventListener('click',()=>{if(!approved||!current()){save.disabled=true;status.textContent='The document changed. Cancel and open this block again.';return;}try{apply(approved.text,approved.box);close();}catch(error){status.textContent=error.message;}});
  handle.addEventListener('pointerdown',event=>{event.preventDefault();const start={x:event.clientX,y:event.clientY,...geometry()},scale=paper.getBoundingClientRect().width/visual.width;if(!scale)return;handle.setPointerCapture(event.pointerId);const move=e=>{width.value=String(Math.min(maxWidth,ceil(Math.max(minWidth,start.width+(e.clientX-start.x)/scale))));height.value=String(Math.min(maxHeight,ceil(Math.max(minHeight,start.height+(e.clientY-start.y)/scale))));schedule();};const stop=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',stop);handle.removeEventListener('pointercancel',stop);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);});
  handle.addEventListener('keydown',event=>{const directions={ArrowRight:[5,0],ArrowLeft:[-5,0],ArrowDown:[0,5],ArrowUp:[0,-5]},delta=directions[event.key];if(!delta)return;event.preventDefault();width.value=String(Math.max(ceil(minWidth),Math.min(maxWidth,Number(width.value)+delta[0])));height.value=String(Math.max(ceil(minHeight),Math.min(maxHeight,Number(height.value)+delta[1])));schedule();});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='Tab'){const items=[input,width,height,size,auto,handle,cancel,...(save.disabled?[]:[save])],first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});
  paper.style.aspectRatio=`${visual.width} / ${visual.height}`;schedule(true);input.focus();return {close};
}
