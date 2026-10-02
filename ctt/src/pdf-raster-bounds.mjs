/** Align an invisible text layer with ink in a flattened page, without OCR.
 * Only uniform-background lines with clear gutters and no competing text qualify.
 */
export function refineRasterBounds(canvas, blocks, width, height, images, scale = canvas.width / width) {
  const ctx=canvas.getContext('2d'),pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const color=(x,y)=>{const at=(Math.max(0,Math.min(canvas.height-1,Math.floor(y*scale)))*canvas.width+Math.max(0,Math.min(canvas.width-1,Math.floor(x*scale))))*4;return [pixels[at],pixels[at+1],pixels[at+2]];};
  const distance=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
  const all=blocks.flatMap(b=>b.visual.rects.map(r=>({...r,record:b.record})));
  return blocks.map(block=>{
    if(block.visual.rasterBoundsVersion===2)return block;
    const rs=block.visual.rects;
    if(!rs.length||rs.some(r=>Math.abs(r.angle)>1))return block;
    const x=Math.min(...rs.map(r=>r.x)),y=Math.min(...rs.map(r=>r.y)),right=Math.max(...rs.map(r=>r.x+r.width)),bottom=Math.max(...rs.map(r=>r.y+r.height));
    if(!images.some(i=>i.x<=x+1&&i.y<=y+1&&i.x+i.width>=right-1&&i.y+i.height>=bottom-1))return block;
    const uncertain=()=>({...block,visual:{...block.visual,rasterBoundsVersion:2,rasterBoundsUncertain:true}});
    const em=Math.min(...rs.map(r=>r.fontSize));if(!(em>0)||bottom-y>em*1.8)return uncertain();
    const neighbors=all.filter(r=>r.record!==block.record&&Math.min(bottom,r.y+r.height)-Math.max(y,r.y)>Math.min(bottom-y,r.height)*.35);
    if(neighbors.some(r=>r.x<right&&r.x+r.width>x))return uncertain();
    let lo=Math.max(0,x-em*6),hi=Math.min(width,right+em*6);
    for(const r of neighbors){if(r.x+r.width<=x)lo=Math.max(lo,r.x+r.width+1);if(r.x>=right)hi=Math.min(hi,r.x-1);}
    const top=Math.max(0,y-1),base=Math.min(height-.5,bottom+1),samples=[color(x,top),color(right,top),color(x,base),color(right,base)];
    const background=samples.find(c=>samples.filter(s=>distance(c,s)<25).length>=3);if(!background)return uncertain();
    const borderClear=px=>distance(color(px,top),background)<35&&distance(color(px,base),background)<35;
    const middle=(x+right)/2;if(!borderClear(middle))return uncertain();
    // Stop at a colour boundary (for example the edge of a heading banner).
    for(let px=middle;px>=lo;px-=1/scale)if(!borderClear(px)){lo=px+1/scale;break;}
    for(let px=middle;px<=hi;px+=1/scale)if(!borderClear(px)){hi=px-1/scale;break;}
    if(lo>x+1||hi<right-1)return uncertain();
    const runs=[];let run;
    for(let ix=Math.ceil(lo*scale);ix<Math.floor(hi*scale);ix++){
      let inkTop=Infinity,inkBottom=-Infinity;
      for(let iy=Math.floor(y*scale);iy<Math.ceil(bottom*scale);iy++)if(distance(color(ix/scale,iy/scale),background)>55){inkTop=Math.min(inkTop,iy/scale);inkBottom=(iy+1)/scale;}
      if(Number.isFinite(inkTop)){if(!run){run={left:ix/scale,right:(ix+1)/scale,top:inkTop,bottom:inkBottom};runs.push(run);}else {run.right=(ix+1)/scale;run.top=Math.min(run.top,inkTop);run.bottom=Math.max(run.bottom,inkBottom);}}else run=null;
    }
    const seeds=runs.map((r,i)=>r.right>x&&r.left<right?i:-1).filter(i=>i>=0);if(!seeds.length)return uncertain();
    let first=seeds[0],last=seeds.at(-1);const gap=em*1.15;
    while(first>0&&runs[first].left-runs[first-1].right<gap)first--;
    while(last+1<runs.length&&runs[last+1].left-runs[last].right<gap)last++;
    // Recognize only repeated compact raster list markers beside known neighboring rows.
    // A wide suffix, a line, or an isolated speck remains ambiguous.
    const neighborMarkers=run=>{
      const bands=[];let band;
      for(let iy=Math.floor(run.top*scale);iy<Math.ceil(run.bottom*scale);iy++){
        let left=Infinity,right=-Infinity;
        for(let ix=Math.floor(run.left*scale);ix<Math.ceil(run.right*scale);ix++)if(distance(color(ix/scale,iy/scale),background)>55){left=Math.min(left,ix/scale);right=(ix+1)/scale;}
        if(Number.isFinite(left)){if(!band){band={left,right,top:iy/scale,bottom:(iy+1)/scale};bands.push(band);}else{band.left=Math.min(band.left,left);band.right=Math.max(band.right,right);band.bottom=(iy+1)/scale;}}else band=null;
      }
      if(bands.length<2)return false;
      const used=new Set();
      return bands.every(dot=>{
        const w=dot.right-dot.left,h=dot.bottom-dot.top;
        const row=neighbors.find(row=>!used.has(row.record)&&dot.left>=row.x-row.fontSize*1.5&&dot.right<=row.x-1&&dot.top>=row.y&&dot.bottom<=row.y+row.height&&w>=row.fontSize*.15&&w<=row.fontSize*.6&&h>=row.fontSize*.15&&h<=row.fontSize*.6&&w/h>=.5&&w/h<=2);
        if(!row)return false;used.add(row.record);return true;
      });
    };
    const outside=runs.filter((run,index)=>index<first||index>last);
    if(!outside.every(neighborMarkers))return uncertain();
    for(let i=0;i<first;i++)lo=Math.max(lo,runs[i].right+1);
    for(let i=last+1;i<runs.length;i++)hi=Math.min(hi,runs[i].left-1);
    const extensions=runs.slice(first,last+1).filter(r=>r.left<x||r.right>right);
    if(extensions.some(r=>r.right-r.left>em*1.5||r.bottom-r.top<em*.2||r.bottom-r.top>em*1.4))return uncertain();
    const inkLeft=runs[first].left,inkRight=runs[last].right;
    // A clear gutter must terminate the line. Do not crop an uncertain continuation.
    if(inkLeft-lo<Math.max(1.5,em*.35)||hi-inkRight<Math.max(1.5,em*.35))return uncertain();
    const left=Math.max(0,Math.min(x,inkLeft-.75)),end=Math.min(width,Math.max(right,inkRight+.75));
    return {...block,visual:{...block.visual,rasterBoundsVersion:2,rasterBoundsUncertain:false,rects:[{...rs[0],x:left,y,width:end-left,height:bottom-y,fontSize:em}]}};
  });
}
