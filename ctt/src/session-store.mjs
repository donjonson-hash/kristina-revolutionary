/* One local review, with transaction-level ownership across extension tabs. */
const DB_NAME = 'kristina-review-session', STORE = 'session', KEY = 'current';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024, MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message, details = {}) => Object.assign(new Error(message), {code, ...details});
const tokenOf = row => typeof row?.token === 'string' ? row.token : null;
const empty = () => ({token: null, payload: null, updatedAt: null});

/** Validate and detach the snapshot before an asynchronous write can start. */
export function validateSessionPayload(payload) {
  if (!object(payload)) throw failure('invalid', "Could not save your work: invalid data.");
  if (payload.version !== 1) throw failure('incompatible', "This work was saved by a different version of Compare These Texts.");
  const invalid = () => { throw failure('invalid', "Could not save your work: invalid data."); };
  if (!object(payload.sources) || !object(payload.review) || !object(payload.report)) invalid();
  for (const side of ['left', 'right']) {
    const source = payload.sources[side];
    if (!object(source) || typeof source.name !== 'string' || !source.name.length || source.name.length > 4096 || typeof source.data !== 'string') invalid();
    const data = source.data;
    if (data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid();
    const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_SOURCE_BYTES) invalid();
  }
  const report = payload.report;
  if (report.kind === 'text') {
  if (report.status !== 'complete' || !object(report.sources)) invalid();
  for (const side of ['left', 'right']) if (!object(report.sources[side]) || !['txt', 'pdf', 'docx'].includes(report.sources[side].format)) invalid();
  let count = 0;
  const keys = new Set();
  for (const category of ['matched', 'changed', 'only_left', 'only_right', 'moved', 'reflow']) {
    const groups = report[category];
    if (groups === undefined && ['moved', 'reflow'].includes(category)) continue;
    if (!Array.isArray(groups) || (count += groups.length) > 4000) invalid();
    for (const group of groups) {
      if (!object(group) || typeof group.key !== 'string' || !/^text-\d+$/.test(group.key) || keys.has(group.key)) invalid();
      keys.add(group.key);
      const blocks = category === 'only_left' || category === 'only_right' ? [group.row] : [group.left, group.right];
      for (const block of blocks) {
        if (!object(block) || typeof block.text !== 'string' || !Number.isSafeInteger(block.record) || block.record < 1) invalid();
        if (block.source_blocks !== undefined && (!Array.isArray(block.source_blocks) || block.source_blocks.length > 2000 || block.source_blocks.some(part => !object(part) || typeof part.text !== 'string' || !Number.isSafeInteger(part.record) || part.record < 1))) invalid();
      }
    }
  }
  } else {
    if (report.kind !== undefined || report.status !== 'complete' || !object(report.sources) || !object(report.rules) || payload.review.kind !== 'sheet') invalid();
    if (!Array.isArray(report.rules.key) || report.rules.key.length !== 2 || !Array.isArray(report.rules.fields) || report.rules.fields.length > 200 || ![',',';','\t'].includes(report.rules.delimiter)) invalid();
    for (const side of ['left','right']) {
      const meta=report.sources[side];
      if (!object(meta) || ![undefined,'csv','xlsx'].includes(meta.format) || !Array.isArray(meta.headers) || !meta.headers.length || meta.headers.length > 200 || meta.headers.some(h=>typeof h!=='string') || new Set(meta.headers).size!==meta.headers.length) invalid();
    }
    let count=0; const keys=new Set();
    for (const category of ['matched','changed','only_left','only_right']) {
      if (!Array.isArray(report[category]) || (count+=report[category].length)>10000) invalid();
      for (const group of report[category]) {
        if (!object(group) || typeof group.key!=='string' || keys.has(group.key)) invalid(); keys.add(group.key);
        const blocks=category.startsWith('only_')?[group.row]:[group.left,group.right];
        for (const block of blocks) if (!object(block) || !Number.isSafeInteger(block.record) || block.record<2 || !object(block.values) || Object.values(block.values).some(v=>typeof v!=='string')) invalid();
      }
    }
  }
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { invalid(); }
  if (serialized.length > MAX_PAYLOAD_BYTES || new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) throw failure('invalid', "This work is too large to save.");
  return JSON.parse(serialized);
}

function checkedRow(row, validatePayload = validateSessionPayload) {
  if (row === undefined) return empty();
  const token = tokenOf(row);
  if (!object(row) || !token || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 || !Object.hasOwn(row, 'payload')) throw failure('corrupt', "Could not read the saved work. You can delete it.", {token});
  if (row.payload !== null) {
    try { row.payload = validatePayload(row.payload); }
    catch (error) { throw failure(error.code === 'incompatible' ? 'incompatible' : 'corrupt', error.code === 'incompatible' ? error.message : "Could not read the saved work. You can delete it.", {token, updatedAt: row.updatedAt}); }
  }
  return {token, payload: row.payload, updatedAt: row.updatedAt};
}

export async function openSessionStore({indexedDB = globalThis.indexedDB, dbName = DB_NAME, validatePayload = validateSessionPayload} = {}) {
  if (!indexedDB?.open) throw failure('unavailable', "Your browser does not allow saving work on this device.");
  const db = await new Promise((resolve, reject) => {
    let request, settled = false;
    try { request = indexedDB.open(dbName, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onerror = () => { settled = true; reject(request.error); };
    request.onblocked = () => { settled = true; reject(failure('blocked', "Close other Compare These Texts windows and try again.")); };
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
  });
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };

  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(failure('unavailable', "Saving is unavailable. Reopen Compare These Texts.")); return; }
      let tx, result, reason;
      try { tx = db.transaction(STORE, mode); } catch (error) { reject(error); return; }
      const abort = error => { reason = error; try { tx.abort(); } catch { reject(error); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(reason || tx.error || failure('unavailable', "Could not save your work."));
      // Request errors abort the entire transaction; never expose a partial save.
      tx.onerror = () => {};
      try { action(tx.objectStore(STORE), value => { result = value; }, abort); } catch (error) { abort(error); }
    });
  }
  async function read() {
    const row = await transaction('readonly', (store, done) => { const request = store.get(KEY); request.onsuccess = () => done(request.result); });
    return checkedRow(row, validatePayload);
  }
  function replace(payload, expectedToken) {
    if (expectedToken !== null && typeof expectedToken !== 'string') return Promise.reject(failure('conflict', "This work changed in another window. Reopen the saved version."));
    return transaction('readwrite', (store, done, abort) => {
      const request = store.get(KEY);
      request.onsuccess = () => {
        try {
          if (tokenOf(request.result) !== expectedToken) { abort(failure('conflict', "This work changed in another window. Reopen the saved version.")); return; }
          const row = {token: globalThis.crypto.randomUUID(), payload, updatedAt: Date.now()};
          store.put(row, KEY); done(row);
        } catch (error) { abort(error); }
      };
    });
  }
  return {read, async write(payload, expectedToken) { return replace(validatePayload(payload), expectedToken); }, clear(expectedToken) { return replace(null, expectedToken); }, close};
}
