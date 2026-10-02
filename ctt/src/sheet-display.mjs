/** View-only formatting: never written back into a workbook. */
export function sheetColumnWidth(column) {
 const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
 const width=positive(column?.wpx)?column.wpx:positive(column?.wch)?column.wch*7+5:positive(column?.width)?column.width*7:160;
 return Math.round(Math.max(40,Math.min(800,width)));
}
export function sheetCellColors(style) {
 // Only solid fills have a single background. Ignore automatic/indexed colors
 // unless the workbook reader has already resolved them to an RGB value.
 if(style?.patternType!=='solid')return null;
 let rgb=style.fgColor?.rgb;
 if(typeof rgb!=='string'||!/^([a-f\d]{6}|[a-f\d]{8})$/i.test(rgb))return null;
 rgb=rgb.slice(-6);
 const channels=[0,2,4].map(i=>parseInt(rgb.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
 const luminance=channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
 return {background:'#'+rgb,foreground:(luminance+0.05)/0.05>=1.05/(luminance+0.05)?'#000000':'#ffffff'};
}
