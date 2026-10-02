import {test} from 'node:test';
import assert from 'node:assert/strict';
import {utils,read,write,CFB} from '../dist/xlsx-vendor.mjs';
import {createSheetCalculator} from '../dist/sheet-formulas.mjs';
import {openSheetDocument} from '../dist/sheet-document.mjs';
import {captureSheetPdf} from '../dist/sheet-pdf-model.mjs';
const source=book=>({name:'formulas.xlsx',data:Buffer.from(write(book,{type:'array',bookType:'xlsx',compression:true})).toString('base64')});
function fixture(){const book=utils.book_new(),sheet=utils.aoa_to_sheet([['ID','Score','Total'],['x',1,{t:'n',v:999,f:'SUMIFS(B2:B6,A2:A6,"x")'}],['x',2],['x',3],['x',4],['x',5]]);utils.book_append_sheet(book,sheet,'Ratings');utils.book_append_sheet(book,utils.aoa_to_sheet([['Summary'],[{t:'n',v:999,f:'IF(COUNTIFS(Ratings!B2:B6,"<>",Ratings!B2:B6,">=0",Ratings!B2:B6,"<=10")=5,Ratings!C2,"Incomplete")'}]]),'Summary');return book;}
test('formula inputs recalculate across sheets, undo and restore; XLSX keeps formulas and current caches',async()=>{
 const src=source(fixture()),meta={format:'xlsx',sheet:'Ratings',headers:[]},doc=await openSheetDocument(src,meta);assert.equal(doc.display('C2'),'15');assert.equal(doc.formulaStatus().pending,0);assert.throws(()=>doc.edit('C2','42','number'),/calculated/);
 const unchanged=read(doc.export(),{type:'array'});assert.equal(unchanged.Sheets.Ratings.C2.v,15);assert.equal(unchanged.Sheets.Summary.A2.v,15);
 doc.edit('B2','6','number');assert.equal(doc.display('C2'),'20');assert.equal(captureSheetPdf(doc).rows[1].cells[2].text,'20');const out=read(doc.export(),{type:'array'});assert.equal(out.Sheets.Ratings.C2.f,'SUMIFS(B2:B6,A2:A6,"x")');assert.equal(out.Sheets.Ratings.C2.v,20);assert.equal(out.Sheets.Summary.A2.v,20);
 const restored=await openSheetDocument(src,meta);restored.restore(doc.snapshot());assert.equal(restored.display('C2'),'20');const saved=restored.snapshot();assert.throws(()=>restored.restore({version:1,patches:[['C2',{t:'n',v:42}]],insertions:[]}),/calculated/);assert.deepEqual(restored.snapshot(),saved);
 doc.undo();assert.equal(doc.display('C2'),'15');doc.edit('B2','11','number');const changed=read(doc.export(),{type:'array'});assert.equal(changed.Sheets.Summary.A2.v,'Incomplete');assert.equal(changed.Sheets.Summary.A2.f,fixture().Sheets.Summary.A2.f);
 const raw=CFB.read(Buffer.from(src.data,'base64'),{type:'array'}),after=CFB.read(doc.export(),{type:'array'});for(const name of raw.FullPaths.filter(n=>/styles.xml|sharedStrings.xml/.test(n)))assert.deepEqual(CFB.find(after,name).content,CFB.find(raw,name).content);
});
test('unknown and circular formulas never masquerade as current PDF totals',async()=>{
 const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Input','Unknown','Dependent'],[1,{t:'n',v:42,f:'UNKNOWN(A2)'},{t:'n',v:43,f:'B2+1'}]]),'Data');const doc=await openSheetDocument(source(book),{format:'xlsx',sheet:'Data',headers:[]});assert.equal(doc.display('B2'),'42');assert.equal(doc.formulaStatus().stored,2);doc.edit('A2','2','number');assert.equal(doc.formulaStatus().pending,2);assert.equal(doc.display('B2'),'Recalculate in Excel');assert.throws(()=>captureSheetPdf(doc),/need Excel/);assert.equal(read(doc.export(),{type:'array'}).Sheets.Data.B2.f,'UNKNOWN(A2)');doc.undo();assert.equal(doc.formulaStatus().pending,0);
 const c={SheetNames:['Data'],Sheets:{Data:{A1:{f:'B1'},B1:{f:'A1'}}}},calc=createSheetCalculator(c,(s,a)=>c.Sheets[s][a]);assert.equal(calc.result('Data','A1').ok,false);
});
test('bounded calculation rejects unsupported coercion and errors in conditional ranges',()=>{
 function run(formula,cells={}){const book={SheetNames:['Data'],Sheets:{Data:{...cells,Z1:{f:formula}}}};return createSheetCalculator(book,(s,a)=>book.Sheets[s][a]).result('Data','Z1');}
 assert.equal(run('SUM("3",TRUE)').ok,false);assert.equal(run('COUNT("3",TRUE)').ok,false);assert.equal(run('SUMIF(A1:A3,"yes",B1)').ok,false);
 assert.equal(run('COUNTIFS(A1:A2,"yes")',{A1:{t:'s',v:'yes'},A2:{t:'e',v:7}}).ok,false);
 assert.deepEqual(run('IF(TRUE,12,UNKNOWN())'),{ok:true,value:12});assert.deepEqual(run('COUNTIFS(A1:A3,"<>a*",B1:B3,">=0")',{A1:{v:'alpha'},A2:{v:'beta'},A3:{v:'gamma'},B1:{v:1},B2:{v:2},B3:{v:3}}),{ok:true,value:2});
 assert.deepEqual(run('COUNTIF(A1,"a~*b")',{A1:{v:'a*b'}}),{ok:true,value:1});const stress=run('COUNTIF(A1,"'+('*a'.repeat(120))+'b")',{A1:{v:'a'.repeat(10000)}});assert.ok(stress.ok===false||stress.value===0);
});

test('formula string caches preserve literal OOXML escapes and restored patches cannot inject formulas',async()=>{
 const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['Input','Result'],['old',{t:'s',v:'old',f:'A2&""'}]]),'Data');const doc=await openSheetDocument(source(book),{format:'xlsx',sheet:'Data',headers:[]});
 doc.edit('A2','_x0041_','text');const out=read(doc.export(),{type:'array'});assert.equal(out.Sheets.Data.A2.v,'_x0041_');assert.equal(out.Sheets.Data.B2.v,'_x0041_');assert.equal(out.Sheets.Data.B2.f,'A2&""');
 doc.restore({version:1,insertions:[],patches:[['A2',{t:'n',v:4,f:'50+50',w:'100'}]]});assert.equal(doc.display('A2'),'4');assert.equal(doc.display('B2'),'4');assert.deepEqual(doc.snapshot().patches,[['A2',{t:'n',v:4}]]);assert.equal(read(doc.export(),{type:'array'}).Sheets.Data.B2.v,'4');
});
