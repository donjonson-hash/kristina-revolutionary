import {openSessionStore} from './session-store.mjs';
import {mountSessionUI} from './session-ui.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validateSinglePayload(payload){
 const invalid=()=>{throw Object.assign(Error('Could not save your document: invalid data.'),{code:'invalid'});};
 if(!object(payload))invalid();
 if(payload.version!==1)throw Object.assign(Error('This document was saved by another version of Compare These Texts.'),{code:'incompatible'});
 const s=payload.source;
 if(payload.kind!=='single-editor'||!object(s)||typeof s.name!=='string'||!s.name.trim()||s.name.length>255||! /\.(docx|pdf|txt|xlsx|csv|tsv)$/i.test(s.name)||typeof s.data!=='string'||s.data.length>4*Math.ceil(2097152/3)||s.data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(s.data)||!object(payload.review)||![',',';','\t'].includes(payload.delimiter))invalid();
 if(s.data.length/4*3-(s.data.endsWith('==')?2:s.data.endsWith('=')?1:0)>2097152)invalid();
 if(/\.xlsx$/i.test(s.name)&&(typeof payload.sheet!=='string'||!payload.sheet||payload.sheet.length>255))invalid();
 if(payload.sheet!==null&&typeof payload.sheet!=='string')invalid();
 if(/\.(docx|pdf|txt)$/i.test(s.name)?payload.review.version!==1:payload.review.kind!=='sheet')invalid();
 const ui=payload.review.singleUi;if(ui!==undefined&&(!object(ui)||typeof ui.value!=='string'||ui.value.length>2*1024*1024))invalid();
 let text;try{text=JSON.stringify(payload);}catch{invalid();}
 if(text.length>32*1024*1024||new TextEncoder().encode(text).length>32*1024*1024)invalid();
 return JSON.parse(text);
}
export const openSingleSessionStore=options=>openSessionStore({...options,dbName:'ctt-single-editor-session',validatePayload:validateSinglePayload});
export const mountSingleSession=(root,options)=>mountSessionUI(root,{...options,single:true,openStore:options.openStore||openSingleSessionStore});
