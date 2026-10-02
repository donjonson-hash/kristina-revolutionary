import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openSheetDocument,parseCsv} from '../dist/sheet-document.mjs';
import {read,write,utils,CFB} from '../dist/xlsx-vendor.mjs';
import {validateSessionPayload} from '../dist/session-store.mjs';
import {handleRequest} from '../dist/worker.mjs';
const source=(name,data)=>({name,data:Buffer.from(data).toString('base64')});
function workbook(price){const wb=utils.book_new();const sheet=utils.aoa_to_sheet([['sku','price','note'],['X',price,'a\nb'],[],['Y',2,'unchanged']]);sheet.B2.z='0.00';utils.book_append_sheet(wb,sheet,'Orders');utils.book_append_sheet(wb,utils.aoa_to_sheet([['formula'],[{t:'n',v:4,f:'2+2'}]]),'Other');return new Uint8Array(write(wb,{type:'array',bookType:'xlsx',compression:true}));}
test('edited XLSX preserves numeric types, styles, blank rows and every unrelated ZIP part',async()=>{
 const bytes=workbook(10),src={...source('orders.xlsx',bytes),sheet:'Orders'};
 const setup=await handleRequest('/api/prepare',{left:src,right:src});const doc=await openSheetDocument(src,setup.left,',');
 doc.edit('B2','12.5','number');doc.edit('C2','new\ntext _x0041_','text');doc.copy([['A5',{t:'s',v:'Z'}],['B5',{t:'n',v:18}],['C5',{t:'s',v:'new row'}]]);
 const output=doc.export();const wb=read(output,{type:'array',cellNF:true});assert.equal(wb.Sheets.Orders.B2.v,12.5);assert.equal(wb.Sheets.Orders.B2.t,'n');assert.equal(wb.Sheets.Orders.B2.z,'0.00');assert.equal(wb.Sheets.Orders.C2.v,'new\ntext _x0041_');assert.equal(wb.Sheets.Orders.B5.v,18);assert.equal(wb.Sheets.Orders.A3,undefined);assert.equal(wb.Sheets.Other.A2.f,'2+2');
 const before=CFB.read(bytes,{type:'array'}),after=CFB.read(output,{type:'array'});for(let i=0;i<before.FullPaths.length;i++){const name=before.FullPaths[i];if(before.FileIndex[i].type!==2||name.endsWith('worksheets/sheet1.xml')||name.endsWith('xl/workbook.xml')||name.endsWith('\u0001Sh33tJ5'))continue;assert.deepEqual(new Uint8Array(CFB.find(after,name).content),new Uint8Array(before.FileIndex[i].content),name);}
 const snapshot=doc.snapshot(),restored=await openSheetDocument(src,setup.left,',');restored.restore(snapshot);assert.deepEqual([...restored.export()],[...output]);assert.throws(()=>restored.restore({version:1,patches:[['A0',{t:'s',v:'bad'}]]}));
});
test('CSV round trip preserves exact strings, quoting, delimiter, multiline fields and BOM',async()=>{
 const src=source('a.csv','\ufeffsku;amount;note\r\n001;1.00;"line 1\nline 2"\r\n002;2.00;"say ""hello"""\r\n');
 const doc=await openSheetDocument(src,{headers:['sku','amount','note']},';');doc.edit('C2','new; "quoted"\nline','text');const bytes=doc.export(),text=new TextDecoder().decode(bytes);assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);assert.ok(text.endsWith('\r\n'));assert.deepEqual(parseCsv(text,';'),[['sku','amount','note'],['001','1.00','new; "quoted"\nline'],['002','2.00','say "hello"']]);doc.undo();assert.deepEqual(doc.export(),new Uint8Array(Buffer.from(src.data,'base64')));
});
test('table sessions validate without changing the legacy text session format',async()=>{
 const left=source('a.csv','sku,price\nX,10\n'),right=source('b.csv','sku,price\nX,12\n');const {report}=await handleRequest('/api/compare',{left,right,delimiter:',',key:['sku','sku'],fields:[['price','price','number']],strip:false});
 const payload={version:1,sources:{left,right},report,review:{kind:'sheet',version:1}};assert.equal(validateSessionPayload(payload).report.status,'complete');assert.throws(()=>validateSessionPayload({...payload,review:{}}));
});

import {createRequire} from 'node:module';
import {mountSheetReview} from '../dist/sheet-review.mjs';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
test('restored spreadsheet review retains edited cells, copied row and Keep B decisions',async t=>{
 const left=source('a.csv','sku,price\nX,10\nY,20\n'),right=source('b.csv','sku,price\nX,12\n');const {report}=await handleRequest('/api/compare',{left,right,delimiter:',',key:['sku','sku'],fields:[['price','price','number']],strip:false});
 const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;const root=document.querySelector('main');let view=await mountSheetReview(root,{sources:{left,right},report});t.after(()=>{view.dispose();dom.window.close();delete globalThis.document;});
 await view.select('X');root.querySelector('[data-side="right"][data-cell="B2"]').click();root.querySelector('[data-review-action="keep"]').click();
 root.querySelector('[data-side="left"][data-cell="A3"]').click();root.querySelector('[data-copy-row-from="left"]').click();
 const payload=validateSessionPayload({version:1,sources:{left,right},report,review:view.snapshot()});view.dispose();view=await mountSheetReview(root,{sources:payload.sources,report:payload.report,restoredState:payload.review});
 assert.equal(root.querySelector('[data-side="right"][data-cell="A3"]').textContent,'Y');assert.equal(root.querySelector('[data-side="right"][data-cell="B3"]').textContent,'20');assert.equal(root.querySelector('[data-review-action="download"]').hidden,false);
 root.querySelector('[data-side="right"][data-cell="B2"]').click();root.querySelector('[data-edit-side="right"]').value='13';root.querySelector('[data-apply-cell="right"]').click();assert.equal(root.querySelector('[data-review-action="download"]').hidden,true);
});
test('copying an XLSX date into CSV retains its date text, and cleared inserted rows restore',async t=>{
 const wb=utils.book_new(),ws=utils.aoa_to_sheet([['sku','date'],[1,45000]]);ws.A2.z='000';ws.B2.z='yyyy-mm-dd';utils.book_append_sheet(wb,ws,'Data');
 const left=source('a.xlsx',new Uint8Array(write(wb,{type:'array',bookType:'xlsx',compression:true}))),right=source('b.csv','sku,date\n002,2000-01-01\n');
 const {report}=await handleRequest('/api/compare',{left,right,delimiter:',',key:['sku','sku'],fields:[['date','date','text']],strip:false});
 const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;const root=document.querySelector('main');let view=await mountSheetReview(root,{sources:{left,right},report});t.after(()=>{view.dispose();dom.window.close();delete globalThis.document;});
 root.querySelector('[data-side="left"][data-cell="A2"]').click();root.querySelector('[data-copy-row-from="left"]').click();assert.equal(root.querySelector('[data-side="right"][data-cell="A2"]').textContent,'001');assert.equal(root.querySelector('[data-side="right"][data-cell="B2"]').textContent,'2023-03-15');
 for(const addr of ['A2','B2']){root.querySelector(`[data-side="right"][data-cell="${addr}"]`).click();root.querySelector('[data-edit-side="right"]').value='';root.querySelector('[data-apply-cell="right"]').click();}
 const saved=view.snapshot();view.dispose();view=await mountSheetReview(root,{sources:{left,right},report,restoredState:saved});assert.equal(root.querySelector('[data-side="right"][data-cell="A2"]').textContent,'');
});

test('inserting an XLSX row shifts original cells, styles, row heights, links and workbook references',async()=>{
 const wb=utils.book_new(),ws=utils.aoa_to_sheet([['sku','price'],['X',10],['Z',30]]);ws.B3.z='0.00';ws.A3.l={Target:'https://example.com'};ws['!rows']=[{},{},{hpt:28}];ws['!autofilter']={ref:'A1:B3'};utils.book_append_sheet(wb,ws,'Orders');
 const other=utils.aoa_to_sheet([['total'],[{t:'n',v:30,f:'Orders!B3+LEN("B3")'}],[{t:'n',v:30,f:"SUM('Orders'!$B$2:$B$3)"}]]);utils.book_append_sheet(wb,other,'Other');wb.Workbook={Names:[{Name:'OrderPrices',Ref:'Orders!$B$2:$B$3'}]};
 const raw=new Uint8Array(write(wb,{type:'array',bookType:'xlsx',compression:true})),src={...source('a.xlsx',raw),sheet:'Orders'},setup=await handleRequest('/api/prepare',{left:src,right:src});const doc=await openSheetDocument(src,setup.left);
 doc.edit('B3','35','number');doc.insertRow(2,[['A3',{t:'s',v:'Y'}],['B3',{t:'n',v:20}]]);
 assert.equal(doc.display('A3'),'Y');assert.equal(doc.display('A4'),'Z');assert.equal(doc.display('B4'),'35.00');assert.equal(doc.mapRow(2),3);
 const bytes=doc.export(),out=read(bytes,{type:'array',cellNF:true,cellStyles:true});assert.deepEqual(utils.sheet_to_json(out.Sheets.Orders,{header:1}),[['sku','price'],['X',10],['Y',20],['Z',35]]);assert.equal(out.Sheets.Orders.B4.z,'0.00');assert.equal(out.Sheets.Orders.A4.l.Target,'https://example.com');assert.equal(out.Sheets.Orders['!rows'][3].hpt,28);assert.equal(out.Sheets.Orders['!autofilter'].ref,'A1:B4');assert.equal(out.Sheets.Other.A2.f,'Orders!B4+LEN("B3")');assert.equal(out.Sheets.Other.A3.f,"SUM('Orders'!$B$2:$B$4)");assert.equal(out.Workbook.Names[0].Ref,'Orders!$B$2:$B$4');
 const restored=await openSheetDocument(src,setup.left);restored.restore(doc.snapshot());assert.deepEqual([...restored.export()],[...bytes]);doc.undo();assert.equal(doc.input('A3'),'Z');assert.equal(doc.input('B3'),'35');doc.undo();const undone=read(doc.export(),{type:'array'});assert.deepEqual(utils.sheet_to_json(undone.Sheets.Orders,{header:1}),[['sku','price'],['X',10],['Z',30]]);assert.equal(undone.Sheets.Other.A3.f,"SUM('Orders'!$B$2:$B$3)");assert.equal(undone.Sheets.Other.A3.v,40);assert.equal(undone.Workbook.Names[0].Ref,'Orders!$B$2:$B$3');
});

test('missing rows copied out of order land between their source neighbors, including after restore and undo',async t=>{
 const left=source('a.csv','sku,price\nX,10\nY,20\nZ,30\nW,40\n'),right=source('b.csv','sku,price\nX,11\nW,41\n');const {report}=await handleRequest('/api/compare',{left,right,delimiter:',',key:['sku','sku'],fields:[['price','price','number']],strip:false});
 const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;const root=document.querySelector('main');let view=await mountSheetReview(root,{sources:{left,right},report});t.after(()=>{view.dispose();dom.window.close();delete globalThis.document;});
 const q=s=>root.querySelector(s),copy=async key=>{await view.select(key);q('[data-copy-row-from="left"]').click();},values=()=>[...root.querySelectorAll('[data-side="right"][data-cell^="A"]')].map(n=>n.textContent);
 q('[data-side="right"][data-cell="B3"]').click();q('[data-edit-side="right"]').value='45';q('[data-apply-cell="right"]').click();
 await copy('Z');assert.deepEqual(values(),['sku','X','Z','W']);
 let saved=view.snapshot();view.dispose();view=await mountSheetReview(root,{sources:{left,right},report,restoredState:saved});
 await copy('Y');assert.deepEqual(values(),['sku','X','Y','Z','W']);assert.equal(q('[data-side="right"][data-cell="B5"]').textContent,'45');
 await view.select('W');assert.match(q('.visual-inspector strong').textContent,/B A5/);
 q('[data-sheet-undo]').click();assert.deepEqual(values(),['sku','X','Z','W']);assert.equal(q('[data-side="right"][data-cell="B4"]').textContent,'45');
 await copy('Y');saved=view.snapshot();view.dispose();view=await mountSheetReview(root,{sources:{left,right},report,restoredState:saved});assert.deepEqual(values(),['sku','X','Y','Z','W']);
 const model=await openSheetDocument(right,report.sources.right);model.restore(saved.drafts.right);assert.equal(new TextDecoder().decode(model.export()),'sku,price\nX,11\nY,20\nZ,30\nW,45\n');
});

test('visible sheet undo discards pending input, reverses applied edits and row copies, and restores its disabled state',async t=>{
 const left=source('a.csv','sku,price\nX,10\nY,20\n'),right=source('b.csv','sku,price\nX,12\n');
 const {report}=await handleRequest('/api/compare',{left,right,delimiter:',',key:['sku','sku'],fields:[['price','price','number']],strip:false});
 const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;const root=document.querySelector('main');const view=await mountSheetReview(root,{sources:{left,right},report});t.after(()=>{view.dispose();dom.window.close();delete globalThis.document;});
 const q=s=>root.querySelector(s),controls=()=>[...root.querySelectorAll('[data-sheet-undo]')],inspector=q('.visual-inspector [data-sheet-undo]');
 q('[data-side="right"][data-cell="B2"]').click();assert.equal(inspector.closest('.visual-inspector').hidden,false);assert.ok(controls().every(n=>n.disabled));
 const field=q('[data-edit-side="right"]');field.value='99';field.dispatchEvent(new dom.window.Event('input'));assert.ok(controls().every(n=>!n.disabled&&n.textContent==='Discard cell edit'));
 inspector.click();assert.equal(field.value,'12');assert.equal(q('[data-side="right"][data-cell="B2"]').textContent,'12');assert.ok(controls().every(n=>n.disabled));
 field.value='15';field.dispatchEvent(new dom.window.Event('input'));q('[data-apply-cell="right"]').click();assert.equal(q('[data-side="right"][data-cell="B2"]').textContent,'15');assert.equal(inspector.textContent,'Undo last change');
 field.value='17';field.dispatchEvent(new dom.window.Event('input'));inspector.click();assert.equal(field.value,'15');assert.equal(view.snapshot().undo.length,1);inspector.click();assert.equal(field.value,'12');assert.ok(controls().every(n=>n.disabled));
 q('[data-side="left"][data-cell="A3"]').click();q('[data-copy-row-from="left"]').click();assert.equal(q('[data-side="right"][data-cell="A3"]').textContent,'Y');inspector.click();assert.equal(q('[data-side="right"][data-cell="A3"]'),null);assert.ok(controls().every(n=>n.disabled));
});

import {sheetCellColors,sheetColumnWidth} from '../dist/sheet-display.mjs';
import {styledSheetFixture} from './fixtures/styled-sheet-fixture.mjs';
import {singleSheetMetadata} from '../dist/single-editor.mjs';
test('styled XLSX uses full-cell contrast and original column widths without changing workbook styles on edit',async t=>{
 const raw=styledSheetFixture(),src=source('styled.xlsx',raw),meta=await singleSheetMetadata(src,{sheet:'Styled'}),report={status:'complete',sources:{left:meta,right:meta},rules:{delimiter:',',key:['',''],fields:[],strip:false},matched:[]};
 const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;const root=document.querySelector('main'),view=await mountSheetReview(root,{sources:{left:src,right:src},report,single:true});t.after(()=>{view.dispose();dom.window.close();delete globalThis.document;});
 const q=s=>root.querySelector(s),cell=a=>q(`[data-side="left"][data-cell="${a}"]`);
 assert.equal(cell('A1').parentElement.style.backgroundColor,'rgb(11, 37, 64)');assert.equal(cell('A1').parentElement.style.color,'rgb(255, 255, 255)');assert.equal(cell('A1').style.backgroundColor,'');
 assert.equal(cell('A2').parentElement.style.backgroundColor,'rgb(0, 0, 0)');assert.equal(cell('B2').parentElement.style.backgroundColor,'rgb(0, 0, 0)');assert.equal(cell('A3').parentElement.style.color,'rgb(0, 0, 0)');
 const widths=[...q('colgroup').children].map(n=>parseFloat(n.style.width));assert.equal(widths[0],48);assert.ok(Math.abs(widths[1]-210)<3);assert.ok(Math.abs(widths[2]-110)<3);assert.ok(Math.abs(widths[3]-390)<3);
 cell('B2').parentElement.click();assert.equal(q('[data-edit-side="left"]').value,'');assert.equal(cell('B2').parentElement.classList.contains('is-selected'),true);
 q('[data-edit-side="left"]').value='New text';q('[data-apply-cell="left"]').click();assert.equal(cell('B2').textContent,'New text');assert.equal(cell('B2').parentElement.style.color,'rgb(255, 255, 255)');
 const doc=await openSheetDocument(src,report.sources.left);doc.restore(view.snapshot().drafts.left);const out=CFB.read(doc.export(),{type:'array'}),original=CFB.read(raw,{type:'array'});assert.deepEqual(new Uint8Array(CFB.find(out,'/xl/styles.xml').content),new Uint8Array(CFB.find(original,'/xl/styles.xml').content));
 q('.visual-inspector [data-sheet-undo]').click();assert.equal(cell('B2').textContent,'');assert.equal(cell('B2').parentElement.style.backgroundColor,'rgb(0, 0, 0)');
 assert.equal(sheetColumnWidth({wpx:Infinity,wch:20}),145);assert.equal(sheetColumnWidth({wpx:-1}),160);assert.equal(sheetColumnWidth({wpx:9000}),800);assert.equal(sheetCellColors({patternType:'none',fgColor:{rgb:'000000'}}),null);assert.equal(sheetCellColors({patternType:'solid',fgColor:{rgb:'FF000000'}}).foreground,'#ffffff');
});
