// Execute the actual browser module graph inside the same DOM realm.
// This exercises app wiring; it does not emulate browser layout or CSP enforcement.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function moduleLoader(dom, directory, {failVisualOnce = false} = {}) {
 const context=dom.getInternalVMContext(), modules=new Map(), operations=new Map();
 function get(url) {
  const filename=fileURLToPath(url);
  if (!filename.startsWith(directory+'/')) throw Error('Nonlocal module: '+url);
  if (!modules.has(url)) modules.set(url,new vm.SourceTextModule(readFileSync(filename,'utf8'),{
   context,identifier:url,initializeImportMeta:meta=>{meta.url=url;},
   importModuleDynamically:specifier=>load(new URL(specifier,url).href)
  }));
  return modules.get(url);
 }
 async function load(url) {
  if (failVisualOnce && url.endsWith("/visual-review.mjs")) { failVisualOnce=false; throw Error("Injected module load failure"); }
  if(operations.has(url))return operations.get(url);
  const operation=(async()=>{const module=get(url);if(module.status==='unlinked')await module.link((specifier,ref)=>get(new URL(specifier,ref.identifier).href));if(module.status==='linked')await module.evaluate();return module;})();
  operations.set(url,operation);return operation;
 }
 return script=>new vm.Script(readFileSync(fileURLToPath(script.src),'utf8'),{filename:script.src,importModuleDynamically:specifier=>load(new URL(specifier,script.src).href)}).runInContext(context);
}
