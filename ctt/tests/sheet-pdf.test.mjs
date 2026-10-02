import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import {read,write,utils,CFB} from '../dist/xlsx-vendor.mjs';
import {openSheetDocument} from '../dist/sheet-document.mjs';
import {captureSheetPdf} from '../dist/sheet-pdf-model.mjs';
import {renderSheetPdf} from '../dist/sheet-pdf.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {handleRequest} from '../dist/worker.mjs';
import {mountSheetReview} from '../dist/sheet-review.mjs';
const source=(name,data)=>({name,data:Buffer.from(data).toString('base64')});
async function extract(data){const task=getDocument({data:data.slice(),disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,useWasm:false,isEvalSupported:false,verbosity:0});try{const doc=await task.promise,pages=[];for(let i=1;i<=doc.numPages;i++){const p=await doc.getPage(i);pages.push((await p.getTextContent()).items.map(i=>i.str).join(' '));}return pages;}finally{await task.destroy();}}
async function artifact(name,data){if(process.env.SHEET_PDF_ARTIFACT_DIR){await mkdir(process.env.SHEET_PDF_ARTIFACT_DIR,{recursive:true});await writeFile(process.env.SHEET_PDF_ARTIFACT_DIR+'/'+name,data);}}
test('XLSX PDF captures formatted edited values, real offset header and sparse bounds',async()=>{
 const wb=utils.book_new(),ws=utils.aoa_to_sheet([[],['','','sku','date','price'],['','',1,45000,12.5]]);ws.C3.z='000';ws.D3.z='yyyy-mm-dd';ws.E3.z='0.00';wb.Workbook={WBProps:{date1904:true}};utils.book_append_sheet(wb,ws,'Orders');utils.book_append_sheet(wb,utils.aoa_to_sheet([['Do not export'],[{t:'n',v:4,f:'2+2'}]]),'Other');
 const raw=new Uint8Array(write(wb,{type:'array',bookType:'xlsx',compression:true})),archive=CFB.read(raw,{type:'array'}),part=CFB.find(archive,'/xl/worksheets/sheet1.xml');CFB.utils.cfb_add(archive,'/xl/worksheets/sheet1.xml',new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<dimension ref="[^"]+"\/>/,'<dimension ref="A1:XFD1048576"/>')));
 const src=source('orders.xlsx',new Uint8Array(CFB.write(archive,{type:'array',fileType:'zip',compression:true}))),doc=await openSheetDocument(src,{format:'xlsx',sheet:'Orders',headers:['sku','date','price'],header_cells:{sku:'C2',date:'D2',price:'E2'}});
 doc.edit('D3','45001','number');doc.edit('E3','18.75','number');assert.equal(doc.display('D3'),'2027-03-17');const model=captureSheetPdf(doc,{name:src.name});assert.deepEqual(model.columns,['C','D','E']);assert.equal(model.header,0);assert.equal(model.rows.length,2);assert.equal(model.rows[1].cells[0].text,'001');
 const pdf=await renderSheetPdf(model),text=(await extract(pdf)).join(' ');assert.match(text,/001/);assert.match(text,/2027-03-17/);assert.match(text,/18.75/);assert.doesNotMatch(text,/Do not export/);await artifact('sheet-dates.pdf',pdf);
 const revision=doc.revision,snapshot=doc.snapshot();doc.restore(snapshot);assert.ok(doc.revision>revision,'Restoration invalidates a prepared PDF');
});
test('wide CSV PDF repeats real headers and first column, wrapping long cells without clipping',async()=>{
 const cols=Array.from({length:12},(_,c)=>'Column '+(c+1)),rows=[cols,...Array.from({length:65},(_,r)=>cols.map((_,c)=>c?'r'+(r+1)+'c'+(c+1):String(r+1).padStart(3,'0')))];rows[2][2]=Array.from({length:100},(_,i)=>'Detail '+(i+1)).join('\n');rows[3][3]='END'+('X'.repeat(240))+'MARK';
 const csv=rows.map(row=>row.map(v=>/[\n,"]/.test(v)?'"'+v.replaceAll('"','""')+'"':v).join(',')).join('\n'),src=source('wide.csv',csv),doc=await openSheetDocument(src,{format:'csv',headers:cols},',');doc.edit('L66','FINAL EDIT','text');
 let layout;const model=captureSheetPdf(doc,{name:src.name}),pdf=await renderSheetPdf(model,{onLayout:r=>layout=r}),pages=await extract(pdf);assert.ok(pages.length>4);assert.equal(Math.max(...layout.map(r=>r.part)),1);for(const page of pages)assert.match(page,/Column 1/);assert.match(pages.join(' '),/FINAL EDIT/);for(let i=1;i<=100;i++)assert.match(pages.join(' '),new RegExp(`Detail ${i}(?: |$)`));assert.ok(pages.join('').replace(/\s/g,'').includes(rows[3][3]));
 for(const row of layout){assert.ok(row.x>=32);assert.ok(row.x+row.width<=row.pageWidth-32+.01);assert.ok(row.y+row.height<=row.pageHeight-47+.01);assert.ok(row.lineWidths.every(w=>w<=row.width-2*row.padding+.01));assert.ok(row.fontSize>=8.5);}
 for(let c=0;c<12;c++)assert.ok(layout.some(r=>r.column===utils.encode_col(c)&&r.row===66),'Every last-row column is present');
 assert.equal(model.rows[1].cells[0].text,'001');await artifact('sheet-wide.pdf',pdf);
 const ctl=new AbortController();ctl.abort();await assert.rejects(()=>renderSheetPdf(model,{signal:ctl.signal}),{name:'AbortError'});
});

const require=createRequire(import.meta.url),{JSDOM}=require('jsdom');const native=require('@napi-rs/canvas');
test('sheet PDF preview commits pending input and copied rows; undo invalidates old download',{skip:!native},async t=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),root=dom.window.document.querySelector('main');Object.assign(globalThis,{window:dom.window,document:dom.window.document,DOMMatrix:native.DOMMatrix,Path2D:native.Path2D,ImageData:native.ImageData});
 const canvases=new WeakMap();function canvas(el){let c=canvases.get(el);if(!c||c.width!==el.width||c.height!==el.height){c=native.createCanvas(el.width,el.height);canvases.set(el,c);}return c;}
 window.HTMLCanvasElement.prototype.getContext=function(type){const ctx=canvas(this).getContext(type);if(!ctx._wrapped){const draw=ctx.drawImage.bind(ctx);ctx.drawImage=(img,...a)=>draw(img instanceof window.HTMLCanvasElement?canvas(img):img,...a);ctx._wrapped=true;}return ctx;};
 let view;const downloads=[],oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=b=>{downloads.push(b);return 'blob:sheet-pdf';};URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=function(){};
 t.after(()=>{view?.dispose();dom.window.close();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;for(const k of ['window','document','DOMMatrix','Path2D','ImageData'])delete globalThis[k];});
 const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await delay(20);}assert.fail(root.textContent);};
 const sources={left:source('a.csv','sku,price\n001,10\n002,20\n003,30\n'),right:source('b.csv','sku,price\n001,12\n003,30\n')},report=(await handleRequest('/api/compare',{...sources,delimiter:',',key:['sku','sku'],fields:[['price','price','number']],strip:false})).report;view=await mountSheetReview(root,{sources,report});
 root.querySelector('[data-side="left"][data-cell="A3"]').click();root.querySelector('[data-copy-row-from="left"]').click();root.querySelector('[data-side="right"][data-cell="B3"]').click();root.querySelector('[data-edit-side="right"]').value='25.50';root.querySelector('[data-download-format="right"]').value='pdf';root.querySelector('[data-save-side="right"]').click();
 const dialog=()=>root.querySelector('.document-pdf-dialog'),save=()=>dialog()?.querySelector('.primary');await until(()=>save()&&!save().disabled);const saved=view.snapshot();assert.equal(root.querySelector('[data-side="right"][data-cell="B3"]').textContent,'25.50');save().click();assert.equal(downloads.length,1);const text=(await extract(new Uint8Array(await downloads[0].arrayBuffer()))).join(' ');assert.match(text,/002/);assert.match(text,/25.50/);assert.ok(text.indexOf('002')<text.indexOf('003'));assert.deepEqual(view.snapshot(),saved);
 root.querySelector('[data-sheet-undo]').click();save().click();assert.equal(downloads.length,1);assert.match(dialog().textContent,/document changed/);dialog().querySelector('.pdf-block-actions .secondary').click();
 root.querySelector('[data-save-side="right"]').click();await until(()=>dialog());dialog().querySelector('.pdf-block-actions .secondary').click();await delay(30);assert.equal(dialog(),null);assert.equal(downloads.length,1);
});

const pdfModel=values=>({name:'Export test',sheet:'Data',columns:values[0].map((_,c)=>utils.encode_col(c)),header:0,rows:values.map((row,r)=>({number:r+1,cells:row.map(text=>({text:String(text),align:'left'}))}))});
test('fit columns keeps seven mixed columns together and uses bounded font reduction',async()=>{
 const headers=['Description','Category','Quantity','Monthly trend','Difficulty score','Unit price (USD)','Additional details'];
 const values=[headers,...Array.from({length:20},(_,i)=>['Document comparison product '+i,'Informational','27100','0.44,0.81,0.67,1.00,1.00,0.81,0.81,0.81,0.67,0.81,1.00,0.67','72','3.57','Reviews, images, related products, frequently asked questions'])];
 let layout;const pdf=await renderSheetPdf(pdfModel(values),{onLayout:r=>layout=r}),pages=await extract(pdf);assert.ok(pages.length>1);assert.ok(layout.every(r=>r.part===1&&r.fontSize===9.5&&r.pageWidth>r.pageHeight));for(const page of pages)assert.match(page,/Additional details/);
 for(let i=0;i<20;i++)assert.ok(layout.some(r=>r.row===i+2&&r.column==='G'));for(const r of layout)assert.ok(r.lineWidths.every(w=>w<=r.width-2*r.padding+.01));await artifact('sheet-fit-columns.pdf',pdf);
 for(const count of [15,16]){let fit;const model=pdfModel([Array(count).fill('Text'),Array(count).fill('Short')]);await renderSheetPdf(model,{onLayout:r=>fit=r});assert.ok(fit.every(r=>r.fontSize>=8.5));if(count===15){assert.ok(fit.every(r=>r.part===1&&r.fontSize<9.5));}else assert.ok(fit.every(r=>r.part===1&&r.pageWidth>841.89));}
});
test('very wide tables retain every column, repeated identifiers and long formatted values',async()=>{
 const numbers=['0000123','-1,234.50','12.75%','$123,456.78','123456789012345678901234567890123456789012345678901234567890'];
 let numericLayout;const numeric=await renderSheetPdf(pdfModel([numbers.map((_,i)=>'Numeric value '+i),numbers]),{onLayout:r=>numericLayout=r});const numericText=(await extract(numeric)).join('');for(const value of numbers)assert.ok(numericText.replace(/\s/g,'').includes(value));assert.ok(numericLayout.every(r=>r.part===1));
 let headings;await renderSheetPdf(pdfModel([Array(7).fill('Measurement '.repeat(18)),Array(7).fill('Short')]),{onLayout:r=>headings=r});assert.ok(headings.every(r=>r.part===1),'Long headings stay together');
 const model=pdfModel([Array.from({length:40},(_,i)=>'Column '+i),Array.from({length:40},(_,i)=>i?'value-'+i:'9'.repeat(500))]);let layout;
 const pdf=await renderSheetPdf(model,{onLayout:r=>layout=r}),pages=await extract(pdf);assert.ok(layout.every(r=>r.part===1));assert.ok(layout[0].pageWidth>841.89);for(const page of pages)assert.match(page,/Column 0/);
 for(let c=0;c<40;c++)assert.ok(layout.some(r=>r.row===2&&r.column===utils.encode_col(c)));
 const firstPart=layout.filter(r=>r.row===2&&r.column==='A'&&r.part===1).flatMap(r=>r.lines).join('');assert.equal(firstPart,'9'.repeat(500));
 for(const r of [...layout,...numericLayout]){assert.ok(r.x+r.width<=r.pageWidth-32+.01);assert.ok(r.lineWidths.every(w=>w<=r.width-2*r.padding+.01));assert.ok(r.fontSize>=8.5);}
});

test('PDF embeds emoji in Cyrillic cells and titles, preserves dark-fill contrast',async()=>{
 const model=pdfModel([['Заголовок 👇','Совет 🦄','Флаг 🚩'],['Обычный текст и 👇','Значки 🦄 и 🚩','Текст на тёмной заливке']]);model.name='Таблица 🦄';model.sheet='Советы 🚩';
 model.rows[1].cells[2].fill='#000000';model.rows[1].cells[2].foreground='#ffffff';let layout;const pdf=await renderSheetPdf(model,{onLayout:l=>layout=l}),text=(await extract(pdf)).join(' ');
 for(const value of ['Заголовок','👇','🦄','🚩','Текст','тёмной','заливке'])assert.ok(text.replace(/\s/g,'').includes(value.replace(/\s/g,'')),value+' survives PDF extraction: '+text);
 for(const cell of layout)assert.ok(cell.lineWidths.every(w=>w<=cell.width-2*cell.padding+.01));
 await artifact('sheet-emoji.pdf',pdf);
 const {styledSheetFixture}=await import('./fixtures/styled-sheet-fixture.mjs');const src=source('colored.xlsx',styledSheetFixture()),doc=await openSheetDocument(src,{format:'xlsx',sheet:'Styled',headers:[]}),captured=captureSheetPdf(doc);assert.equal(captured.rows[1].cells[0].fill,'#000000');assert.equal(captured.rows[1].cells[0].foreground,'#ffffff');assert.equal(captured.rows[2].cells[0].foreground,'#000000');
});

test('the three spreadsheet emoji have visible PDF outlines, not only extractable text',{skip:!native},async t=>{
 Object.assign(globalThis,{DOMMatrix:native.DOMMatrix,Path2D:native.Path2D,ImageData:native.ImageData});
 t.after(()=>{for(const key of ['DOMMatrix','Path2D','ImageData'])delete globalThis[key];});
 let layout;const bytes=await renderSheetPdf(pdfModel([['One','Two','Three'],['👇','🦄','🚩']]),{onLayout:l=>layout=l});
 const task=getDocument({data:bytes,stopAtErrors:true,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,useWasm:false,isEvalSupported:false,verbosity:0});
 try{const pdf=await task.promise,page=await pdf.getPage(1),scale=3,viewport=page.getViewport({scale}),canvas=native.createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height)),ctx=canvas.getContext('2d');
  await page.render({canvasContext:ctx,viewport}).promise;
  for(const cell of layout.filter(c=>c.row===2)){
   const x=Math.ceil((cell.x+2)*scale),y=Math.ceil((cell.y+2)*scale),w=Math.floor((cell.width-4)*scale),h=Math.floor((cell.height-4)*scale),pixels=ctx.getImageData(x,y,w,h).data;let ink=0;
   for(let i=0;i<pixels.length;i+=4)if(pixels[i]<180&&pixels[i+1]<180&&pixels[i+2]<180)ink++;
   assert.ok(ink>30,cell.lines[0]+' must have visible ink, got '+ink);
  }
 }finally{await task.destroy();}
});

test('merged cells retain their full width in PDF and long merged content continues without loss',async()=>{
 const book=utils.book_new(),ws=utils.aoa_to_sheet([['MERGED TITLE'],['Long content','Side value','Last column'],['','','Bottom']]);ws.A2.v=Array.from({length:150},(_,i)=>'UniqueLine'+i).join('\n');ws['!merges']=[utils.decode_range('A1:M1'),utils.decode_range('A2:A3')];
 utils.book_append_sheet(book,ws,'Merged');const src=source('merged.xlsx',write(book,{type:'array',bookType:'xlsx',compression:true}));const doc=await openSheetDocument(src,{format:'xlsx',sheet:'Merged',headers:[]});doc.edit('A3','Updated\n'+ws.A2.v,'text');assert.equal(doc.input('A2'),'Updated\n'+ws.A2.v);assert.equal(doc.textEntries().filter(e=>e.text.includes('UniqueLine')).length,1);
 assert.throws(()=>doc.insertRow(2,[]),/before or after/);const before=doc.snapshot();assert.throws(()=>doc.restore({version:1,insertions:[2],patches:[['A3',{t:'s',v:'hidden'}]]}),/row inside a merged/);assert.deepEqual(doc.snapshot(),before);const model=captureSheetPdf(doc);assert.equal(model.columns.length,13);assert.equal(model.rows[0].cells[0].colSpan,13);assert.equal(model.rows[0].cells[1].covered,true);
 let layout;const bytes=await renderSheetPdf(model,{onLayout:l=>layout=l}),pages=await extract(bytes);assert.ok(pages.length>1);const text=pages.join(' ');for(let i=0;i<150;i++)assert.match(text,new RegExp('UniqueLine'+i+'(?: |$)'));assert.match(text,/Last column/);assert.match(text,/Bottom/);
 const title=layout.find(c=>c.row===1);assert.equal(title.colSpan,13);assert.ok(title.width>500);assert.ok(layout.every(c=>c.part===1));assert.ok(!layout.some(c=>c.row===1&&c.column!=='A'));assert.ok(layout.some(c=>c.row===2&&c.continued));for(const c of layout){assert.ok(c.x+c.width<=c.pageWidth-32+.01);assert.ok(c.y+c.height<=c.pageHeight-47+.01);assert.ok(c.lineWidths.every(w=>w<=c.width-2*c.padding+.01));}
 await artifact('merged-sheet.pdf',bytes);
});
