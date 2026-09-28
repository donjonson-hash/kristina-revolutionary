import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountSessionUI} from '../../extension/session-ui.mjs';

const require = createRequire(new URL('../browser/package.json', import.meta.url));
const {JSDOM} = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const payload = text => ({sources: {left: {name: 'A.txt'}, right: {name: 'B.txt'}}, text});
const error = code => Object.assign(new Error(code), {code});

async function harness(t, options = {}) {
  const dom = new JSDOM('<main id="session"></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const root = document.querySelector('main');
  let current = options.row || {token: null, payload: null};
  let serial = 0;
  const writes = [], clears = [], resumes = [];
  const store = {
    read: async () => current,
    write: async (value, token) => {
      writes.push({value, token});
      if (token !== current.token) throw error('conflict');
      return current = {token: `token-${++serial}`, payload: value};
    },
    clear: async token => {
      clears.push(token);
      if (token !== current.token) throw error('conflict');
      return current = {token: `token-${++serial}`, payload: null};
    },
    close() {},
    ...options.store,
  };
  const ui = await mountSessionUI(root, {
    openStore: async () => store,
    onResume: async value => { resumes.push(value); },
    onFinish: async () => {},
    ...options.callbacks,
  });
  t.after(() => { ui.dispose(); globalThis.document = previous; dom.window.close(); });
  return {ui, root, store, writes, clears, resumes,
    status: () => root.querySelector('#session-status').textContent,
    click: id => root.querySelector(`#${id}`).click(),
    current: () => current,
    external: value => { current = value; },
  };
}

test('session UI serializes writes, coalesces pending edits, and reports saved only after commit', async t => {
  const first = deferred(), second = deferred(), calls = [];
  const p = await harness(t, {store: {write(value, token) {
    calls.push({value, token}); return calls.length === 1 ? first.promise : second.promise;
  }}});
  let draft = payload('first'); p.ui.activate(() => draft);
  draft = payload('intermediate'); p.ui.changed();
  draft = payload('latest'); p.ui.changed();
  assert.equal(calls.length, 1);
  assert.match(p.status(), /Сохраняю/);
  first.resolve({token: 'committed-first', payload: calls[0].value});
  await tick();
  assert.deepEqual(calls[1], {value: payload('latest'), token: 'committed-first'});
  assert.match(p.status(), /Сохраняю/);
  second.resolve({token: 'committed-last', payload: calls[1].value});
  await p.ui.flush();
  assert.match(p.status(), /Сохранено/);
});

test('finish waits for queued writes then clears their latest token without resurrecting documents', async t => {
  const writing = deferred(), clears = [];
  let finished = 0;
  const p = await harness(t, {store: {
    write: () => writing.promise,
    clear: async token => { clears.push(token); return {token: 'tombstone', payload: null}; },
  }, callbacks: {onFinish: async () => { finished++; }}});
  p.ui.activate(() => payload('edited'));
  p.click('session-delete');
  assert.deepEqual(clears, []);
  writing.resolve({token: 'latest', payload: payload('edited')});
  await tick();
  assert.deepEqual(clears, ['latest']); assert.equal(finished, 1);
  p.ui.changed(); await p.ui.flush();
  assert.equal(p.root.hidden, true);
  assert.deepEqual(clears, ['latest']);
});

test('quota failure retries the latest draft and never claims the failed write was saved', async t => {
  let attempts = 0; const values = [];
  const p = await harness(t, {store: {write: async value => {
    values.push(value); if (++attempts === 1) throw error('quota');
    return {token: 'saved', payload: value};
  }}});
  let draft = payload('old'); p.ui.activate(() => draft); await p.ui.flush();
  assert.match(p.status(), /Не удалось сохранить/);
  assert.equal(p.root.querySelector('#session-retry').hidden, false);
  draft = payload('newest'); p.ui.changed(); p.click('session-retry');
  await tick(); await p.ui.flush();
  assert.deepEqual(values, [payload('old'), payload('newest')]);
  assert.match(p.status(), /Сохранено/);
});

test('a conflict cannot overwrite or delete another tab’s saved work', async t => {
  const p = await harness(t);
  p.ui.activate(() => payload('mine')); await p.ui.flush();
  p.external({token: 'other-tab', payload: payload('theirs')});
  p.ui.changed(); await p.ui.flush();
  assert.match(p.status(), /другой вкладке/);
  assert.equal(p.root.querySelector('#session-retry').hidden, true);
  p.click('session-delete'); await tick();
  assert.deepEqual(p.current(), {token: 'other-tab', payload: payload('theirs')});
  assert.equal(p.root.hidden, false);
});

test('resume rereads storage and keeps data when restoration fails', async t => {
  const p = await harness(t, {row: {token: 'original', payload: payload('old')}, callbacks: {
    onResume: async () => { throw error('invalid'); },
  }});
  p.external({token: 'latest', payload: payload('current')});
  p.click('session-resume'); await tick();
  assert.deepEqual(p.current(), {token: 'latest', payload: payload('current')});
  assert.deepEqual(p.writes, []); assert.deepEqual(p.clears, []);
  assert.match(p.status(), /Не удалось восстановить/);
  assert.equal(p.root.querySelector('#session-resume').hidden, true);
  p.click('session-delete'); await tick();
  assert.deepEqual(p.clears, ['latest']);
});

test('retry after a transient initial read failure obtains the saved token before replacing work', async t => {
  let reads = 0; const writes = [];
  const p = await harness(t, {store: {
    read: async () => {
      if (++reads === 1) throw error('unavailable');
      return {token: 'existing', payload: payload('previous')};
    },
    write: async (value, token) => {
      writes.push({value, token});
      if (token !== 'existing') throw error('conflict');
      return {token: 'updated', payload: value};
    },
  }});
  p.ui.activate(() => payload('new work'));
  p.click('session-retry'); await tick(); await p.ui.flush();
  assert.equal(reads, 2);
  assert.deepEqual(writes, [{value: payload('new work'), token: 'existing'}]);
  assert.match(p.status(), /Сохранено/);
});

test('corrupt stored data stays visible with explicit deletion using its token', async t => {
  const clears = [];
  const p = await harness(t, {store: {
    read: async () => { throw Object.assign(error('corrupt'), {token: 'broken'}); },
    clear: async token => { clears.push(token); return {token: 'clean', payload: null}; },
  }});
  assert.equal(p.root.hidden, false);
  assert.match(p.status(), /Не удалось восстановить/);
  assert.equal(p.root.querySelector('#session-resume').hidden, true);
  p.click('session-delete'); await tick();
  assert.deepEqual(clears, ['broken']); assert.equal(p.root.hidden, true);
});

for (const operation of ['resume', 'delete']) {
  for (const outcome of ['success', 'failure']) {
    test(`${operation} blocks source changes synchronously and releases them after ${outcome}`, async t => {
      const events = [], transaction = deferred();
      const row = {token: 'saved', payload: payload('original')};
      let reads = 0;
      const p = await harness(t, {row, store: {
        read: () => {
          if (++reads === 1) return Promise.resolve(row);
          events.push('read'); return transaction.promise;
        },
        clear: token => {
          assert.equal(token, 'saved');
          events.push('clear'); return transaction.promise;
        },
      }, callbacks: {
        onOperating: value => { events.push(value); },
        onResume: async () => { events.push('restored'); },
        onFinish: async () => { events.push('finished'); },
      }});
      p.click(`session-${operation}`);
      assert.deepEqual(events, [true], 'Caller must invalidate file reads before any asynchronous gap');
      await tick();
      const storageAction = operation === 'resume' ? 'read' : 'clear';
      assert.deepEqual(events, [true, storageAction]);
      assert.equal(p.root.querySelector('#session-delete').disabled, true);
      p.click(`session-${operation}`);
      assert.deepEqual(events, [true, storageAction], 'A second click must not start another operation');
      if (outcome === 'failure') transaction.reject(error('unavailable'));
      else transaction.resolve(operation === 'resume' ? row : {token: 'deleted', payload: null});
      await tick();
      const completed = operation === 'resume' ? 'restored' : 'finished';
      assert.deepEqual(events, outcome === 'success'
        ? [true, storageAction, completed, false]
        : [true, storageAction, false]);
      assert.equal(p.root.querySelector('#session-delete').disabled, false);
    });
  }
}
