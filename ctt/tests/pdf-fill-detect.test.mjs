import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from '../dist/pdf-vendor.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {detectPdfFillAreas,fitPdfFillText} from '../dist/pdf-fill-detect.mjs';
import {renderFilledPdf} from '../dist/pdf-fill.mjs';
const source=async doc=>({data:Buffer.from(await doc.save()).toString('base64')});
test('blank suggestions avoid labels, existing underlined text and decorative boxes',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([400,500]);
  p.drawText('Name:',{x:40,y:400,size:12});
  p.drawLine({start:{x:40,y:397},end:{x:330,y:397},thickness:.5});
  p.drawText('Already completed',{x:40,y:340,size:12});
  p.drawLine({start:{x:40,y:337},end:{x:145,y:337},thickness:.5});
  p.drawText('____________________',{x:40,y:280,size:12});
  p.drawRectangle({x:20,y:20,width:360,height:450,borderWidth:1});
  const detected=await detectPdfFillAreas(await source(doc));
  assert.equal(detected.areas.length,2);
  const name=detected.areas[0];assert.ok(name.x>74&&name.x<90);assert.ok(name.y+name.height<103);
  assert.ok(detected.areas[1].y>200);
});
test('rotation and cropping use displayed page coordinates',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([400,600]);p.setCropBox(10,20,370,550);p.setRotation({type:'degrees',angle:90});
  p.drawLine({start:{x:120,y:100},end:{x:120,y:350},thickness:.5});
  const result=await detectPdfFillAreas(await source(doc));assert.equal(result.width,550);assert.equal(result.height,370);
  assert.equal(result.areas.length,1);const area=result.areas[0];assert.ok(Math.abs(area.x-82)<.1);assert.ok(Math.abs(area.lineY-110)<.1);
});
test('auto fit keeps long Cyrillic on its blank, exported text fits and impossible text is rejected',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([400,500]);p.drawText('Form',{x:40,y:450,size:12});p.drawLine({start:{x:40,y:400},end:{x:205,y:400},thickness:.5});
  const src=await source(doc),{areas}=await detectPdfFillAreas(src);
  const fitted=await fitPdfFillText({...areas[0],text:'Александр Александрович'});assert.ok(fitted.fontSize<12&&fitted.fontSize>=8);assert.ok(Math.abs(fitted.y+fitted.height+1-fitted.lineY)<.001);
  const restored=await fitPdfFillText({...fitted,text:'Иван',fontSize:12});assert.equal(restored.fontSize,12);assert.ok(Math.abs(restored.y+restored.height+1-restored.lineY)<.001);
  const bytes=await renderFilledPdf(src,[fitted]),task=getDocument({data:bytes,verbosity:0});
  try{const r=await task.promise,page=await r.getPage(1),{items}=await page.getTextContent();const text=items.find(i=>i.str.includes('Александр'));assert.ok(text.width<=fitted.width+.01);assert.equal(items.filter(i=>i.str.trim()&&i.str!=='Form').length,1);}finally{await task.destroy();}
  await assert.rejects(fitPdfFillText({...areas[0],text:'Александр '.repeat(50)}),/needs more room/);
  await assert.rejects(fitPdfFillText({...areas[0],text:'bad\0text'}),/control/);
  const controller=new AbortController();controller.abort();await assert.rejects(detectPdfFillAreas(src,{signal:controller.signal}),{name:'AbortError'});
});

test('tight stacked blanks keep every glyph box below the preceding rule',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([400,500]);
  for(const y of [400,386,372])p.drawLine({start:{x:40,y},end:{x:260,y},thickness:.5});
  const {areas}=await detectPdfFillAreas(await source(doc));assert.equal(areas.length,3);
  for(let i=1;i<areas.length;i++){const a=areas[i];assert.ok(a.y>=areas[i-1].lineY+2);assert.ok(a.fontSize<12);
    const fitted=await fitPdfFillText({...a,text:'Long name',fontSize:12});assert.ok(fitted.y>=areas[i-1].lineY+2-.001);assert.ok(fitted.y+fitted.height<a.lineY);}
});

test('mixed proportional date labels expose short day, month and year blanks at their glyph positions',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([450,500]);
  const f=await doc.embedFont('Helvetica'),size=12,prefix='Birth date: ',day='__',middle=' ',month='________',yearPrefix=' 20',year='__';
  p.drawText(prefix+day+middle+month+yearPrefix+year,{x:40,y:400,size,font:f});
  const src=await source(doc),{areas}=await detectPdfFillAreas(src);assert.equal(areas.length,3);
  const prefixes=[prefix,prefix+day+middle,prefix+day+middle+month+yearPrefix];
  const blanks=[day,month,year];
  for(let i=0;i<3;i++){
    const start=40+[...prefixes[i]].reduce((sum,c)=>sum+f.widthOfTextAtSize(c,size),0),end=start+f.widthOfTextAtSize(blanks[i],size);
    assert.ok(areas[i].x>=start&&areas[i].x<start+2.1);
    assert.ok(areas[i].x+areas[i].width<=end+.01&&areas[i].x+areas[i].width>end-2.1);
  }
  const fields=await Promise.all(areas.map((a,i)=>fitPdfFillText({...a,text:['15','October','16'][i]})));
  const bytes=await renderFilledPdf(src,fields),task=getDocument({data:bytes,verbosity:0});
  try{const r=await task.promise,s=await r.getPage(1),{items}=await s.getTextContent();
    assert.ok(items.some(i=>i.str.includes('Birth date:')));assert.ok(items.some(i=>i.str==='October'));
    for(const [i,value] of ['15','October','16'].entries()){
      const item=items.find(t=>t.str===value);assert.ok(item);assert.ok(item.width<=fields[i].width+.01);
    }
  }finally{await task.destroy();}
});

test('labels above address and issuer blanks reduce font height without truncating the line',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([450,500]);
  p.drawText('Residential address:',{x:40,y:420,size:11});
  for(const y of [403,389])p.drawLine({start:{x:40,y},end:{x:390,y},thickness:.5});
  p.drawText('Issued by and when:',{x:220,y:330,size:11});
  for(const y of [327,313])p.drawLine({start:{x:220,y},end:{x:430,y},thickness:.5});
  const src=await source(doc),{areas}=await detectPdfFillAreas(src);assert.equal(areas.length,4);
  assert.equal(areas[0].x,42);assert.equal(areas[0].width,346);assert.ok(areas[0].fontSize<11);
  assert.equal(areas[1].x,42);assert.equal(areas[1].width,346);
  assert.ok(areas[2].x>310);assert.equal(areas[3].x,222);assert.equal(areas[3].width,206);
  for(const a of areas){const fit=await fitPdfFillText({...a,text:'Example'});assert.ok(fit.fontSize>=8);assert.ok(fit.y>=a.fitAreaY-.001);}
});


test('compact 13.2 point rule spacing still provides readable 8 point fields',async()=>{
  const doc=await PDFDocument.create(),p=doc.addPage([400,500]);
  for(const y of [400,386.8,373.6])p.drawLine({start:{x:40,y},end:{x:260,y},thickness:.5});
  const {areas}=await detectPdfFillAreas(await source(doc));assert.equal(areas.length,3);
  for(let i=1;i<areas.length;i++){const a=areas[i];assert.ok(a.y>=areas[i-1].lineY+1-.001);assert.ok(a.fontSize>=8);}
});
