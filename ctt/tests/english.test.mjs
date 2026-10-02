// DOM integration of the packaged UI, transport and real worker algorithm.
// worker_threads adapts WebWorker events; this is not a visual/browser-engine test.
// Run: node --test tests/extension/integration.test.mjs
import {test, before, after} from 'node:test';
import {webcrypto} from 'node:crypto';
import {moduleLoader} from './module-loader.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker as NodeWorker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
const require = createRequire(new URL('../package.json', import.meta.url));
const {JSDOM,requestInterceptor,VirtualConsole} = require('jsdom');
async function until(condition, details = () => '') {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return;
    await delay(25);
  }
  assert.fail('Timed out waiting for UI state: ' + details());
}
async function page(t, target, browserCompatibility = false, realModules = false) {
  const directory = target === 'web' ? fileURLToPath(new URL('../dist/', import.meta.url)).replace(/\/$/, '') : target;
  const errors = [], network = [], workers = [], requests = [], downloads = [], clipboard = [], navigations = [];
  const localResources = {interceptors: [requestInterceptor(request => {
      const parsed = new URL(request.url);
      if (parsed.protocol === 'file:' && ['/site.css','/favicon.svg'].includes(parsed.pathname)) return new Response(readFileSync(path.join(directory,parsed.pathname.slice(1))), {headers:{'Content-Type':'text/css'}});
      if (parsed.protocol !== 'file:' || !fileURLToPath(parsed).startsWith(directory + path.sep)) {
        network.push(request.url);
        return new Response('', {status: 403});
      }
      return undefined;
  })]};
  class WebWorker {
    constructor(url, options) {
      assert.equal(options.type, 'module');
      assert.equal(fileURLToPath(url), path.join(directory, 'worker.mjs'));
      this.terminated = false;
      // Use the packaged worker's actual message handler. Only the browser
      // platform event bridge is adapted; no algorithm or API is substituted.
      this.worker = new NodeWorker(`
        const {parentPort, workerData} = require('node:worker_threads');
        globalThis.fetch = (...args) => { parentPort.postMessage({networkAttempt: String(args[0])}); throw Error('Network forbidden'); };
        globalThis.WebSocket = class { constructor(url) { parentPort.postMessage({networkAttempt: String(url)}); throw Error('Network forbidden'); } };
        globalThis.self = {postMessage: (data, transfer) => parentPort.postMessage(data, transfer)};
        ${browserCompatibility ? `
          globalThis.process = undefined;
          delete Promise.try; delete Promise.withResolvers;
          delete Map.prototype.getOrInsert; delete Map.prototype.getOrInsertComputed;
          delete Uint8Array.prototype.toHex;
          globalThis.Worker = class { constructor() { throw Error('Nested Worker forbidden'); } };
          globalThis.XMLHttpRequest = class { constructor() { throw Error('XHR forbidden'); } };
          globalThis.addEventListener = () => { throw Error('Extra global worker listener forbidden'); };
          if (typeof DOMMatrix !== 'undefined') throw Error('This test requires a DOM-free Worker');
        ` : ''}
        import(workerData).then(() => {
          if (typeof self.onmessage !== 'function') throw Error('Worker message handler missing');
          parentPort.on('message', data => self.onmessage({data}));
        }).catch(error => { throw error; });
      `, {eval: true, workerData: String(url)});
      workers.push(this);
      this.worker.on('message', data => {
        if (data.networkAttempt) network.push(data.networkAttempt);
        else this.onmessage?.({data});
      });
      this.worker.on('error', error => {
        errors.push(error.message);
        this.onerror?.({preventDefault() {}});
      });
    }
    postMessage(message) { requests.push(message); this.worker.postMessage(message); }
    terminate() { this.terminated = true; return this.worker.terminate(); }
  }
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(readFileSync(path.join(directory, 'index.html'), 'utf8').replace('href="/site.css"', 'href="site.css"').replace('href="/favicon.svg"', 'href="favicon.svg"'), {url: pathToFileURL(path.join(directory, 'index.html')).href,
    resources: localResources, runScripts: realModules ? 'outside-only' : 'dangerously', virtualConsole,
    beforeParse(window) {
      window.Worker = WebWorker;
      window.TextEncoder = TextEncoder;
      window.AbortController = AbortController;
      Object.defineProperty(window, 'crypto', {value: webcrypto});
      window.Response = Response;
      window.CompressionStream = CompressionStream;
      window.DecompressionStream = DecompressionStream;
      window.structuredClone = structuredClone;
      window.Blob = Blob;
      window.Uint8Array = Uint8Array;
      window.fetch = (...args) => { network.push(String(args[0])); throw Error('Network forbidden'); };
      window.XMLHttpRequest = class { constructor() { network.push('XMLHttpRequest'); throw Error('Network forbidden'); } };
      window.WebSocket = class { constructor(url) { network.push(String(url)); throw Error('Network forbidden'); } };
      window.navigator.sendBeacon = url => { network.push(String(url)); return false; };
      Object.defineProperty(window.navigator, 'clipboard', {value: {
        writeText: async value => { clipboard.push(value); },
      }});
      window.open = url => { navigations.push(String(url)); return null; };
      window.Element.prototype.scrollIntoView = () => {};
      const blobs = new Map();
      window.URL.createObjectURL = blob => { const id = `blob:test-${blobs.size}`; blobs.set(id, blob); return id; };
      window.URL.revokeObjectURL = id => blobs.delete(id);
      window.HTMLAnchorElement.prototype.click = function () {
        if (this.download) downloads.push({name: this.download, blob: blobs.get(this.href)});
        else navigations.push(this.href);
      };
    },
  });
  if (realModules) {
    const run=moduleLoader(dom,directory,{failVisualOnce:realModules === 'fail-first-visual'});
    for (const script of dom.window.document.querySelectorAll('script[src]')) {
      Object.defineProperty(dom.window.document,'currentScript',{configurable:true,value:script});run(script);
    }
    Object.defineProperty(dom.window.document,'currentScript',{configurable:true,value:null});
  }
  t.after(async () => {
    dom.window.close();
    const allTerminated = workers.every(worker => worker.terminated);
    await Promise.all(workers.map(worker => worker.terminate()));
    assert.ok(allTerminated, 'Transport must terminate completed workers');
    assert.deepEqual(errors, []);
    assert.deepEqual(network, [], 'UI and worker must make no network calls');
    assert.deepEqual(navigations, [], 'The office assistant must not open mail clients or external pages');
  });
  await until(() => dom.window.document.readyState === 'complete');
  const $ = id => dom.window.document.getElementById(id);
  const idle = () => until(() => !$('compare').disabled, () => $('notice').textContent);
  const result = () => until(() => !$('results').hidden && !$('compare').disabled, () => $('notice').textContent);
  async function file(side, text, name) {
    const bytes = Buffer.from(text, 'utf8');
    Object.defineProperty($(side + '-file'), 'files', {configurable: true, value: [{
      name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }]});
    $(side + '-file').dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    await until(() => $(side + '-filename').textContent === name);
    await idle();
  }
  return {$, dom, requests, downloads, clipboard, result, file};
}

import {handleRequest} from '../dist/worker.mjs';
import {readDocxVisual, writeDocxVisual} from '../dist/docx-visual.mjs';
import {tableSource} from './fixtures/table-fixture.mjs';
import {getDocument} from '../dist/pdf-reader-vendor.mjs';
import {docx} from './fixtures/text-fixture.mjs';
import {read, write, utils} from '../dist/xlsx-vendor.mjs';
const office=require('./dist/office.js');
const source=(name,text)=>({name,data:Buffer.from(text).toString('base64')});
const noRussian=value=>assert.doesNotMatch(value,/[А-Яа-яЁё]/);
const csvPayload={
 left:source('a.csv','sku,quantity,unit,price,currency\nA,10,piece,120,USD\nB,2,piece,30,USD\nC,1,piece,20,USD\n'),
 right:source('b.csv','sku,quantity,unit,price,currency\nA,10,piece,125,USD\nB,2,piece,30,USD\nD,1,piece,40,USD\n'),
 delimiter:',',key:['sku','sku'],fields:[['quantity','quantity','number'],['price','price','number'],['unit','unit','text']],strip:false
};

test('English UI: real demo Worker, suggested questions, TXT source preservation and fail-closed error',async t=>{
 const p=await page(t,'web');
 assert.equal(p.dom.window.document.documentElement.lang,'en');
 assert.equal(p.$('office-sidebar').hidden,true);
 assert.equal(p.$('office-open').disabled,true);
 p.$('demo-tables').click();await p.result();
 noRussian(p.dom.window.document.body.textContent);
 p.$('office-open').click();
 assert.equal(p.$('office-sidebar').hidden,false);
 assert.equal(p.$('office-open').getAttribute('aria-expanded'),'true');
 assert.equal(p.dom.window.document.activeElement.id,'office-title');
 assert.equal(p.$('office-sidebar').parentElement.id,'comparison-layout');
 assert.equal(p.$('office-sidebar').closest('#complete-result'),null);
 p.$('office-sidebar').dispatchEvent(new p.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(p.$('office-sidebar').hidden,true);
 assert.equal(p.dom.window.document.activeElement.id,'office-open');
 p.$('office-open').click(); p.$('office-close').click();
 assert.equal(p.$('office-open').getAttribute('aria-expanded'),'false');
 p.$('office-open').click();
 assert.match(p.$('commercial-summary').textContent,/USD/);
 for(const q of ['Explain the results','Where did the price change?','What is missing?','Draft an email','How did the total change?']){
  p.$('office-question').value=q;
  p.$('office-form').dispatchEvent(new p.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  noRussian(p.$('office-transcript').textContent);
  assert.doesNotMatch(p.$('office-transcript').textContent,/couldn't match this question/);
 }
 assert.match(p.$('office-draft').value,/Hello|Dear/);
 await p.file('left','Поставка товара.\nГарантия 12 месяцев.','a.txt');
 await p.file('right','Поставка товара.\nГарантия 24 месяца.','b.txt');await p.result();
 assert.match(p.$('result-rows').textContent,/Гарантия/);
 assert.equal(p.$('office-sidebar').hidden,true,'A new comparison closes the old assistant');
 delete p.dom.window.KristinaTransport;p.$('demo-tables').click();
 await until(()=>/Could not load|Couldn't load/.test(p.$('notice').textContent),()=>p.$('notice').textContent);
 noRussian(p.$('notice').textContent);
});

test('English questions return grounded results; drafts require an affirmative request; exact keys win',async()=>{
 const {report}=await handleRequest('/api/compare',csvPayload);
 assert.equal(report.changed.length,1);assert.equal(report.commercial.totals[0].currency,'USD');
 assert.match(office.answer(report,'Where did the price change?').text,/"A"/);
 assert.match(office.answer(report,'What is missing?').text,/"C"/);
 assert.match(office.answer(report,'How did the total change?').text,/USD/);
 assert.ok(office.answer(report,'Draft an email').draft);
 assert.equal(office.answer(report,"Don't draft an email").draft,undefined);
 assert.equal(office.answer(report,'Do not write a letter').draft,undefined);
 assert.match(office.answer(report,'Show A').text,/"A"/);
 assert.equal(office.commercialMoney('12345.60'),'12,345.60');
 const exact={...csvPayload,left:source('a.csv','sku,quantity,unit,price,currency\nDraft an email,1,piece,3,USD\n'),right:source('b.csv','sku,quantity,unit,price,currency\nDraft an email,1,piece,4,USD\n')};
 const r=await handleRequest('/api/compare',exact);
 assert.equal(office.answer(r.report,'Draft an email').draft,undefined);
 assert.match(office.answer(r.report,'Draft an email').text,/Item/);
});

test('HTML, XLSX and PDF exports use English labels and preserve exact numbers',async()=>{
 const {report,html}=await handleRequest('/api/compare',csvPayload);
 noRussian(html);assert.match(html,/lang="en"/);
 const xlsx=await handleRequest('/api/export',{format:'xlsx',report});
 assert.equal(xlsx.filename,'ctt-comparison.xlsx');
 const workbook=read(xlsx.data,{type:'array'});
 assert.ok(workbook.SheetNames.includes('Summary'));
 noRussian(workbook.SheetNames.join(' '));
 const all=workbook.SheetNames.flatMap(n=>utils.sheet_to_json(workbook.Sheets[n],{header:1})).flat().join(' ');
 noRussian(all);assert.match(all,/125/);
 const pdf=await handleRequest('/api/export',{format:'pdf',report});
 const task=getDocument({data:pdf.data,useSystemFonts:false,isEvalSupported:false,disableFontFace:true});
 const loaded=await task.promise;let text='';
 for(let i=1;i<=loaded.numPages;i++)text+=(await (await loaded.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');
 await task.destroy();noRussian(text);assert.match(text,/125/);
});

test('Word source text and table geometry survive an English UI edit and DOCX round trip',async()=>{
 const original=tableSource(),model=await readDocxVisual(original);
 const target=model.blocks.find(b=>b.text.length);
 const replacement='Updated — Гарантия 24 месяца';
 const bytes=await writeDocxVisual(original,[{record:target.record,text:replacement}]);
 const after=await readDocxVisual(source('edited.docx',bytes));
 assert.equal(after.blocks.find(b=>b.record===target.record).text,replacement);
 assert.equal(after.blocks.length,model.blocks.length);
 assert.deepEqual(after.content.filter(x=>x.type==='table').map(x=>x.rows.length),model.content.filter(x=>x.type==='table').map(x=>x.rows.length));
 const payload={left:source('a.docx',docx(['Warranty: 12 months.','Original line.'])),right:source('b.docx',docx(['Warranty: 24 months.','Added line.']))};
 const {report,html}=await handleRequest('/api/compare',payload);
 noRussian(html);assert.match(office.answer(report,'Show paragraph 1 in A').text,/12 months/);
 assert.ok(office.answer(report,'Draft an email').draft);
});

test('Russian header aliases remain accepted while generated messages stay English',async()=>{
 const payload={left:source('a.csv','Артикул,Количество,Цена_руб\nX,2,50\n'),right:source('b.csv','Артикул,Количество,Цена_руб\nX,2,60\n'),delimiter:'auto'};
 const setup=await handleRequest('/api/prepare',payload);
 assert.ok(JSON.stringify(setup).includes('Артикул'));
 const result=await handleRequest('/api/compare',{...payload,delimiter:',',key:['Артикул','Артикул'],fields:[['Количество','Количество','number'],['Цена_руб','Цена_руб','number']],strip:false});
 assert.equal(result.report.changed.length,1);
 assert.equal(result.report.changed[0].changes[0].before,'50');
 await assert.rejects(()=>handleRequest('/api/compare',{left:source('a.doc','x'),right:source('b.doc','y')}),error=>{noRussian(error.message);return /not yet supported/.test(error.message)});
});

// Real document controller: assistant reads current drafts, never mutates the original report.
import {mountVisualReview} from '../dist/visual-review.mjs';
import {compareText} from '../dist/text-engine.mjs';
import editor from '../dist/text-editor.js';
test('selected change context follows edits, copy, undo and deselection', async t => {
 const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main');
 globalThis.window=dom.window;globalThis.document=dom.window.document;
 window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const sources={left:source('a.txt','Delivery in 5 days.\nThank you.'),right:source('b.txt','Delivery in 10 days.\nThank you.')};
 const report=await compareText(sources),before=JSON.stringify(report),contexts=[],explanations=[];
 const review=await mountVisualReview(root,{report,sources,onSelectionChange:c=>contexts.push(c),onExplain:c=>explanations.push(c)});
 t.after(()=>{review.dispose();dom.window.close();delete globalThis.document;delete globalThis.window;});
 assert.equal(review.getAssistantContext().selected,null);
 await review.select(report.changed[0].key);
 assert.equal(contexts.at(-1).selected.left,'Delivery in 5 days.');
 assert.equal(contexts.at(-1).selected.right,'Delivery in 10 days.');
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Explain this change').click();
 assert.deepEqual(explanations.at(-1),review.getAssistantContext());
 const field=root.querySelector('[data-edit-side="left"]');field.value='Delivery in 7 days.';field.dispatchEvent(new dom.window.Event('input'));
 assert.equal(contexts.at(-1).selected.left,'Delivery in 7 days.');assert.equal(contexts.at(-1).edited,true);
 root.querySelector('[data-copy-to="right"]').click();
 assert.equal(contexts.at(-1).selected.right,'Delivery in 7 days.');assert.equal(contexts.at(-1).textsEqual,true);assert.equal(contexts.at(-1).count,0);
 root.querySelector('[aria-label="Undo edit in B"]').click();
 assert.equal(contexts.at(-1).selected.right,'Delivery in 10 days.');assert.equal(contexts.at(-1).textsEqual,false);
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Done ✓').click();
 assert.equal(contexts.at(-1).selected,null);assert.equal(JSON.stringify(report),before);
});

test('website activates the actual full document editor through app module loading',async t=>{
 const p=await page(t,'web',false,true);
 await p.file('left','Delivery in 5 days.\nThank you.','a.txt');
 await p.file('right','Delivery in 10 days.\nThank you.','b.txt');await p.result();
 assert.equal(p.dom.window.document.body.classList.contains('visual-mode'),true,'Must not silently fall back to the legacy editor');
 assert.equal(p.$('visual-review').hidden,false);
 assert.equal(p.$('visual-review').querySelectorAll('.visual-paragraph').length,4);
 p.$('visual-review').querySelector('.has-difference').click();
 await until(()=>!p.$('visual-review').querySelector('.visual-inspector').hidden);
 p.$('office-open').click();assert.match(p.$('office-left-text').textContent,/5 days/);
 p.$('visual-review').querySelector('[data-copy-to="right"]').click();
 assert.match(p.$('visual-review').querySelector('.visual-progress').textContent,/Texts match/);
 assert.match(p.$('office-right-text').textContent,/5 days/);
});

test('Word example exposes cell edits, whole-row repair, new-row transfer and a reopenable DOCX',async t=>{
 const p=await page(t,'web',false,true);p.$('demo').click();await p.result();
 const root=p.$('visual-review'),q=s=>root.querySelector(s),columns=()=>root.querySelectorAll('.visual-column');
 assert.equal(p.$('visual-load-error').hidden,true,p.$('notice').textContent);
 assert.equal(root.querySelectorAll('table').length,2,'The demo must activate Word table editing: '+root.textContent);
 assert.equal(root.querySelectorAll('img').length,2);assert.equal(root.querySelectorAll('h1').length,2);
 async function select(text,side=0){const node=[...columns()[side].querySelectorAll('[data-group]')].find(n=>n.textContent===text);assert.ok(node,'Find paragraph '+text);node.click();await until(()=>q('[data-edit-side="'+(side?'right':'left')+'"]').value===text);}
 await select('$35.00');q('[data-copy-to="right"]').click();
 assert.equal(q('[data-edit-side="right"]').value,'$35.00');
 q('[data-copy-row-text-from="left"]').click();
 assert.match(columns()[1].querySelector('table').textContent,/Desk lamp10\$35.00/);
 q('[aria-label="Undo edit in B"]').click();
 assert.match(columns()[1].querySelector('table').textContent,/Desk lamp12\$35.00/);
 await select('Desk lamp');q('[data-row-side="left"][data-insert-row="after"]').click();
 const field=q('[data-edit-side="left"]');field.value='Standing desk';field.dispatchEvent(new p.dom.window.Event('input'));
 q('[data-copy-row-from="left"]').click();
 assert.equal(columns()[0].querySelectorAll('tr').length,4);assert.equal(columns()[1].querySelectorAll('tr').length,4);
 assert.match(columns()[1].querySelector('table').textContent,/Standing desk/);
 q('[data-save-side="right"]').click();await until(()=>p.downloads.length===1);
 const downloaded=p.downloads[0];assert.match(downloaded.name,/version-B.docx$/);
 const bytes=new Uint8Array(await downloaded.blob.arrayBuffer());const reopened=await readDocxVisual(source(downloaded.name,bytes));
 assert.equal(reopened.content.find(x=>x.type==='table').rows.length,4);
 assert.ok(reopened.blocks.some(b=>b.text==='Standing desk'));assert.ok(reopened.blocks.some(b=>b.runs.some(r=>r.image)));
 await select('Standing desk',1);q('[data-row-side="right"][data-delete-row]').click();
 assert.equal(columns()[1].querySelectorAll('tr').length,3);q('[aria-label="Undo edit in B"]').click();assert.equal(columns()[1].querySelectorAll('tr').length,4);
});
test('failed editor startup is visible and retry opens the same files without legacy fallback',async t=>{
 const p=await page(t,'web',false,'fail-first-visual');p.$('demo').click();await p.result();
 assert.equal(p.$('visual-load-error').hidden,false);assert.equal(p.$('visual-review').hidden,true);
 assert.equal(p.dom.window.document.body.classList.contains('visual-mode'),true);
 assert.equal(p.$('left-filename').textContent,'Office-agreement-A.docx');
 p.$('visual-retry').click();await until(()=>!p.$('visual-review').hidden&&!p.$('compare').disabled);
 assert.equal(p.$('visual-load-error').hidden,true);assert.equal(p.$('visual-review').querySelectorAll('table').length,2);
});

test('download freezes the clicked Word revision while newer text and rows remain editable',async t=>{
 const p=await page(t,'web',false,true);p.$('demo').click();await p.result();
 const root=p.$('visual-review'),q=s=>root.querySelector(s),right=()=>root.querySelectorAll('.visual-column')[1];
 const cell=[...right().querySelectorAll('[data-group]')].find(n=>n.textContent==='Desk lamp');cell.click();
 await until(()=>q('[data-edit-side="right"]').value==='Desk lamp');
 const input=q('[data-edit-side="right"]');input.value='Desk lamp - first revision';input.dispatchEvent(new p.dom.window.Event('input'));
 q('[data-save-side="right"]').click();
 input.value='Desk lamp - latest revision';input.dispatchEvent(new p.dom.window.Event('input'));
 q('[data-row-side="right"][data-insert-row="after"]').click();
 await until(()=>p.downloads.length===1);
 const readDownload=async i=>readDocxVisual(source(p.downloads[i].name,new Uint8Array(await p.downloads[i].blob.arrayBuffer())));
 const first=await readDownload(0);
 assert.ok(first.blocks.some(b=>b.text==='Desk lamp - first revision'),'Download must contain the text present at the click');
 assert.equal(first.content.find(x=>x.type==='table').rows.length,3,'Later row insertion must not enter the earlier download');
 assert.match(right().textContent,/Desk lamp - latest revision/);assert.equal(right().querySelectorAll('tr').length,4);
 assert.match(root.querySelector('.visual-notice').textContent,/Download again/);
 q('[data-save-side="right"]').click();await until(()=>p.downloads.length===2);
 const second=await readDownload(1);
 assert.ok(second.blocks.some(b=>b.text==='Desk lamp - latest revision'));assert.equal(second.content.find(x=>x.type==='table').rows.length,4);
 assert.doesNotMatch(root.querySelector('.visual-notice').textContent,/Download again/);
 q('[aria-label="Undo edit in B"]').click();assert.equal(right().querySelectorAll('tr').length,3,'Downloading must preserve undo history');
 q('[data-save-side="right"]').click();p.$('demo-tables').click();await p.result();
 assert.equal(p.downloads.length,2,'Switching comparisons cancels the pending download');
 assert.equal(p.$('visual-review').hidden,false);assert.ok(p.$('visual-review').classList.contains('sheet-review'));
});

test('guided review keeps B, copies A, advances, undoes and reopens edited decisions',async t=>{
 const p=await page(t,'web',false,true);
 await p.file('left','Delivery in 5 days.\nWarranty: 24 months.','a.txt');await p.file('right','Delivery in 10 days.\nWarranty: 12 months.','b.txt');await p.result();
 const root=p.$('visual-review'),q=s=>root.querySelector(s),action=name=>q(`[data-review-action="${name}"]`);
 assert.match(q('.review-flow-progress').textContent,/Reviewed 0 of 2/);
 action('start').click();await until(()=>q('[data-edit-side="right"]').value==='Delivery in 10 days.');
 action('keep').click();await until(()=>q('[data-edit-side="right"]').value==='Warranty: 12 months.');
 assert.match(q('.review-flow-progress').textContent,/Reviewed 1 of 2/);
 action('use-a').click();await until(()=>!action('download').hidden);
 assert.match(q('.review-flow-progress').textContent,/Reviewed 2 of 2/);assert.match(q('.review-flow-hint').textContent,/All differences reviewed/);
 assert.match(root.querySelectorAll('.visual-column')[1].textContent,/Delivery in 10 days/);
 action('undo').click();assert.equal(q('[data-edit-side="right"]').value,'Warranty: 12 months.');assert.match(q('.review-flow-progress').textContent,/Reviewed 1 of 2/);
 action('keep').click();await until(()=>!action('download').hidden);
 const first=[...root.querySelectorAll('.visual-column')[0].querySelectorAll('[data-group]')].find(n=>n.textContent==='Delivery in 5 days.');first.click();
 const input=q('[data-edit-side="left"]');input.value='Delivery in 7 days.';input.dispatchEvent(new p.dom.window.Event('input'));
 assert.match(q('.review-flow-progress').textContent,/Reviewed 1 of 2/);assert.equal(action('download').hidden,true);assert.equal(action('undo').disabled,true);
 action('keep').click();await until(()=>!action('download').hidden);
 action('download').click();await until(()=>p.downloads.length===1);assert.match(await p.downloads[0].blob.text(),/Delivery in 10 days/);
});

test('review decisions survive saved-work restoration and manual Done advances without discarding edits',async t=>{
 const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main');globalThis.window=dom.window;globalThis.document=dom.window.document;
 window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const sources={left:source('a.txt','First: A\nSecond: A'),right:source('b.txt','First: B\nSecond: B')},report=await compareText(sources);
 let review=await mountVisualReview(root,{report,sources});t.after(()=>{review.dispose();dom.window.close();delete globalThis.window;delete globalThis.document;});
 root.querySelector('[data-review-action="start"]').click();root.querySelector('[data-review-action="keep"]').click();
 const snapshot=review.snapshot();assert.equal(snapshot.review.started,true);review.dispose();review=await mountVisualReview(root,{report,sources,restoredState:snapshot});
 assert.match(root.querySelector('.review-flow-progress').textContent,/Reviewed 1 of 2/);assert.equal(root.querySelector('.final-check').hidden,true);
 const input=root.querySelector('[data-edit-side="right"]');assert.equal(input.value,'Second: B');input.value='Second: revised';input.dispatchEvent(new dom.window.Event('input'));
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Done — next difference').click();
 assert.match(root.querySelector('.review-flow-progress').textContent,/Reviewed 2 of 2/);assert.match(review.drafts.right.text(),/Second: revised/);
 // Old saved sessions, made before review progress existed, remain supported.
 const legacy=review.snapshot();delete legacy.review;review.dispose();review=await mountVisualReview(root,{report,sources,restoredState:legacy});assert.match(root.querySelector('.review-flow-progress').textContent,/Reviewed 0 of 2/);
});

test('guided Word row repair resolves all row cells and advances; an absent cell is never copied as a single cell',async t=>{
 const p=await page(t,'web',false,true);p.$('demo').click();await p.result();const root=p.$('visual-review'),q=s=>root.querySelector(s),action=name=>q(`[data-review-action="${name}"]`);
 action('start').click();await until(()=>q('[data-edit-side="left"]').value.includes('Delivery'));
 action('use-a').click();await until(()=>q('[data-edit-side="left"]').value==='10');
 q('[data-copy-row-text-from="left"]').click();await until(()=>q('[data-edit-side="left"]').value==='Warranty: 24 months.');
 assert.match(q('.review-flow-progress').textContent,/Reviewed 3 of 4/);
 [...root.querySelector('.visual-column').querySelectorAll('[data-group]')].find(n=>n.textContent==='Desk lamp').click();
 q('[data-row-side="left"][data-insert-row="after"]').click();
 assert.equal(action('use-a').disabled,true,'New rows use the explicit whole-row transfer');
 assert.equal(action('download').hidden,true);
 const input=q('[data-edit-side="left"]');input.value='Added row';input.dispatchEvent(new p.dom.window.Event('input'));
 q('[data-copy-row-from="left"]').click();await until(()=>q('[data-edit-side="left"]').value==='Warranty: 24 months.');
 action('keep').click();await until(()=>!action('download').hidden);
 assert.match(q('.review-flow-hint').textContent,/All differences reviewed/);assert.equal(p.dom.window.document.activeElement,action('download'));
});

test('resetting review decisions autosaves even when Keep B left both documents unchanged',async t=>{
 const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main');globalThis.window=dom.window;globalThis.document=dom.window.document;
 window.KristinaTextEditor=editor;window.Element.prototype.scrollIntoView=()=>{};
 const sources={left:source('a.txt','Amount: 100'),right:source('b.txt','Amount: 200')},report=await compareText(sources);let saved;
 const review=await mountVisualReview(root,{report,sources,onStateChange:()=>{saved=review.snapshot();}});
 t.after(()=>{review.dispose();dom.window.close();delete globalThis.window;delete globalThis.document;});
 root.querySelector('[data-review-action="start"]').click();root.querySelector('[data-review-action="keep"]').click();await delay(0);
 assert.ok(saved.review.items.some(([,decision])=>decision!==null));const revisions=[review.drafts.left.revision,review.drafts.right.revision];
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Restore original documents').click();
 assert.deepEqual([review.drafts.left.revision,review.drafts.right.revision],revisions);
 assert.ok(saved.review.items.every(([,decision])=>decision===null));assert.match(root.querySelector('.review-flow-progress').textContent,/Reviewed 0 of 1/);
});

for (const browser of ['chrome','firefox']) test(`${browser} 0.33.6 archive: Word review, cell repair, Keep B and DOCX download`,async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'ctt-release-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const archive=fileURLToPath(new URL(`../dist/downloads/ctt-${browser}-0.33.6.zip`,import.meta.url));
 execFileSync('python3',['-m','zipfile','-e',archive,directory]);
 const p=await page(t,directory,false,true);p.$('demo').click();await p.result();
 const root=p.$('visual-review'),q=s=>root.querySelector(s),action=name=>q(`[data-review-action="${name}"]`);
 assert.equal(root.querySelectorAll('table').length,2);assert.equal(root.querySelectorAll('img').length,2);
 action('start').click();await until(()=>q('[data-edit-side="left"]').value.includes('Delivery'));
 action('use-a').click();await until(()=>q('[data-edit-side="left"]').value==='10');
 q('[data-copy-row-text-from="left"]').click();await until(()=>q('[data-edit-side="left"]').value==='Warranty: 24 months.');
 action('keep').click();await until(()=>!action('download').hidden);
 assert.match(q('.review-flow-progress').textContent,/Reviewed 4 of 4/);
 action('download').click();await until(()=>p.downloads.length===1);
 const saved=p.downloads[0],reopened=await readDocxVisual(source(saved.name,new Uint8Array(await saved.blob.arrayBuffer())));
 assert.ok(reopened.blocks.some(b=>b.text==='Warranty: 12 months.'));
 assert.ok(reopened.blocks.some(b=>b.text==='$35.00'));
 assert.ok(reopened.blocks.some(b=>b.runs.some(r=>r.image)));
 assert.equal(reopened.content.find(x=>x.type==='table').rows.length,3);
});

test('CSV full grid edits, row transfer, undo and source export',async t=>{
 const p=await page(t,'web',false,true);p.$('demo-tables').click();await p.result();const root=p.$('visual-review'),q=s=>root.querySelector(s);
 assert.ok(root.classList.contains('sheet-review'));assert.equal(root.querySelectorAll('.sheet-grid').length,2);
 q('[data-side="left"][data-cell="B3"]').click();q('[data-review-action="use-a"]').click();
 assert.equal(q('[data-side="right"][data-cell="B3"]').textContent,'5');
 q('[data-side="right"][data-cell="C3"]').click();q('[data-edit-side="right"]').value='box of 2';q('[data-apply-cell="right"]').click();assert.equal(q('[data-side="right"][data-cell="C3"]').textContent,'box of 2');
 q('[data-sheet-undo]').click();assert.equal(q('[data-side="right"][data-cell="C3"]').textContent,'piece');
 q('[data-side="left"][data-cell="A5"]').click();q('[data-copy-row-from="left"]').click();
 q('[data-save-side="right"]').click();await until(()=>p.downloads.length===1);const text=await p.downloads[0].blob.text();assert.match(text,/OLD-400,1,piece,40,USD/);assert.match(text,/DS-200,5,piece,22,USD/);assert.match(text,/OLD-400,1,piece,40,USD\nNEW-500/);assert.equal(q('[data-side="right"][data-cell="A5"]').textContent,'OLD-400');assert.equal(q('[data-side="right"][data-cell="A6"]').textContent,'NEW-500');
});

test('XLSX full grid respects offset headers and normalized identifiers when paired with CSV',async t=>{
 const wb=utils.book_new(),ws=utils.aoa_to_sheet([]);utils.sheet_add_aoa(ws,[['sku','price'],[1,10]],{origin:'C2'});ws.C3.z='000';ws['!ref']='A1:D3';utils.book_append_sheet(wb,ws,'Data');
 const bytes=new Uint8Array(write(wb,{type:'array',bookType:'xlsx',compression:true}));const p=await page(t,'web',false,true);await p.file('left',bytes,'a.xlsx');await p.file('right','sku,price\n001,12\n','b.csv');await p.result();const root=p.$('visual-review'),q=s=>root.querySelector(s);
 assert.equal(root.querySelectorAll('.sheet-grid').length,2,root.textContent);assert.match(q('.review-flow-progress').textContent,/Reviewed 0 of 1/);
 q('[data-side="left"][data-cell="D3"]').click();q('[data-copy-to="right"]').click();assert.equal(q('[data-side="right"][data-cell="B2"]').textContent,'10');
 q('[data-edit-side="left"]').value='15';q('[data-apply-cell="left"]').click();q('[data-save-side="left"]').click();await until(()=>p.downloads.length===1);const out=read(new Uint8Array(await p.downloads[0].blob.arrayBuffer()),{type:'array'});assert.equal(out.Sheets.Data.D3.v,15);assert.equal(out.Sheets.Data.C3.v,1);
});

test('final check uses edited text, distinguishes Keep B, navigates pending items and invalidates after undo',async t=>{
 const p=await page(t,'web',false,true);await p.file('left','Delivery in 5 days.\nWarranty: 24 months.','a.txt');await p.file('right','Delivery in 10 days.\nWarranty: 12 months.','b.txt');await p.result();
 const root=p.$('visual-review'),q=s=>root.querySelector(s),action=name=>q(`[data-review-action="${name}"]`),state=()=>q('.final-check').dataset.checkState;
 action('check').click();assert.equal(state(),'remaining');assert.match(q('[data-check-result]').textContent,/2 differences/);
 action('remaining').click();await until(()=>q('[data-edit-side="right"]').value==='Delivery in 10 days.');action('keep').click();await until(()=>q('[data-edit-side="right"]').value==='Warranty: 12 months.');
 assert.equal(state(),'stale');action('check').click();assert.match(q('[data-check-result]').textContent,/1 difference/);action('use-a').click();await until(()=>!action('download').hidden);action('check').click();assert.equal(state(),'kept');assert.match(q('[data-check-result]').textContent,/chosen differences/);
 action('undo').click();assert.equal(state(),'stale');action('check').click();assert.equal(state(),'remaining');
 q('[data-action="copy-all-right"]').click();action('check').click();assert.equal(state(),'match');assert.match(q('[data-check-result]').textContent,/No differences in checked text/);
 action('download').click();await until(()=>p.downloads.length===1);assert.equal(await p.downloads[0].blob.text(),'Delivery in 5 days.\nWarranty: 24 months.\n');
 q('[aria-label="Undo edit in B"]').click();assert.equal(state(),'stale');
});

test('final check commits visible spreadsheet input and retains honest kept and checked-column results',async t=>{
 const p=await page(t,'web',false,true);await p.file('left','sku,price\nX,10\nY,20\nZ,30\n','a.csv');await p.file('right','sku,price\nX,12\nZ,30\n','b.csv');await p.result();
 const root=p.$('visual-review'),q=s=>root.querySelector(s),action=name=>q(`[data-review-action="${name}"]`),state=()=>q('.final-check').dataset.checkState;
 q('[data-side="left"][data-cell="A3"]').click();q('[data-copy-row-from="left"]').click();
 q('[data-side="right"][data-cell="B2"]').click();action('keep').click();action('check').click();assert.equal(state(),'kept');
 q('[data-side="right"][data-cell="B2"]').click();const input=q('[data-edit-side="right"]');input.value='10';input.dispatchEvent(new p.dom.window.Event('input'));assert.equal(state(),'stale');
 action('check').click();assert.equal(q('[data-side="right"][data-cell="B2"]').textContent,'10');assert.equal(state(),'match');assert.match(q('[data-check-result]').textContent,/checked values/);
 action('download').click();await until(()=>p.downloads.length===1);assert.equal(await p.downloads[0].blob.text(),'sku,price\nX,10\nY,20\nZ,30\n');
 q('[data-sheet-undo]').click();assert.equal(state(),'stale');action('check').click();assert.equal(state(),'kept');
 q('[data-side="right"][data-cell="B2"]').click();q('[aria-label="Cell type in B"]').value='number';q('[data-edit-side="right"]').value='invalid number';q('[data-edit-side="right"]').dispatchEvent(new p.dom.window.Event('input'));action('check').click();assert.equal(state(),'stale');assert.match(q('.visual-notice').textContent,/Enter a number/);assert.equal(q('[data-side="right"][data-cell="B2"]').textContent,'12');
});
