/** Draw merged cells as one rectangle, paginating connected row groups vertically. */
export async function drawMergedSheet(ctx){
 const {pdf,model,widths,pageWidth,pageHeight,normal,bold,size,lineHeight,pad,margin,wrap,clipped,color,ink,grid,head,layout,pageInfo,abort,yieldWork}=ctx;
 const top=68,bottom=pageHeight-margin-15,available=pageWidth-2*margin;
 const heights=model.rows.map(()=>2),cells=[],xs=[margin];for(const w of widths)xs.push(xs.at(-1)+w);
 for(let r=0;r<model.rows.length;r++)for(let c=0;c<widths.length;c++){
  const cell=model.rows[r].cells[c];if(cell.covered)continue;
  const rowSpan=cell.rowSpan||1,colSpan=cell.colSpan||1,font=r===model.header?bold:normal,width=xs[c+colSpan]-xs[c],lines=wrap(cell.text,font,width-2*pad);
  cells.push({cell,r,c,rowSpan,colSpan,font,width,lines});if(rowSpan===1)heights[r]=Math.max(heights[r],lines.length+1);
 }
 for(const cell of cells.filter(c=>c.rowSpan>1)){
  const current=heights.slice(cell.r,cell.r+cell.rowSpan).reduce((a,b)=>a+b,0),extra=cell.lines.length+1-current;
  if(extra>0)heights[cell.r+cell.rowSpan-1]+=extra;
 }
 const offsets=[0];for(const h of heights)offsets.push(offsets.at(-1)+h);
 const byRow=model.rows.map(()=>[]);for(const cell of cells)byRow[cell.r].push(cell);
 const groups=[];for(let r=0;r<heights.length;){let end=r;const groupCells=[];for(let i=r;i<=end;i++)for(const cell of byRow[i]){end=Math.max(end,i+cell.rowSpan-1);groupCells.push(cell);}groups.push({start:offsets[r],end:offsets[end+1],cells:groupCells});r=end+1;}
 const first=groups[0],repeat=first.cells.some(c=>c.r===model.header)&&first.end*lineHeight<=180?first:null;
 let page,y;
 function draw(group,start,count,repeated=false){
  const end=start+count;
  for(const entry of group.cells){
   const {cell,r,c,rowSpan,font,width,lines}=entry,cellStart=offsets[r],cellEnd=offsets[r+rowSpan],from=Math.max(start,cellStart),to=Math.min(end,cellEnd);if(to<=from)continue;
   const x=xs[c],cy=y+(from-start)*lineHeight,height=(to-from)*lineHeight,isHeader=r===model.header;
   page.drawRectangle({x,y:pageHeight-cy-height,width,height,borderWidth:.45,borderColor:grid,color:cell.fill?color(cell.fill):isHeader?head:color('#ffffff')});
   const visible=[];
   for(let l=0;l<lines.length;l++){const slot=cellStart+l;if(slot<start||slot>=end)continue;const text=lines[l],tw=font.widthOfTextAtSize(text,size),tx=x+(cell.align==='right'?width-pad-tw:pad);if(text)font.drawText(page,text,{x:tx,y:pageHeight-y-(slot-start)*lineHeight-(lineHeight-pad/2),size,color:cell.foreground?color(cell.foreground):ink});visible.push(text);}
   layout.push({page:pdf.getPageCount(),part:1,row:model.rows[r].number,column:model.columns[c],header:isHeader,repeated,continued:from>cellStart,x,y:cy,width,height,fontSize:size,pageWidth,pageHeight,padding:pad,rowSpan,colSpan:entry.colSpan,lineWidths:visible.map(text=>font.widthOfTextAtSize(text,size)),lines:visible});
  }
  y+=count*lineHeight;
 }
 function newPage(withHeader){abort();if(pdf.getPageCount()>=500)throw Error('This table would exceed 500 PDF pages. Select a smaller sheet.');page=pdf.addPage([pageWidth,pageHeight]);pageInfo.push({page,part:0});y=top;
  bold.drawText(page,clipped(model.name,bold,available),{x:margin,y:pageHeight-margin-11,size:11,color:ink});normal.drawText(page,clipped(model.sheet+' · Columns '+model.columns[0]+'–'+model.columns.at(-1),normal,available),{x:margin,y:pageHeight-margin-27,size:9,color:ink});
  if(withHeader&&repeat)draw(repeat,repeat.start,repeat.end-repeat.start,true);
 }
 newPage(false);
 for(const group of groups){
  let start=group.start;const headerSlots=repeat?repeat.end-repeat.start:0,fullCapacity=Math.floor((bottom-top)/lineHeight)-headerSlots,length=group.end-group.start;
  if(length<=fullCapacity&&length>Math.floor((bottom-y)/lineHeight))newPage(true);
  while(start<group.end){const count=Math.min(group.end-start,Math.floor((bottom-y)/lineHeight));if(count<=0){newPage(true);continue;}draw(group,start,count);start+=count;await yieldWork();if(start<group.end)newPage(group!==repeat);}
 }
}
