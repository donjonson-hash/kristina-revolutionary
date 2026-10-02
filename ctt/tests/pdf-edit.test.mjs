import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {PDFDocument,fontkit,rgb} from '../dist/pdf-vendor.mjs';
import fontBase64 from '../dist/pdf-font.mjs';
import {handleRequest} from '../dist/worker.mjs';
import {readTextSource} from '../dist/text-source.mjs';
import {renderPdfRevision,validatePdfEdits,openPdfVisual,renderReflowedPdf,measurePdfFont} from '../dist/pdf-visual.mjs';
import {mountVisualReview} from '../dist/visual-review.mjs';
import editor from '../dist/text-editor.js';
import {renderPreservedPdf} from '../dist/pdf-layout.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {refineRasterBounds} from '../dist/pdf-raster-bounds.mjs';
const require=createRequire(import.meta.url),{JSDOM}=require('jsdom');const native=require('@napi-rs/canvas');
const source=(name,data)=>({name,data:Buffer.from(data).toString('base64')});
async function fixture(text){const doc=await PDFDocument.create();doc.registerFontkit(fontkit);const font=await doc.embedFont(Buffer.from(fontBase64,'base64'),{subset:true});doc.addPage([500,700]).drawText(text,{x:50,y:600,size:14,font});doc.addPage([500,700]).drawText('Unchanged second page.',{x:50,y:600,size:14,font});return source('file.pdf',await doc.save());}
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await delay(20);}assert.fail('PDF UI did not reach expected state');}
test('PDF original pages, readable reflow export, clicked-revision capture and return to original layout',{skip:!native},async t=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),root=dom.window.document.querySelector('main');
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.DOMMatrix=native.DOMMatrix;globalThis.Path2D=native.Path2D;globalThis.ImageData=native.ImageData;
 globalThis.FontFace=class{constructor(name,bytes){this.name=name;this.bytes=bytes;}async load(){native.GlobalFonts.register(Buffer.from(this.bytes),this.name);return this;}};document.fonts={add(){}};
 window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const canvases=new WeakMap();function canvas(el){let c=canvases.get(el);if(!c||c.width!==el.width||c.height!==el.height){c=native.createCanvas(el.width,el.height);canvases.set(el,c);}return c;}
 window.HTMLCanvasElement.prototype.getContext=function(type){const ctx=canvas(this).getContext(type);if(!ctx._wrapped){const draw=ctx.drawImage.bind(ctx);ctx.drawImage=(image,...args)=>draw(image instanceof window.HTMLCanvasElement?canvas(image):image,...args);ctx._wrapped=true;}return ctx;};window.HTMLCanvasElement.prototype.toBlob=function(callback,mime){canvas(this).toBlob(callback,mime);};
 let view;t.after(()=>{view?.dispose();dom.window.close();for(const key of ['window','document','DOMMatrix','Path2D','ImageData','FontFace'])delete globalThis[key];});
 const sources={left:await fixture('Amount: 1200'),right:await fixture('Amount: 1400')}, {report}=await handleRequest('/api/compare',sources);
 const direct=await openPdfVisual(sources.left);try{await direct.renderPage(1,document.createElement('canvas'));}finally{await direct.dispose();}
 view=await mountVisualReview(root,{report,sources});assert.equal(root.querySelectorAll('canvas').length,2,root.textContent);
 const group=report.changed[0],parts=group.right.source_blocks||[group.right];const edited=await renderPdfRevision(sources.right,[{block:parts[0],text:'Amount: 1200'}],{blocks:[...report.changed,...report.matched].flatMap(g=>g.right.source_blocks||[g.right]).sort((a,b)=>a.record-b.record)});
 const reopened=await readTextSource(source('edited.pdf',edited));const texts=reopened.blocks.map(b=>b.text).join('\n');assert.match(texts,/Amount: 1200/);assert.doesNotMatch(texts,/1400/);assert.match(texts,/Unchanged second page/);
 const downloads=[],oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:pdf-test';};URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=function(){};
 t.after(()=>{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;});
 // Block edits are staged, undoable, restorable, and use the same PDF for preview/export.
 await view.select(group.key);
 const beforeBlock=view.drafts.right.snapshot(),openBlock=async()=>{root.querySelector('[data-replace-block="right"]').click();await until(()=>modal());};
 const modal=()=>root.querySelector('.pdf-block-dialog'),applyBlock=()=>modal()?.querySelector('.pdf-block-actions .primary');
 await openBlock();await until(()=>applyBlock()&&!applyBlock().disabled);
 modal().querySelector('textarea').value='Canceled name';modal().querySelector('textarea').dispatchEvent(new window.Event('input'));
 modal().querySelector('.pdf-block-actions .secondary').click();assert.deepEqual(view.drafts.right.snapshot(),beforeBlock);
 await openBlock();const replacement='Alexandra Catherine\nMontgomery';
 const fitText='Alexandra Catherine Montgomery',fitFont=await measurePdfFont();
 modal().querySelector('textarea').value=fitText;modal().querySelector('[aria-label="Width in points"]').value=String(fitFont.widthOfTextAtSize(fitText,14)*.9);modal().querySelector('textarea').dispatchEvent(new window.Event('input'));
 await until(()=>applyBlock()&&!applyBlock().disabled);assert.ok(Number(modal().querySelector('[aria-label="Text size in points"]').value)<14,'A slightly longer name fits without covering the next line');assert.ok(Number(modal().querySelector('[aria-label="Text size in points"]').value)>=11.2,'Automatic sizing never shrinks more than20%');
 modal().querySelector('textarea').value=replacement;modal().querySelector('[aria-label="Width in points"]').value='250';modal().querySelector('[aria-label="Height in points"]').value='50';modal().querySelector('textarea').dispatchEvent(new window.Event('input'));
 await until(()=>applyBlock()&&!applyBlock().disabled);assert.deepEqual(view.drafts.right.snapshot(),beforeBlock,'Preview does not mutate the draft');
 applyBlock().click();assert.equal(modal(),null);assert.equal(view.drafts.right.get(group.key),replacement);assert.deepEqual(view.drafts.right.entries().find(e=>e.key===group.key).pdfBox,{width:250,height:50,fontSize:14});
 const blockSaved=view.snapshot();view.dispose();view=await mountVisualReview(root,{report,sources,restoredState:blockSaved});assert.deepEqual(view.drafts.right.snapshot(),blockSaved.drafts.right);
 await until(()=>!root.querySelector('[data-save-side="right"]').disabled);root.querySelector('[data-save-side="right"]').click();await until(()=>downloads.length===1);
 const blockRead=await readTextSource(source('block.pdf',new Uint8Array(await downloads.pop().arrayBuffer()))),blockText=blockRead.blocks.map(b=>b.text).join(' ');assert.match(blockText,/Alexandra Catherine Montgomery/);assert.doesNotMatch(blockText,/1400/);assert.match(blockText,/Unchanged second page/);
 // One undo restores both the original text and the original selection geometry.
 view.drafts.right.undo();assert.deepEqual(view.drafts.right.entries(),beforeBlock.entries);view.dispose();view=await mountVisualReview(root,{report,sources});
 await view.select(group.key);const input=root.querySelector('[data-edit-side="right"]'),longText='This is a much longer replacement which cannot fit the original line at a readable font size.\nA new paragraph must remain in the PDF.';
 input.value=longText;input.dispatchEvent(new window.Event('input'));
 await until(()=>root.querySelector('[data-save-side="right"]').dataset.pdfMode==='reflow'&&!root.querySelector('[data-save-side="right"]').disabled&&root.querySelectorAll('.visual-scroll')[1].getAttribute('aria-busy')==='false');
 assert.equal(root.querySelectorAll('.pdf-export-state')[1].textContent,'');
 assert.ok(root.querySelectorAll('.visual-column')[1].querySelector('.visual-pdf-page[data-pdf-layout="updated"] canvas'),'Overflow keeps the updated document visible');
 assert.ok(root.querySelectorAll('.visual-column')[1].querySelector(`[data-group="${group.key}"]`),'Updated text is selectable on the page');
 root.querySelector('[data-save-side="right"]').click();input.value='A later edit';input.dispatchEvent(new window.Event('input'));
 await until(()=>downloads.length===1||root.querySelector('.visual-notice').textContent.startsWith('PDF'));assert.equal(downloads.length,1,root.querySelector('.visual-notice').textContent);const clicked=await readTextSource(source('reflow.pdf',new Uint8Array(await downloads[0].arrayBuffer())));const clickedText=clicked.blocks.map(b=>b.text).join(' ');
 assert.match(clickedText,/new paragraph must remain/);assert.match(clickedText,/Unchanged second page/);assert.doesNotMatch(clickedText,/Amount: 1400|A later edit/);
 await until(()=>!root.querySelector('[data-save-side="right"]').disabled);
 assert.equal(root.querySelectorAll('.visual-page-nav')[1].hidden,false);
 root.querySelector('[aria-label="Next page of B"]').click();await until(()=>root.querySelectorAll('.visual-page-nav')[1].textContent.includes('2 / 2'));assert.equal(root.querySelector('[data-save-side="right"]').disabled,false);
 input.value='Amount: 1200';input.dispatchEvent(new window.Event('input'));root.querySelector('[data-review-action="check"]').click();assert.equal(root.querySelector('.final-check').dataset.checkState,'match');await until(()=>!root.querySelector('[data-save-side="right"]').disabled&&root.querySelector('[data-save-side="right"]').dataset.pdfMode==='original');
 assert.equal(root.querySelectorAll('.pdf-export-state')[1].textContent,'');
 root.querySelector('[data-pdf-text-only="right"]').click();await until(()=>downloads.length===2);const explicitText=await readTextSource(source('text-only.pdf',new Uint8Array(await downloads[1].arrayBuffer())));assert.match(explicitText.blocks.map(b=>b.text).join(' '),/Amount: 1200/);
 // A flattened image can have wider visible lettering than its invisible text layer.
 const flatDoc=await PDFDocument.create();flatDoc.registerFontkit(fontkit);const flatFont=await flatDoc.embedFont(Buffer.from(fontBase64,'base64'),{subset:true});
 const flatCanvas=native.createCanvas(800,400),flatContext=flatCanvas.getContext('2d');flatContext.fillStyle='#fff';flatContext.fillRect(0,0,800,400);flatContext.fillStyle='#344438';flatContext.fillRect(40,40,600,100);
 flatContext.save();flatContext.translate(60,90);flatContext.scale(1.35,1);flatContext.font='28px KristinaPdfRevision';flatContext.fillStyle='white';let trackedX=0;for(const char of 'PERSONAL DATA'){flatContext.fillText(char,trackedX,0);trackedX+=flatContext.measureText(char).width+2;}flatContext.restore();flatContext.fillStyle='#101010';flatContext.font='24px KristinaPdfRevision';flatContext.fillText('NEIGHBOR',60,300);
 const flatImage=await flatDoc.embedPng(flatCanvas.toBuffer('image/png')),flatPage=flatDoc.addPage([400,200]);flatPage.drawImage(flatImage,{x:0,y:0,width:400,height:200});flatPage.drawText('PERSONAL DATA',{x:30,y:155,size:14,font:flatFont,opacity:0});flatPage.drawText('NEIGHBOR',{x:30,y:50,size:12,font:flatFont,opacity:0});
 const flatSource=source('flattened.pdf',await flatDoc.save()),flatBlocks=(await readTextSource(flatSource)).blocks,oldRight=flatBlocks[0].visual.rects[0].x+flatBlocks[0].visual.rects[0].width;
 const flatViewer=await openPdfVisual(flatSource),flatRefined=await flatViewer.refineBlocks(flatBlocks);await flatViewer.dispose();const corrected=flatRefined[0].visual.rects[0];assert.ok(corrected.x+corrected.width>oldRight+20,'Measured visible lettering extends beyond the invisible overlay: '+JSON.stringify({oldRight,corrected,visual:flatRefined[0].visual}));assert.equal(flatRefined[0].visual.rasterBoundsUncertain,false);
 const flatDeleted=await renderPdfRevision(flatSource,[{block:flatBlocks[0],text:''}],{blocks:flatBlocks}),flatOutput=await openPdfVisual({data:flatDeleted},{generated:true}),flatResult=document.createElement('canvas');await flatOutput.renderPage(1,flatResult,{scale:2});await flatOutput.dispose();const flatPixels=flatResult.getContext('2d').getImageData(0,0,800,400).data;
 for(let y=55;y<110;y++)for(let x=55;x<450;x++){const at=(y*800+x)*4;assert.ok(Math.abs(flatPixels[at]-52)<3&&Math.abs(flatPixels[at+1]-68)<3&&Math.abs(flatPixels[at+2]-56)<3,'Erasing the whole title must leave no old suffix');}
 const flatRead=await readTextSource(source('deleted.pdf',flatDeleted));assert.deepEqual(flatRead.blocks.map(b=>b.text),['NEIGHBOR']);let neighborInk=0;for(let y=270;y<305;y++)for(let x=55;x<210;x++)if(flatPixels[(y*800+x)*4]<40)neighborInk++;assert.ok(neighborInk>200,'The nearby text remains visible');
 // Restored comparisons also get new geometry without changing their text or history.
 view.dispose();const flatSources={left:flatSource,right:flatSource},flatReport=(await handleRequest('/api/compare',flatSources)).report;view=await mountVisualReview(root,{report:flatReport,sources:flatSources});const flatSaved=view.snapshot();view.dispose();view=await mountVisualReview(root,{report:flatReport,sources:flatSources,restoredState:flatSaved});assert.deepEqual(view.snapshot().drafts,flatSaved.drafts);const flatKey=flatReport.matched.find(g=>g.right.text==='PERSONAL DATA').key,hotspot=root.querySelector(`[data-group="${flatKey}"]`);assert.ok(parseFloat(hotspot.style.width)*4>corrected.width-1,'The selection covers the complete visible title');
 // A nearby rule or unresolved wide gap must not be silently erased or truncated.
 for(const kind of ['rule','suffix']){const c=document.createElement('canvas');c.width=200;c.height=100;const cx=c.getContext('2d');cx.fillStyle='white';cx.fillRect(0,0,200,100);cx.fillStyle='black';for(let x=20;x<58;x+=8)cx.fillRect(x,23,5,7);if(kind==='rule')cx.fillRect(62,25,19,2);else cx.fillRect(72,23,5,7);const b={record:1,text:'TEST',visual:{page:1,width:200,height:100,rects:[{x:20,y:20,width:40,height:12,fontSize:10,angle:0}]}};const [refined]=refineRasterBounds(c,[b],200,100,[{x:0,y:0,width:200,height:100}]);assert.equal(refined.visual.rasterBoundsUncertain,true,kind+' is ambiguous and must not be erased');await assert.rejects(()=>validatePdfEdits([{block:refined,text:'X'}]),/boundaries/);}
 // Raster-only list markers belong to adjacent rows, not the name being replaced.
 for(const kind of ['markers','single','bar']){const c=document.createElement('canvas');c.width=250;c.height=100;const cx=c.getContext('2d');cx.fillStyle='white';cx.fillRect(0,0,250,100);cx.fillStyle='black';for(let x=20;x<65;x+=10)cx.fillRect(x,25,6,14);cx.fillRect(110,26,3,3);if(kind==='markers')cx.fillRect(110,38,3,3);if(kind==='bar')cx.fillRect(110,26,3,15);const b={record:1,text:'TEST',visual:{page:1,width:250,height:100,rects:[{x:20,y:20,width:50,height:26,fontSize:20,angle:0}],rasterBoundsVersion:1,rasterBoundsUncertain:true}};const others=[24,36].map((y,i)=>({record:i+2,text:'Neighbor',visual:{page:1,width:250,height:100,rects:[{x:122,y,width:75,height:10,fontSize:10,angle:0}]}}));const [check]=refineRasterBounds(c,[b,...others],250,100,[{x:0,y:0,width:250,height:100}]);assert.equal(!!check.visual.rasterBoundsUncertain,kind!=='markers',kind);}
 // A real image and unchanged heading must survive a large text expansion.
 const artDoc=await PDFDocument.create();artDoc.registerFontkit(fontkit);const artFont=await artDoc.embedFont(Buffer.from(fontBase64,'base64'),{subset:true});const art=artDoc.addPage([400,500]);
 art.drawText('UNCHANGED HEADING',{x:35,y:455,size:20,font:artFont,color:rgb(0,0,1)});art.drawText('Original paragraph.',{x:35,y:390,size:12,font:artFont});art.drawText('Text below the photo.',{x:35,y:55,size:12,font:artFont});art.drawRectangle({x:0,y:0,width:400,height:8,color:rgb(1,.5,0)});
 const photo=native.createCanvas(100,60),photoContext=photo.getContext('2d');photoContext.fillStyle='#e02040';photoContext.fillRect(0,0,100,60);photoContext.fillStyle='#20c090';photoContext.fillRect(50,0,50,60);const picture=await artDoc.embedPng(photo.toBuffer('image/png'));art.drawImage(picture,{x:35,y:160,width:100,height:60});
 const artSource=source('art.pdf',await artDoc.save()),parsed=await readTextSource(artSource),blocks=parsed.blocks.map((b,i)=>({...b,key:'section-'+i})),entries=blocks.map(b=>({key:b.key,record:b.record,text:b.text}));const paragraph=entries.find(e=>e.text==='Original paragraph.');paragraph.text=Array.from({length:45},(_,i)=>`Expanded line ${i+1}`).join('\n');
 const originalParagraph=blocks.find(b=>b.key===paragraph.key);
 await assert.rejects(()=>renderPdfRevision(artSource,[{block:originalParagraph,text:'New name',box:{width:250,height:370}}],{blocks}),/overlaps nearby text/);
 await assert.rejects(()=>renderPdfRevision(artSource,[{block:originalParagraph,text:'New name',box:{width:250,height:260}}],{blocks}),/overlaps an image/);
 await assert.rejects(()=>renderPreservedPdf(artSource,entries.map(e=>e.key===paragraph.key?{...e,pdfBox:{width:250,height:50}}:e),{blocks}),/cannot be combined with page reflow/);
 let layout;const preserved=await renderPreservedPdf(artSource,entries,{blocks,onLayout:rects=>{layout=rects;}}),preservedSource=source('preserved.pdf',preserved),readBack=await readTextSource(preservedSource),allText=readBack.blocks.map(b=>b.text).join(' ');assert.match(allText,/UNCHANGED HEADING/);assert.match(allText,/Expanded line 45/);assert.match(allText,/Text below the photo/);assert.doesNotMatch(allText,/Original paragraph/);
 assert.ok(layout.some(r=>r.key===paragraph.key&&r.page>1),'Expanded text has hotspots on new pages');
 assert.ok(layout.some(r=>r.key===blocks.find(b=>b.text==='Text below the photo.').key&&r.page>1),'Unchanged text hotspots move with the artwork');
 const rendered=await openPdfVisual(preservedSource);let photoPages=0,blue=0,orange=0;
 try{assert.ok(rendered.pageCount>1);for(let n=1;n<=rendered.pageCount;n++){const target=document.createElement('canvas');await rendered.renderPage(n,target);const pixels=target.getContext('2d').getImageData(0,0,target.width,target.height).data;let red=0,green=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]>190&&pixels[i+1]<60&&pixels[i+2]>40&&pixels[i+2]<100)red++;if(pixels[i]<60&&pixels[i+1]>150&&pixels[i+2]>100&&pixels[i+2]<180)green++;if(pixels[i]<60&&pixels[i+1]<60&&pixels[i+2]>180)blue++;if(pixels[i]>245&&pixels[i+1]>115&&pixels[i+1]<140&&pixels[i+2]<15)orange++;}if(red||green){photoPages++;assert.ok(red>2800&&green>2800,'The complete photo stays together on one page');}}}
 finally{await rendered.dispose();}assert.equal(photoPages,1);assert.ok(blue>100,'Original blue heading styling is retained');assert.ok(orange>3000,'A full-width colored footer is retained');
 // Exercise the same reflow in the actual A/B editor, including navigation, restore and undo.
 view.dispose();const artSources={left:artSource,right:artSource},artReport=(await handleRequest('/api/compare',artSources)).report;
 view=await mountVisualReview(root,{report:artReport,sources:artSources});
 const artGroup=artReport.matched.find(g=>(g.right.source_blocks||[g.right]).some(b=>b.text==='Original paragraph.'));
 await view.select(artGroup.key);
 root.querySelector('[data-pdf-text-view="right"]').click();await until(()=>!!root.querySelectorAll('.visual-column')[1].querySelector('.visual-paragraph'));
 assert.equal(root.querySelector('[data-pdf-text-view="right"]').getAttribute('aria-pressed'),'true');assert.equal(root.querySelector('[data-pdf-preview="right"]').hidden,false);
 assert.match(root.querySelectorAll('.pdf-view-hint')[1].textContent,/images are kept/);
 const artInput=root.querySelector('[data-edit-side="right"]');artInput.value=paragraph.text;artInput.dispatchEvent(new window.Event('input'));
 await until(()=>!root.querySelector('[data-save-side="right"]').disabled);
 assert.equal(root.querySelector('[data-pdf-text-view="right"]').getAttribute('aria-pressed'),'true','Typing keeps the chosen Text view');
 const beforePreview=view.drafts.right.snapshot();root.querySelector('[data-pdf-preview="right"]').click();
 await until(()=>!!root.querySelectorAll('.visual-column')[1].querySelector('[data-pdf-layout="updated"]')&&!root.querySelector('[data-save-side="right"]').disabled);
 assert.deepEqual(view.drafts.right.snapshot(),beforePreview,'Preview preserves the complete text draft and undo history');assert.equal(root.querySelector('[data-save-side="right"]').textContent,'Download PDF');assert.equal(root.querySelector('[data-pdf-view="right"]').getAttribute('aria-pressed'),'true');
 const artColumn=root.querySelectorAll('.visual-column')[1];assert.ok(artColumn.querySelector('canvas'));assert.equal(artColumn.querySelector('.visual-paragraph'),null);
 root.querySelector('[aria-label="Next page of B"]').click();await until(()=>root.querySelectorAll('.visual-page-nav')[1].textContent.includes('2 /')&&root.querySelectorAll('.visual-scroll')[1].getAttribute('aria-busy')==='false');
 const movedHotspot=artColumn.querySelector(`[data-group="${artGroup.key}"]`);assert.ok(movedHotspot);movedHotspot.click();await delay(30);assert.equal(view.snapshot().pages.right,2,'Selecting a split paragraph stays on its current generated page');assert.equal(artInput.value,paragraph.text);
 const saved=view.snapshot();view.dispose();view=await mountVisualReview(root,{report:artReport,sources:artSources,restoredState:saved});assert.equal(view.snapshot().pages.right,2,'A generated page beyond the original page count restores');assert.ok(root.querySelectorAll('.visual-column')[1].querySelector('[data-pdf-layout="updated"]'));
 const restoreInput=root.querySelector('[data-edit-side="right"]');restoreInput.value='Intermediate revision\n'.repeat(60);restoreInput.dispatchEvent(new window.Event('input'));await delay(370);restoreInput.value='Final visible revision\n'.repeat(45);restoreInput.dispatchEvent(new window.Event('input'));
 await until(()=>root.querySelectorAll('.visual-column')[1].querySelector('.visual-pdf-page')?.dataset.pdfRevision===String(view.drafts.right.revision)&&!root.querySelector('[data-save-side="right"]').disabled);
 assert.match(root.querySelectorAll('.visual-column')[1].querySelector(`[data-group="${artGroup.key}"]`).getAttribute('aria-label'),/Final visible revision/);
 restoreInput.value='Original paragraph.';restoreInput.dispatchEvent(new window.Event('input'));await until(()=>root.querySelector('[data-save-side="right"]').dataset.pdfMode==='original'&&!root.querySelector('[data-save-side="right"]').disabled);assert.equal(view.snapshot().pages.right,1,'Returning to the original clamps the generated page number');
 restoreInput.value=paragraph.text;restoreInput.dispatchEvent(new window.Event('input'));await delay(370);view.dispose();await delay(300);assert.equal(root.childElementCount,0,'Disposed preview cannot repopulate the editor');
 // An unsupported move gives a real reason and reversible recovery, without losing the draft.
 view=await mountVisualReview(root,{report:artReport,sources:artSources});view.drafts.right.replaceAll([...view.drafts.right.entries()].reverse());root.querySelector('[data-review-action="check"]').click();root.querySelector('[data-pdf-view="right"]').click();
 await until(()=>!root.querySelectorAll('.pdf-recovery')[1].hidden&&root.querySelectorAll('.visual-scroll')[1].getAttribute('aria-busy')==='false');
 assert.match(root.querySelectorAll('.pdf-export-state')[1].textContent,/section order/);assert.doesNotMatch(root.querySelectorAll('.pdf-export-state')[1].textContent,/PDF layout:|Shorten/);assert.equal(root.querySelector('[data-save-side="right"]').disabled,true);assert.equal(root.querySelector('[data-save-side="right"]').textContent,'Download PDF');
 const failedDraft=view.drafts.right.snapshot();root.querySelector('[data-pdf-preview="right"]').click();await until(()=>!root.querySelectorAll('.pdf-recovery')[1].hidden&&root.querySelectorAll('.visual-scroll')[1].getAttribute('aria-busy')==='false');assert.deepEqual(view.drafts.right.snapshot(),failedDraft,'Retry keeps the draft');
 root.querySelector('[data-pdf-continue="right"]').click();await delay(20);assert.equal(document.activeElement,root.querySelector('[data-edit-side="right"]'));
 const beforeFallback=downloads.length;root.querySelector('[data-pdf-fallback="right"]').click();await until(()=>downloads.length===beforeFallback+1);const fallback=await readTextSource(source('fallback.pdf',new Uint8Array(await downloads.at(-1).arrayBuffer())));assert.match(fallback.blocks[0].text,/Text below the photo/);assert.deepEqual(view.drafts.right.snapshot(),failedDraft,'Text-only download does not change the working document');
 root.querySelector('[data-pdf-undo="right"]').click();await until(()=>!root.querySelector('[data-save-side="right"]').disabled&&root.querySelectorAll('.visual-column')[1].querySelector('[data-pdf-layout="original"]'));assert.equal(root.querySelectorAll('.pdf-recovery')[1].hidden,true);assert.equal(root.querySelectorAll('.pdf-export-state')[1].textContent,'');assert.equal(view.drafts.right.changed,false);view.dispose();
 // New sections retain their own keys rather than their anchor key.
 const inserted=[...blocks.map(b=>({key:b.key,record:b.record,text:b.text}))];inserted.splice(1,0,{key:'inserted',text:'New line'});let insertedLayout;await renderPreservedPdf(artSource,inserted,{blocks,onLayout:rects=>{insertedLayout=rects;}});assert.ok(insertedLayout.some(r=>r.key==='inserted'));
 // The erased text box may not contain a picture, even when the picture is wholly enclosed.
 const enclosed=structuredClone(blocks),boxBlock=enclosed.find(b=>b.text==='Original paragraph.');boxBlock.visual.rects=[{...boxBlock.visual.rects[0],x:30,y:90,width:120,height:270}];await assert.rejects(()=>renderPreservedPdf(artSource,entries,{blocks:enclosed}),/image/);
 // Touching text boxes expand sequentially instead of painting over each other.
 const nearDoc=await PDFDocument.create();nearDoc.registerFontkit(fontkit);const nearFont=await nearDoc.embedFont(Buffer.from(fontBase64,'base64'),{subset:true});const nearPage=nearDoc.addPage([400,500]);nearPage.drawText('Alpha.',{x:35,y:400,size:12,font:nearFont});nearPage.drawText('Beta.',{x:35,y:386,size:12,font:nearFont});
 const nearSource=source('near.pdf',await nearDoc.save()),nearParsed=await readTextSource(nearSource),nearBlocks=nearParsed.blocks.map((b,i)=>({...b,key:'near-'+i}));assert.equal(nearBlocks.length,2);
 const nearEntries=nearBlocks.map((b,i)=>({key:b.key,record:b.record,text:i?'B1\nB2':'A1\nA2\nA3'})),nearOutput=await renderPreservedPdf(nearSource,nearEntries,{blocks:nearBlocks}),nearRead=await readTextSource(source('near-out.pdf',nearOutput));const lineBoxes=nearRead.blocks.flatMap(b=>b.visual.rects.map(r=>({text:b.text,top:r.y,bottom:r.y+r.height}))).sort((a,b)=>a.top-b.top);assert.deepEqual(nearRead.blocks.map(b=>b.text),['A1','A2','A3','B1','B2']);for(let i=1;i<lineBoxes.length;i++)assert.ok(lineBoxes[i].top>=lineBoxes[i-1].bottom-.1,'Expanded neighboring lines must not overlap');
 // A section move must not silently discard the photo; text-only remains an explicit alternative.
 await assert.rejects(()=>renderPreservedPdf(artSource,[...entries].reverse(),{blocks}),/Moving sections/);
 await assert.rejects(()=>validatePdfEdits([{block:parts[0],text:'line one\nline two'}]));
});


test('reflow PDF wraps and paginates all current text in draft order without source text',async()=>{
 const token='VeryLongUnbrokenText'.repeat(30),entries=[{record:9,text:'Moved to the beginning.'},{text:'Новый абзац: добавлен пользователем.'},{record:2,text:token},{record:1,text:Array.from({length:140},(_,i)=>`Line ${i+1}: This edited paragraph flows onto readable new pages.`).join('\n')},{text:'FINAL END MARKER'}];
 const bytes=await renderReflowedPdf(entries,{pageSize:[400,500]});const loading=getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,isEvalSupported:false,useWorkerFetch:false,verbosity:0});
 const pdf=await loading.promise;try{assert.ok(pdf.numPages>4);const strings=[];
  for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),content=await page.getTextContent();for(const item of content.items){if(!item.str)continue;strings.push(item.str);assert.ok(item.transform[4]>=39);assert.ok(item.transform[4]+item.width<=361,`Text clipped on page ${n}`);assert.ok(item.transform[5]>=39&&item.transform[5]<=461);}}
  const text=strings.join(' ');assert.ok(text.indexOf('Moved to the beginning.')<text.indexOf('Новый абзац'));assert.ok(text.indexOf('Новый абзац')<text.indexOf('VeryLongUnbrokenText'));assert.match(text,/Line 140:/);assert.match(text,/FINAL END MARKER$/);assert.ok(text.replaceAll(' ','').includes(token));
 }finally{await loading.destroy();}
 const during=new AbortController();const pending=renderReflowedPdf([{text:'LongWord'.repeat(15000)}],{signal:during.signal});setTimeout(()=>during.abort(),0);await assert.rejects(()=>pending,{name:'AbortError'});
 const controller=new AbortController();controller.abort();await assert.rejects(()=>renderReflowedPdf(entries,{signal:controller.signal}),{name:'AbortError'});
});
