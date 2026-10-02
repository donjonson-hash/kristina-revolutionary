import {utils} from './xlsx-vendor.mjs';
/** Validate and index visible Excel merge ranges without changing source cells. */
export function sheetMerges(grid){
 const ranges=grid['!merges']||[],cells=new Map(),bounds=utils.decode_range(grid['!ref']||'A1');
 if(ranges.length>10000)throw Error('This sheet has too many merged areas.');
 for(const range of ranges){
  const {s,e}=range;
  if(!s||!e||![s.r,s.c,e.r,e.c].every(Number.isInteger)||s.r<0||s.c<0||e.r<s.r||e.c<s.c||e.r>1048575||e.c>16383)throw Error('This sheet has an invalid merged area.');
  bounds.s.r=Math.min(bounds.s.r,s.r);bounds.s.c=Math.min(bounds.s.c,s.c);bounds.e.r=Math.max(bounds.e.r,e.r);bounds.e.c=Math.max(bounds.e.c,e.c);
  if((e.r-s.r+1)*(e.c-s.c+1)+cells.size>200000)throw Error('This sheet has merged areas that are too large.');
  for(let r=s.r;r<=e.r;r++)for(let c=s.c;c<=e.c;c++){const addr=utils.encode_cell({r,c});if(cells.has(addr))throw Error('This sheet has overlapping merged areas.');cells.set(addr,range);}
 }
 return {ranges,cells,bounds};
}
