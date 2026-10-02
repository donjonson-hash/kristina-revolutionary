import {utils} from './xlsx-vendor.mjs';
const unsupported=()=>{throw Error('Formula needs Excel.');};
class CellError extends Error{}
const numeric=v=>{if(v===null||v==='')return 0;if(typeof v==='number')return v;if(typeof v==='boolean')return +v;if(typeof v==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))return Number(v);throw new CellError('#VALUE!');};
function parseFormula(text){
 if(text.length>12000)unsupported();const tokens=[];let p=0;
 while(p<text.length){const s=text.slice(p);let m;if(/^\s/.test(s)){p++;continue;}
  if((m=/^"((?:[^"]|"")*)"/.exec(s)))tokens.push({type:'value',value:m[1].replaceAll('""','"')});
  else if((m=/^(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Z]{1,3}\$?[1-9]\d*))?(?![\p{L}\p{N}_])/iu.exec(s)))tokens.push({type:'ref',sheet:(m[1]?.replaceAll("''","'")||m[2]),start:m[3].replaceAll('$','').toUpperCase(),end:(m[4]||m[3]).replaceAll('$','').toUpperCase()});
  else if((m=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(s)))tokens.push({type:'value',value:Number(m[0])});
  else if((m=/^[A-Z_][A-Z_\d.]*/i.exec(s)))tokens.push({type:'name',value:m[0].toUpperCase()});
  else if((m=/^(?:<=|>=|<>|[+\-*/^&%=<>():,])/.exec(s)))tokens.push({type:m[0]});else unsupported();p+=m[0].length;if(tokens.length>4000)unsupported();
 }
 let at=0,depth=0;const peek=()=>tokens[at]?.type,take=t=>{if(peek()!==t)unsupported();return tokens[at++];};
 const precedence={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'&':2,'+':3,'-':3,'*':4,'/':4,'^':5};
 function expression(min=0){if(++depth>64)unsupported();let node,t=tokens[at++];if(!t)unsupported();
  if(t.type==='value'||t.type==='ref')node=t;
  else if(t.type==='+'||t.type==='-')node={type:'unary',op:t.type,value:expression(6)};
  else if(t.type==='('){node=expression();take(')');}
  else if(t.type==='name'){
   if(['TRUE','FALSE'].includes(t.value)&&peek()!=='(')node={type:'value',value:t.value==='TRUE'};
   else{take('(');const args=[];if(peek()!==')'){do{if(args.length)take(',');args.push(expression());}while(peek()===',');}take(')');node={type:'call',name:t.value,args};}
  }else unsupported();
  while(peek()==='%'){at++;node={type:'binary',op:'/',left:node,right:{type:'value',value:100}};}
  while(precedence[peek()]!==undefined&&precedence[peek()]>=min){const op=tokens[at++].type;node={type:'binary',op,left:node,right:expression(precedence[op]+1)};}
  depth--;return node;
 }
 const result=expression();if(at!==tokens.length)unsupported();return result;
}
const scalar=v=>{if(v&&typeof v==='object')unsupported();return v;};
const compare=(a,b)=>{a=scalar(a);b=scalar(b);if(a===null)a=typeof b==='string'?'':0;if(b===null)b=typeof a==='string'?'':0;if(typeof a==='string'&&typeof b==='string'){a=a.toLocaleLowerCase('en-US');b=b.toLocaleLowerCase('en-US');}if(typeof a!==typeof b)return typeof a==='number'?-1:typeof b==='number'?1:typeof a==='string'?-1:1;return a===b?0:a<b?-1:1;};
const condition=(order,op)=>({'=':order===0,'<>':order!==0,'<':order<0,'>':order>0,'<=':order<=0,'>=':order>=0})[op];
function criterion(spec,tick){
 if(typeof spec!=='string')return value=>compare(value,spec)===0;
 const match=/^(<=|>=|<>|=|<|>)(.*)$/s.exec(spec),op=match?.[1]||'=',text=match?.[2]??spec;
 if(text==='')return value=>op==='='?value===null||value==='':op==='<>'?value!==null&&value!=='':condition(compare(value,''),op);
 if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))return value=>{try{return condition(numeric(value)-Number(text),op);}catch{return op==='<>';}};
 if((op==='='||op==='<>')&&/[*?~]/.test(text)){
  const pattern=[];for(let i=0;i<text.length;i++){const char=text[i];if(char==='~'&&i+1<text.length)pattern.push({literal:text[++i].toLocaleLowerCase('en-US')});else pattern.push(char==='*'||char==='?'?{wild:char}:{literal:char.toLocaleLowerCase('en-US')});}
  return value=>{if(typeof value!=='string')return op==='<>';const chars=Array.from(value.toLocaleLowerCase('en-US'));let p=0,v=0,star=-1,retry=0;
   while(v<chars.length){tick();if(pattern[p]?.wild==='?'||pattern[p]?.literal===chars[v]){p++;v++;}else if(pattern[p]?.wild==='*'){star=p++;retry=v;}else if(star>=0){p=star+1;v=++retry;}else return op==='<>';}
   while(pattern[p]?.wild==='*'){tick();p++;}const matched=p===pattern.length;return op==='='?matched:!matched;
  };
 }
 return value=>condition(compare(value,text),op);
}
/** Bounded, local calculation of a deliberately small Excel formula subset. No eval, network or macros. */
export function createSheetCalculator(book,readCell){
 const names=new Map(book.SheetNames.map(name=>[name.toLocaleLowerCase('en-US'),name])),memo=new Map(),active=new Set(),asts=new Map();let work=0;
 const tick=()=>{if(++work>1000000)unsupported();};
 function value(sheet,addr){tick();const key=sheet+'!'+addr;if(memo.has(key)){const result=memo.get(key);if(result instanceof Error)throw result;return result;}const cell=readCell(sheet,addr)||{};
  if(cell.F!==undefined)unsupported();if(cell.f===undefined){if(cell.t==='e')throw new CellError(utils.format_cell(cell));return cell.v??null;}
  if(active.has(key))unsupported();if(active.size>64)unsupported();active.add(key);
  try{let ast=asts.get(cell.f);if(!ast){ast=parseFormula(cell.f);asts.set(cell.f,ast);}const result=scalar(evaluate(ast,sheet));if(typeof result==='number'&&!Number.isFinite(result))throw new CellError('#NUM!');memo.set(key,result);return result;}catch(e){memo.set(key,e);throw e;}finally{active.delete(key);}
 }
 function range(node,sheet){const name=node.sheet?names.get(node.sheet.toLocaleLowerCase('en-US')):sheet;if(!name)throw new CellError('#REF!');const s=utils.decode_cell(node.start),e=utils.decode_cell(node.end),rows=e.r-s.r+1,cols=e.c-s.c+1;if(rows<1||cols<1||e.r>1048575||e.c>16383||rows*cols>100000)unsupported();if(rows*cols===1)return value(name,node.start);const values=[];for(let r=s.r;r<=e.r;r++)for(let c=s.c;c<=e.c;c++)values.push(value(name,utils.encode_cell({r,c})));return {values,rows,cols};}
 const asRange=v=>v&&typeof v==='object'?v:{values:[v],rows:1,cols:1};
 function evaluate(node,sheet){tick();if(node.type==='value')return node.value;if(node.type==='ref')return range(node,sheet);
  if(node.type==='unary')return numeric(scalar(evaluate(node.value,sheet)))*(node.op==='-'?-1:1);
  if(node.type==='binary'){const a=scalar(evaluate(node.left,sheet)),b=scalar(evaluate(node.right,sheet));if(['=','<>','<','>','<=','>='].includes(node.op))return condition(compare(a,b),node.op);if(node.op==='&')return String(a??'')+String(b??'');const x=numeric(a),y=numeric(b);if(node.op==='/'&&y===0)throw new CellError('#DIV/0!');return {'+':()=>x+y,'-':()=>x-y,'*':()=>x*y,'/':()=>x/y,'^':()=>x**y}[node.op]();}
  const {name,args}=node;
  if(name==='IF'){if(args.length<2||args.length>3)unsupported();const test=scalar(evaluate(args[0],sheet));if(typeof test==='string')unsupported();return test?evaluate(args[1],sheet):args[2]?evaluate(args[2],sheet):false;}
  if(name==='IFERROR'){if(args.length!==2)unsupported();try{return evaluate(args[0],sheet);}catch(e){if(!(e instanceof CellError))throw e;return evaluate(args[1],sheet);}}
  if(['SUMIFS','COUNTIFS','SUMIF','COUNTIF'].includes(name)){
   const safe=node=>{try{return evaluate(node,sheet);}catch(e){if(e instanceof CellError)unsupported();throw e;}};
   let sumRange,pairs;
   if(name==='SUMIFS'){if(args.length<3||args.length%2!==1)unsupported();sumRange=asRange(safe(args[0]));pairs=args.slice(1);}
   else if(name==='COUNTIFS'){if(!args.length||args.length%2)unsupported();pairs=args;}
   else{if(args.length<2||args.length>(name==='SUMIF'?3:2))unsupported();pairs=args.slice(0,2);if(name==='SUMIF')sumRange=asRange(safe(args[2]||args[0]));}
   const checks=[];for(let i=0;i<pairs.length;i+=2)checks.push({range:asRange(safe(pairs[i])),test:criterion(scalar(safe(pairs[i+1])),tick)});
   const shape=sumRange||checks[0].range;if(checks.some(c=>c.range.rows!==shape.rows||c.range.cols!==shape.cols)){if(name==='SUMIF')unsupported();throw new CellError('#VALUE!');}let total=0;
   for(let i=0;i<shape.values.length;i++){tick();if(checks.every(c=>c.test(c.range.values[i])))total+=sumRange?(typeof sumRange.values[i]==='number'?sumRange.values[i]:0):1;}return total;
  }
  if(['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA'].includes(name)){const values=args.flatMap(arg=>{let v;try{v=evaluate(arg,sheet);}catch(e){if((name==='COUNT'||name==='COUNTA')&&e instanceof CellError)unsupported();throw e;}if(arg.type!=='ref'&&typeof v!=='number'&&name!=='COUNTA')unsupported();return asRange(v).values;}),numbers=values.filter(v=>typeof v==='number');if(name==='COUNT')return numbers.length;if(name==='COUNTA')return values.filter(v=>v!==null).length;if(name==='AVERAGE'&&!numbers.length)throw new CellError('#DIV/0!');if(name==='MIN')return numbers.length?Math.min(...numbers):0;if(name==='MAX')return numbers.length?Math.max(...numbers):0;const sum=numbers.reduce((a,b)=>a+b,0);return name==='AVERAGE'?sum/numbers.length:sum;}
  if(name==='ROUND'){if(args.length!==2)unsupported();const n=numeric(scalar(evaluate(args[0],sheet))),digits=numeric(scalar(evaluate(args[1],sheet)));if(!Number.isInteger(digits)||Math.abs(digits)>15)unsupported();const factor=10**digits;return Math.sign(n)*Math.round(Math.abs(n)*factor)/factor;}
  unsupported();
 }
 return {result(sheet,addr){try{return {ok:true,value:value(sheet,addr)};}catch(e){return e instanceof CellError?{ok:true,value:e.message,error:true}:{ok:false};}}};
}
