/** Use one measurement/drawing path for ordinary text and bundled emoji glyphs. */
export function sheetPdfFont(primary,fallback){
 const sets=new Map([primary,fallback].map(f=>[f,new Set(f.getCharacterSet())]));
 const segmenter=new Intl.Segmenter('en',{granularity:'grapheme'}),cache=new Map();
 const visible=char=>!/[\p{Default_Ignorable_Code_Point}]/u.test(char);
 const supports=(font,text)=>Array.from(text).every(char=>!visible(char)||sets.get(font).has(char.codePointAt(0)));
 function runs(text){
  if(cache.has(text))return cache.get(text);const result=[];
  for(const {segment}of segmenter.segment(text)){
   const emojiSequence=/\p{Extended_Pictographic}/u.test(segment)&&/[\u200d\ufe0f]/u.test(segment);
   const font=emojiSequence&&supports(fallback,segment)?fallback:supports(primary,segment)?primary:supports(fallback,segment)?fallback:null;
   if(!font)throw Error('A character in this table cannot be displayed in PDF. Download the spreadsheet to preserve it.');
   if(result.at(-1)?.font===font)result.at(-1).text+=segment;else result.push({font,text:segment});
  }
  if(cache.size<5000)cache.set(text,result);return result;
 }
 return {
  check:text=>{for(const line of text.split('\n'))runs(line);},
  graphemes:text=>Array.from(segmenter.segment(text),entry=>entry.segment),
  widthOfTextAtSize:(text,size)=>runs(text).reduce((width,run)=>width+run.font.widthOfTextAtSize(run.text,size),0),
  drawText(page,text,options){let x=options.x;for(const run of runs(text)){page.drawText(run.text,{...options,x,font:run.font});x+=run.font.widthOfTextAtSize(run.text,options.size);}}
 };
}
