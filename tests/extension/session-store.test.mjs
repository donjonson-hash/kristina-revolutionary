import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, access} from 'node:fs/promises';
import {createServer} from 'node:http';
import {openSessionStore, validateSessionPayload} from '../../extension/session-store.mjs';
import {compareText} from '../../extension/text-engine.mjs';

const source = text => ({name: 'document.txt', data: Buffer.from(text).toString('base64')});
async function fixture() {
  const sources = {left: source('Заголовок\nЦена 100\nКонец'), right: source('Заголовок\nЦена 200')};
  return {version: 1, sources, report: await compareText(sources), review: {drafts: {left: [], right: []}, selected: 'text-2'}};
}
test('a complete text comparison snapshot is detached from later live changes', async () => {
  const payload = await fixture(), saved = validateSessionPayload(payload);
  assert.deepEqual(saved, payload);
  payload.review.selected = null; payload.report.changed[0].right.text = 'later';
  assert.equal(saved.review.selected, 'text-2');
  assert.equal(saved.report.changed[0].right.text, 'Цена 200');
});
test('unsupported formats and versions, malformed sources and incomplete reports are refused', async () => {
  const original = await fixture();
  for (const change of [p => { p.sources.left.data = 'bad'; }, p => { p.sources.left.data = '===='; }, p => { p.report.kind = 'table'; }, p => { p.report.status = 'partial'; }, p => { p.review = []; }, p => { p.report.sources.left.format = 'html'; }, p => { p.report.changed[0].right.record = -1; }, p => { p.report.matched.push(p.report.changed[0]); }]) {
    const payload = structuredClone(original); change(payload);
    assert.throws(() => validateSessionPayload(payload), {code: 'invalid'});
  }
  assert.throws(() => validateSessionPayload({...original, version: 2}), {code: 'incompatible'});
  const cyclic = {...original}; cyclic.review = {cyclic};
  assert.throws(() => validateSessionPayload(cyclic), {code: 'invalid'});
});
test('binary source bounds include base64 padding, and total UTF-8 snapshot size is bounded', async () => {
  const payload = await fixture();
  payload.sources.left.data = Buffer.alloc(2 * 1024 * 1024).toString('base64');
  assert.doesNotThrow(() => validateSessionPayload(payload));
  payload.sources.left.data = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => validateSessionPayload(payload), {code: 'invalid'});
  payload.sources.left = source('a'); payload.review.extra = 'я'.repeat(17 * 1024 * 1024);
  assert.throws(() => validateSessionPayload(payload), {code: 'invalid'});
});
test('unavailable storage preserves the native failure and blocked opens close late connections', async () => {
  await assert.rejects(openSessionStore({indexedDB: null}), {code: 'unavailable'});
  const denied = new DOMException('denied', 'SecurityError');
  await assert.rejects(openSessionStore({indexedDB: {open() { throw denied; }}}), error => error === denied);
  const request = {}; let closed = false;
  const opening = openSessionStore({indexedDB: {open() { return request; }}});
  request.onblocked(); await assert.rejects(opening, {code: 'blocked'});
  request.result = {close() { closed = true; }}; request.onsuccess();
  assert.equal(closed, true);
});

// Run against the browser's actual transactional implementation when the local
// browser verification runtime is available; the offline suite needs no new deps.
test('IndexedDB persists reloads, serializes competing tabs, rolls back failed writes, and keeps deletion tombstones', async t => {
  let chromium;
  const executablePath = process.env.KRISTINA_TEST_CHROMIUM || '/tmp/kristina-browser/chromium';
  try {
    await access(executablePath);
    const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
    if (!runtime) throw new Error('No browser runtime');
    ({chromium} = createRequire(`${runtime}/playwright/package.json`)('playwright'));
  } catch { t.skip('Actual Chromium runtime is not installed; schema tests above still run offline.'); return; }
  const moduleSource = await readFile(new URL('../../extension/session-store.mjs', import.meta.url));
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/session-store.mjs' ? 'text/javascript' : 'text/html'); res.end(req.url === '/session-store.mjs' ? moduleSource : '<!doctype html><title>Local session test</title>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({executablePath, headless: true, args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer']});
  t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const payload = await fixture();
  const result = await page.evaluate(async payload => {
    const {openSessionStore} = await import('/session-store.mjs');
    const a = await openSessionStore(), b = await openSessionStore();
    const initial = await a.read();
    const first = await a.write(payload, initial.token);
    const races = await Promise.allSettled([a.write({...payload, review: {selected: 'left'}}, first.token), b.write({...payload, review: {selected: 'right'}}, first.token)]);
    const winner = races.find(item => item.status === 'fulfilled').value;
    const losingCode = races.find(item => item.status === 'rejected').reason.code;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
    let quota;
    try { await a.write(payload, winner.token); } catch (error) { quota = error.name; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const afterFailure = await b.read();
    const tombstone = await b.clear(winner.token);
    let staleCode; try { await a.write(payload, winner.token); } catch (error) { staleCode = error.code; }
    const afterStale = await a.read();
    const final = await a.write(payload, tombstone.token);
    a.close(); b.close();
    return {initial, first, winner, losingCode, quota, afterFailure, tombstone, staleCode, afterStale, final};
  }, payload);
  assert.deepEqual(result.initial, {token: null, payload: null, updatedAt: null});
  assert.equal(result.losingCode, 'conflict'); assert.equal(result.quota, 'QuotaExceededError');
  assert.deepEqual(result.afterFailure, result.winner);
  assert.notEqual(result.tombstone.token, result.winner.token); assert.equal(result.tombstone.payload, null);
  assert.equal(result.staleCode, 'conflict'); assert.deepEqual(result.afterStale, result.tombstone);
  await page.reload();
  const recovered = await page.evaluate(async () => { const store = await (await import('/session-store.mjs')).openSessionStore(); const row = await store.read(); store.close(); return row; });
  assert.deepEqual(recovered, result.final);
  const errors = await page.evaluate(async () => {
    const {openSessionStore} = await import('/session-store.mjs');
    const store = await openSessionStore();
    const raw = await new Promise((resolve, reject) => { const request = indexedDB.open('kristina-review-session', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const results = [];
    for (const payload of [{version: 2}, {version: 1, broken: true}]) {
      await new Promise((resolve, reject) => { const tx = raw.transaction('session', 'readwrite'); tx.objectStore('session').put({token: 'damaged-token', updatedAt: Date.now(), payload}, 'current'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      try { await store.read(); } catch (error) { results.push({code: error.code, token: error.token}); results.push((await store.clear(error.token)).payload); }
    }
    raw.close();
    const upgraded = await new Promise((resolve, reject) => { const request = indexedDB.open('kristina-review-session', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    let closedCode; try { await store.read(); } catch (error) { closedCode = error.code; }
    upgraded.close(); return {results, closedCode};
  });
  assert.deepEqual(errors.results, [{code: 'incompatible', token: 'damaged-token'}, null, {code: 'corrupt', token: 'damaged-token'}, null]);
  assert.equal(errors.closedCode, 'unavailable');
});
