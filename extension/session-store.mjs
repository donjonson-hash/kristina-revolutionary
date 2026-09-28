/* One local review, with transaction-level ownership across extension tabs. */
const DB_NAME = 'kristina-review-session', STORE = 'session', KEY = 'current';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024, MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message, details = {}) => Object.assign(new Error(message), {code, ...details});
const tokenOf = row => typeof row?.token === 'string' ? row.token : null;
const empty = () => ({token: null, payload: null, updatedAt: null});

/** Validate and detach the snapshot before an asynchronous write can start. */
export function validateSessionPayload(payload) {
  if (!object(payload)) throw failure('invalid', 'Не удалось сохранить работу: неверные данные.');
  if (payload.version !== 1) throw failure('incompatible', 'Эта работа сохранена другой версией Кристины.');
  const invalid = () => { throw failure('invalid', 'Не удалось сохранить работу: неверные данные.'); };
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
  if (report.kind !== 'text' || report.status !== 'complete' || !object(report.sources)) invalid();
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
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { invalid(); }
  if (serialized.length > MAX_PAYLOAD_BYTES || new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) throw failure('invalid', 'Работа слишком большая для сохранения.');
  return JSON.parse(serialized);
}

function checkedRow(row) {
  if (row === undefined) return empty();
  const token = tokenOf(row);
  if (!object(row) || !token || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 || !Object.hasOwn(row, 'payload')) throw failure('corrupt', 'Сохранённую работу не удалось прочитать. Её можно удалить.', {token});
  if (row.payload !== null) {
    try { row.payload = validateSessionPayload(row.payload); }
    catch (error) { throw failure(error.code === 'incompatible' ? 'incompatible' : 'corrupt', error.code === 'incompatible' ? error.message : 'Сохранённую работу не удалось прочитать. Её можно удалить.', {token, updatedAt: row.updatedAt}); }
  }
  return {token, payload: row.payload, updatedAt: row.updatedAt};
}

export async function openSessionStore({indexedDB = globalThis.indexedDB} = {}) {
  if (!indexedDB?.open) throw failure('unavailable', 'Браузер не разрешает сохранять работу на этом устройстве.');
  const db = await new Promise((resolve, reject) => {
    let request, settled = false;
    try { request = indexedDB.open(DB_NAME, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onerror = () => { settled = true; reject(request.error); };
    request.onblocked = () => { settled = true; reject(failure('blocked', 'Закройте другие окна Кристины и попробуйте снова.')); };
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
  });
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };

  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(failure('unavailable', 'Сохранение недоступно. Откройте Кристину заново.')); return; }
      let tx, result, reason;
      try { tx = db.transaction(STORE, mode); } catch (error) { reject(error); return; }
      const abort = error => { reason = error; try { tx.abort(); } catch { reject(error); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(reason || tx.error || failure('unavailable', 'Не удалось сохранить работу.'));
      // Request errors abort the entire transaction; never expose a partial save.
      tx.onerror = () => {};
      try { action(tx.objectStore(STORE), value => { result = value; }, abort); } catch (error) { abort(error); }
    });
  }
  async function read() {
    const row = await transaction('readonly', (store, done) => { const request = store.get(KEY); request.onsuccess = () => done(request.result); });
    return checkedRow(row);
  }
  function replace(payload, expectedToken) {
    if (expectedToken !== null && typeof expectedToken !== 'string') return Promise.reject(failure('conflict', 'Эта работа изменилась в другом окне. Откройте сохранённую версию заново.'));
    return transaction('readwrite', (store, done, abort) => {
      const request = store.get(KEY);
      request.onsuccess = () => {
        try {
          if (tokenOf(request.result) !== expectedToken) { abort(failure('conflict', 'Эта работа изменилась в другом окне. Откройте сохранённую версию заново.')); return; }
          const row = {token: globalThis.crypto.randomUUID(), payload, updatedAt: Date.now()};
          store.put(row, KEY); done(row);
        } catch (error) { abort(error); }
      };
    });
  }
  return {read, async write(payload, expectedToken) { return replace(validateSessionPayload(payload), expectedToken); }, clear(expectedToken) { return replace(null, expectedToken); }, close};
}
