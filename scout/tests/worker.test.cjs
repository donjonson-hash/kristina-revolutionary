const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const root = path.join(__dirname, "../extension");
const initial = new Date(2026, 8, 30, 12).getTime();
const profile = () => ({ niche: "AI tools", topics: ["LLM"], frequency: "daily",
  quietHours: { from: "22:00", to: "08:00" }, onboarded: true });
const digest = () => ({ id: "d1", createdAt: new Date(initial).toISOString(),
  sections: { rising: [{ title: "Signal", url: "https://example.org/", why: "Relevant" }],
    growing: [], noise: [], action: "Review" }, meta: { status: "complete", signalsFound: 1 } });
function worker({ data = { profile: profile() }, fetchImpl, notifyFails = false, now = initial } = {}) {
  let currentTime = now, calls = 0;
  const notices = [], alarms = [], listeners = {};
  const context = vm.createContext({
    URL, AbortSignal, crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [currentTime])); }
      static now() { return currentTime; }
    },
    async fetch(...args) {
      calls++;
      return fetchImpl ? fetchImpl(...args) : new Response(JSON.stringify(digest()));
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])));
          },
          async set(values) { Object.assign(data, structuredClone(values)); },
        },
        onChanged: { addListener(fn) { listeners.changed = fn; } },
      },
      runtime: {
        getURL: file => "chrome-extension://test/" + file,
        onInstalled: { addListener(fn) { listeners.installed = fn; } },
        onStartup: { addListener(fn) { listeners.startup = fn; } },
        onMessage: { addListener(fn) { listeners.message = fn; } },
      },
      sidePanel: { async setPanelBehavior() {} },
      alarms: {
        async create(name, options) { alarms.push({ name, ...options }); },
        async clear() {},
        onAlarm: { addListener(fn) { listeners.alarm = fn; } },
      },
      notifications: { async create(options) {
        notices.push(options);
        if (notifyFails) throw new Error("denied");
      } },
    },
  });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  return { data, notices, alarms, listeners, calls: () => calls, setTime: value => { currentTime = value; },
    run: code => vm.runInContext(code, context) };
}

test("simultaneous triggers issue one request and clear their claim", async () => {
  const w = worker();
  const results = await Promise.all(Array.from({ length: 5 }, () => w.run("maybeGenerateDigest(true)")));
  assert.equal(w.calls(), 1);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(w.data.claim, null);
  assert.equal(w.data.digests.length, 1);
  assert.equal(w.data.digests[0].profile.niche, "AI tools");
  assert.ok(w.notices[0].iconUrl.endsWith("/icon.png"));
});

test("outage preserves previous success, emits no ready notification and schedules retry", async () => {
  const previous = initial - 86400000;
  const w = worker({ data: { profile: profile(), lastDigestAt: previous, digests: [digest()] },
    fetchImpl: async () => { throw new Error("offline"); } });
  const result = await w.run("maybeGenerateDigest(true)");
  assert.equal(result.ok, false);
  assert.equal(w.data.lastDigestAt, previous);
  assert.equal(w.data.digests.length, 1);
  assert.equal(w.notices.length, 0);
  assert.equal(w.data.retryAt, initial + 5 * 60000);
  assert.equal(w.data.claim, null);
  await w.run("maybeGenerateDigest()");
  assert.equal(w.calls(), 1);
});

test("expired and legacy claims recover; live claims block and set wakeup", async () => {
  for (const claim of [{ active: true, claimedAt: 1 }, { active: true, token: "old", expiresAt: initial - 1 }]) {
    const w = worker({ data: { profile: profile(), claim } });
    assert.equal((await w.run("maybeGenerateDigest(true)")).ok, true);
  }
  const w = worker({ data: { profile: profile(), claim: { active: true, expiresAt: initial + 35000 } } });
  assert.equal((await w.run("maybeGenerateDigest(true)")).reason, "busy");
  assert.equal(w.calls(), 0);
  assert.equal(w.alarms.at(-1).when, initial + 35000);
});

test("daily/three-day schedules and quiet-hours overnight rollover", async () => {
  const p = profile(); p.frequency = "every_3_days";
  const w = worker({ data: { profile: p, lastDigestAt: initial } });
  await w.run("scheduleNext()");
  assert.equal(w.alarms.at(-1).when, initial + 3 * 86400000);
  assert.equal((await w.run("maybeGenerateDigest()")).reason, "not_due");
  const night = new Date(2026, 8, 30, 23).getTime();
  w.setTime(night);
  assert.equal(w.run(`afterQuietHours(${JSON.stringify(p)}, ${night})`), new Date(2026, 9, 1, 8).getTime());
  assert.equal((await w.run("maybeGenerateDigest()")).reason, "quiet_hours");
  assert.equal((await w.run("maybeGenerateDigest(true)")).ok, true);
});

test("notification failure does not undo successful digest or trigger backend retry", async () => {
  const w = worker({ notifyFails: true });
  assert.equal((await w.run("maybeGenerateDigest(true)")).ok, true);
  assert.equal(w.data.lastDigestAt, initial);
  assert.equal(w.data.retryAt, null);
  assert.ok(w.data.notificationError);
});

test("malformed server result cannot overwrite previous digest", async () => {
  const bad = digest(); bad.sections.rising[0].url = "javascript:alert(1)";
  const w = worker({ fetchImpl: async () => new Response(JSON.stringify(bad)) });
  assert.equal((await w.run("maybeGenerateDigest(true)")).ok, false);
  assert.equal(w.data.lastDigestAt, undefined);
  assert.equal(w.data.digests, undefined);
});

test("profile changed during generation discards the stale result", async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const w = worker({ fetchImpl: async () => {
    started(); await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(digest()));
  } });
  const run = w.run("maybeGenerateDigest(true)");
  await ready;
  w.data.profile.niche = "Another niche";
  release();
  assert.equal((await run).reason, "profile_changed");
  assert.equal(w.data.digests, undefined);
  assert.equal(w.data.claim, null);
});

test("storage validation and message bridge expose failures honestly", async () => {
  const w = worker({ fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(w.run('storage.saveProfile({topics: []})'));
  const result = await new Promise(resolve => {
    assert.equal(w.listeners.message({ type: "SCOUT_GENERATE_NOW", force: true }, {}, resolve), true);
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "backend_error");
  assert.ok(w.listeners.startup && w.listeners.changed);
});

test("new worker recovers expired lease and old response cannot replace new result", async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const data = { profile: profile() };
  const old = worker({ data, fetchImpl: async () => {
    started(); await new Promise(resolve => { release = resolve; });
    const stale = digest(); stale.id = "stale";
    return new Response(JSON.stringify(stale));
  } });
  const pending = old.run("maybeGenerateDigest(true)");
  await ready;
  const fresh = worker({ data, now: initial + 36000 });
  assert.equal((await fresh.run("maybeGenerateDigest(true)")).ok, true);
  release(); await pending;
  assert.equal(data.digests.length, 1);
  assert.equal(data.digests[0].id, "d1");
});
