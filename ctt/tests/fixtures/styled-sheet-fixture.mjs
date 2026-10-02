import {utils,write,CFB} from '../../dist/xlsx-vendor.mjs';
export function styledSheetFixture(){
 const book=utils.book_new(),sheet=utils.aoa_to_sheet([
  ['Product name','Short','Long description that should wrap inside its original wide column without breaking the table or losing the continuous background.'],
  ['Black background','', 'Another detailed explanation on a black background. The full cell should remain readable and clickable even when the adjacent value is short.'],
  ['Light background','10','Editable value']
 ]);sheet['!cols']=[{wpx:210},{wpx:110},{wpx:390}];utils.book_append_sheet(book,sheet,'Styled');
 const archive=CFB.read(new Uint8Array(write(book,{type:'array',bookType:'xlsx'})),{type:'array'}),encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
 const styles='<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B2540"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFEE99"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/></cellXfs></styleSheet>';
 CFB.utils.cfb_add(archive,'/xl/styles.xml',encode(styles));
 const part='/xl/worksheets/sheet1.xml';let xml=decode(CFB.find(archive,part).content);xml=xml.replace(/<c r="([A-Z]+)([1-3])"[^>]*>/g,(tag,col,row)=>tag.replace(/ s="\d+"/,'').replace('>',` s="${row}">`));CFB.utils.cfb_add(archive,part,encode(xml));
 return new Uint8Array(CFB.write(archive,{type:'array',fileType:'zip',compression:true}));
}
