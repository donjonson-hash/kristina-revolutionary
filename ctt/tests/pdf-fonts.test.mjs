import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {PDFDocument, fontkit} from '../dist/pdf-vendor.mjs';
import {readTextSource} from '../dist/text-source.mjs';
import {openPdfVisual, renderPdfRevision, measurePdfBlockFont} from '../dist/pdf-visual.mjs';
import {renderPreservedPdf} from '../dist/pdf-layout.mjs';
import boldFont from '../dist/word-font-bold.mjs';
const require=createRequire(import.meta.url),{JSDOM}=require('jsdom'),native=require('@napi-rs/canvas');
const source=data=>({name:'font-test.pdf',data:Buffer.from(data).toString('base64')});

function canvasEnvironment(t) {
 // PDF.js uses the PDF family names for unembedded standard fonts. Skia does
 // not follow fontconfig aliases consistently, so register the local metrics-
 // compatible families explicitly instead of using its unrelated default.
 for(const [alias,family] of [['Times','Times New Roman'],['Helvetica','Arial'],['Courier','Courier New']]) {
  for(const style of ['Regular','Bold','Italic','Bold Italic']) {
   const path=execFileSync('fc-match',['-f','%{file}',`${family}:style=${style}`],{encoding:'utf8'}).trim();
   assert.ok(native.GlobalFonts.registerFromPath(path,alias),`Register ${alias} ${style}`);
  }
 }
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true});
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.DOMMatrix=native.DOMMatrix;globalThis.Path2D=native.Path2D;globalThis.ImageData=native.ImageData;
 globalThis.FontFace=class{constructor(name,bytes){this.name=name;this.bytes=bytes;}async load(){native.GlobalFonts.register(Buffer.from(this.bytes),this.name);return this;}};document.fonts={add(){}};
 const canvases=new WeakMap();function canvas(el){let c=canvases.get(el);if(!c||c.width!==el.width||c.height!==el.height){c=native.createCanvas(el.width,el.height);canvases.set(el,c);}return c;}
 window.HTMLCanvasElement.prototype.getContext=function(type){const ctx=canvas(this).getContext(type);if(!ctx._wrapped){const draw=ctx.drawImage.bind(ctx);ctx.drawImage=(image,...args)=>draw(image instanceof window.HTMLCanvasElement?canvas(image):image,...args);ctx._wrapped=true;}return ctx;};window.HTMLCanvasElement.prototype.toBlob=function(callback,mime){canvas(this).toBlob(callback,mime);};
 t.after(()=>{dom.window.close();for(const key of ['window','document','DOMMatrix','Path2D','ImageData','FontFace'])delete globalThis[key];});
}

async function fixture(names) {
 const doc=await PDFDocument.create(),page=doc.addPage([500,700]);
 for(let i=0;i<names.length;i++)page.drawText(`Original label ${i}.`,{x:40,y:640-i*35,size:14,font:await doc.embedFont(names[i])});
 return source(await doc.save());
}

test('original standard font, weight and baseline survive inline, block and reflow exports',async t=>{
 canvasEnvironment(t);
 const names=['Times-Roman','Times-Bold','Times-Italic','Times-BoldItalic','Helvetica','Helvetica-Bold','Helvetica-Oblique','Helvetica-BoldOblique','Courier','Courier-Bold','Courier-Oblique','Courier-BoldOblique'];
 const input=await fixture(names),parsed=await readTextSource(input),blocks=parsed.blocks.map((b,i)=>({...b,key:`line-${i}`}));
 assert.equal(blocks.length,names.length);
 const viewer=await openPdfVisual(input);
 try {
  for(let i=0;i<names.length;i++) {
   const selected=await viewer.editFont(blocks[i],`Revised label ${i}`);
   assert.equal(selected.name,names[i]);
   const measured=await measurePdfBlockFont(input,blocks[i],`Revised label ${i}`);
   assert.equal(measured.widthOfTextAtSize('Revised label',14),selected.font.widthOfTextAtSize('Revised label',14));
  }
  const legacy=structuredClone(blocks[0]);delete legacy.visual.fontItems;
  assert.equal((await viewer.editFont(legacy,'Revised label')).name,'Times-Roman','Saved sessions re-read font identity from the source');
  await assert.rejects(()=>viewer.editFont(blocks[0],'Новая строка'),/does not contain every character/);
  const canvas=document.createElement('canvas'),seen=[];
  // Set dimensions before grabbing the context; renderPage keeps them unchanged.
  canvas.width=500;canvas.height=700;
  const same=canvas.getContext('2d'),paint=same.fillText.bind(same);same.fillText=(text,...args)=>{if(text==='Revised label 1')seen.push(same.font);return paint(text,...args);};
  await viewer.renderPage(1,canvas,{edits:[{block:blocks[1],text:'Revised label 1'}],blocks});
  assert.ok(seen.some(font=>/bold/.test(font)&&/Times/.test(font)),seen.join(','));
 } finally {await viewer.dispose();}
 const edits=blocks.map((block,i)=>({block,text:`Revised label ${i}`}));
 const revised=await renderPdfRevision(input,edits,{blocks}),read=await readTextSource(source(revised)),reopened=await openPdfVisual(source(revised));
 try {for(let i=0;i<names.length;i++){assert.equal((await reopened.editFont(read.blocks[i],`Another label ${i}`)).name,names[i]);assert.ok(Math.abs(read.blocks[i].visual.rects[0].baselineY-blocks[i].visual.rects[0].baselineY)<.02,'Baseline unchanged');}}finally{await reopened.dispose();}
 assert.doesNotMatch(read.blocks.map(b=>b.text).join(' '),/Original/);
 const blockOutput=await renderPdfRevision(input,[{block:blocks[1],text:'Bold line\nSecond line',box:{width:200,height:32,fontSize:12}}],{blocks});
 const blockRead=await readTextSource(source(blockOutput)),blockView=await openPdfVisual(source(blockOutput));
 try {assert.equal((await blockView.editFont(blockRead.blocks.find(b=>b.text==='Original label 0.'),'Another label')).name,'Times-Roman','Untouched text retains its font when the exported PDF is edited again');for(const b of blockRead.blocks.filter(b=>/Bold line|Second line/.test(b.text)))assert.equal((await blockView.editFont(b,'More text')).name,'Times-Bold');}finally{await blockView.dispose();}
 const entries=blocks.map((block,i)=>({key:block.key,record:block.record,text:i===1?'Bold heading expands across several lines with its original typeface and weight':block.text}));
 const flowed=await renderPreservedPdf(input,entries,{blocks}),flowRead=await readTextSource(source(flowed)),flowView=await openPdfVisual(source(flowed));
 try {const heading=flowRead.blocks.find(b=>b.text.startsWith('Bold heading'));assert.ok(heading);assert.equal((await flowView.editFont(heading,'More text')).name,'Times-Bold');}finally{await flowView.dispose();}
 if(process.env.CTT_FONT_TEST_ARTIFACTS){writeFileSync(process.env.CTT_FONT_TEST_ARTIFACTS+'/original.pdf',Buffer.from(input.data,'base64'));writeFileSync(process.env.CTT_FONT_TEST_ARTIFACTS+'/revised.pdf',revised);writeFileSync(process.env.CTT_FONT_TEST_ARTIFACTS+'/flowed.pdf',flowed);}
});

test('mixed and unsupported custom fonts never silently become another font',async t=>{
 canvasEnvironment(t);
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);const page=doc.addPage([400,500]),regular=await doc.embedFont('Times-Roman'),bold=await doc.embedFont('Times-Bold');
 page.drawText('Regular ',{x:40,y:450,size:14,font:regular});page.drawText('bold',{x:40+regular.widthOfTextAtSize('Regular ',14),y:450,size:14,font:bold});
 const custom=await doc.embedFont(Buffer.from(boldFont,'base64'),{subset:true});page.drawText('Custom heading',{x:40,y:400,size:14,font:custom});
 const input=source(await doc.save()),{blocks}=await readTextSource(input),viewer=await openPdfVisual(input);
 try {assert.equal(blocks.length,2);await assert.rejects(()=>viewer.editFont(blocks[0],'New wording'),/different fonts/);await assert.rejects(()=>viewer.editFont(blocks[1],'New heading'),/not supported for editing/);}finally{await viewer.dispose();}
 const grouped=await fixture(['Times-Roman','Times-Bold']),groupedRead=await readTextSource(grouped),groupedBlocks=groupedRead.blocks.map(b=>({...b,key:'group'}));
 await assert.rejects(()=>renderPreservedPdf(grouped,[{key:'group',record:1,text:'A combined replacement'}],{blocks:groupedBlocks}),/combines different fonts/);
});
