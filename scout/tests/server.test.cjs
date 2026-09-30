const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const http = require("node:http");
const localRequire = createRequire(require.resolve("../server/package.json"));
const { createApp, groundedClassification, collectSignals } = require("../server/server");
const ID = "a".repeat(32);
const input = { niche: "AI tools", topics: ["LLM"] };
const json = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const signal = { title: "LLM release", url: "https://example.org/original", source: "hackernews", score: 250 };
function sources({ empty = false, fail = false } = {}) {
  return async (url, options) => {
    assert.ok(options.signal);
    if (fail) throw new Error("mock failure");
    if (url.includes("reddit.com")) return json({ data: { children: [] } });
    if (url.endsWith("topstories.json")) return json(empty ? [] : [1]);
    return json({ id: 1, ...signal });
  };
}
async function api(t, options = {}) {
  assert.match(localRequire("express/package.json").version, /^4\./);
  const app = createApp({ apiKey: "", model: "", extensionId: ID, fetchImpl: sources(), ...options });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, get: path => fetch(base + path),
    post: (body, path = "/digest", headers = {}) => fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Scout-Client": "1", ...headers },
      body: JSON.stringify(body),
    }),
  };
}

test("bad topics/niche return 400 and real Express 4 stays alive", async t => {
  const app = await api(t);
  for (const topics of [[], [123], ["constructor"], [" constructor "], ["__proto__"], [null], Array(8).fill("LLM")]) {
    assert.equal((await app.post({ ...input, topics })).status, 400);
    assert.equal((await app.get("/health")).status, 200);
  }
  for (const niche of [null, 1, {}, "a", "x".repeat(501)]) {
    assert.equal((await app.post({ ...input, niche })).status, 400);
  }
});

test("host, Origin, content type and required header define local client boundary", async t => {
  const app = await api(t);
  assert.equal((await app.post(input, "/digest", { Origin: "https://evil.invalid" })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(app.base + "/health", { headers: { Host: "evil.invalid" } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await app.post(input, "/digest", { "X-Scout-Client": "" })).status, 403);
  assert.equal((await app.post(input, "/digest", { "Content-Type": "text/plain" })).status, 403);
  const response = await app.post(input, "/digest", { Origin: `chrome-extension://${ID}` });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), `chrome-extension://${ID}`);
  const denied = await fetch(app.base + "/digest", {
    method: "OPTIONS", headers: { Origin: "https://evil.invalid", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(denied.status, 403);
});

test("body parser errors have stable bounded responses", async t => {
  const app = await api(t);
  const response = await fetch(app.base + "/digest", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Scout-Client": "1" }, body: "{broken",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
  assert.equal((await app.post({ ...input, niche: "x".repeat(20000) })).status, 413);
});

test("keyword fallback preserves evidence and probe remains deterministic", async t => {
  const app = await api(t);
  const result = await (await app.post(input)).json();
  assert.equal(result.meta.llm, false);
  assert.equal(result.sections.rising[0].url, signal.url);
  assert.equal(result.sections.rising[0].title, signal.title);
  assert.ok((await (await app.post({ niche: "AI tools" }, "/probe")).json()).topics.includes("LLM"));
});

test("LLM selects IDs; all factual fields come from source, not model", async t => {
  const app = await api(t, { apiKey: "fake-key", model: "test-model", llm: async (_key, _model, prompt) => {
    assert.ok(prompt.includes('"id":"s1"'));
    return { rising: [{ id: "s1", why: "Relevant" }], growing: [], noise: [], action: "Review this signal" };
  } });
  const result = await (await app.post(input)).json();
  assert.equal(result.meta.llm, true);
  assert.equal(result.sections.rising[0].url, signal.url);
  assert.equal(result.sections.rising[0].score, 250);
});

test("unknown IDs, duplicates, injected URLs and wrong shapes cannot become LLM evidence", async t => {
  const valid = { rising: [{ id: "s1", why: "Relevant" }], growing: [], noise: [], action: "Review" };
  const invalid = [
    { ...valid, rising: {} }, { ...valid, action: {} },
    { ...valid, rising: [{ id: "s99", why: "Invented" }] },
    { ...valid, rising: [{ id: "s1", why: "x", url: "https://invented.invalid" }] },
    { ...valid, growing: [{ id: "s1", why: "duplicate" }] },
    { ...valid, rising: Array(4).fill({ id: "s1", why: "x" }) },
  ];
  for (const value of invalid) assert.throws(() => groundedClassification(value, [signal]));
  const app = await api(t, { apiKey: "fake-key", model: "test", llm: async () => invalid[3] });
  const result = await (await app.post(input)).json();
  assert.equal(result.meta.llm, false);
  assert.equal(result.meta.llmFailed, true);
  assert.equal(result.sections.rising[0].url, signal.url);
});

test("empty sources skip LLM; source outages are not no-data successes", async t => {
  let calls = 0;
  const app = await api(t, { fetchImpl: sources({ empty: true }), apiKey: "fake-key", model: "test",
    llm: async () => { calls++; throw new Error("must not run"); } });
  const result = await (await app.post(input)).json();
  assert.equal(calls, 0);
  assert.equal(result.meta.status, "no_data");
  assert.deepEqual(result.sections.rising, []);
  const broken = await api(t, { fetchImpl: sources({ fail: true }) });
  assert.equal((await broken.post(input)).status, 503);
});

test("one digest at a time, bounded rate, and health is responsive during async LLM", async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let now = 100000;
  const app = await api(t, { now: () => now, apiKey: "fake-key", model: "test", llm: async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
    throw new Error("mock failure");
  } });
  const first = app.post(input);
  await ready;
  assert.equal((await app.get("/health")).status, 200);
  assert.equal((await app.post(input)).status, 429);
  release();
  assert.equal((await first).status, 200);
  const limited = await api(t, { now: () => now });
  for (let i = 0; i < 5; i++) assert.equal((await limited.post(input)).status, 200);
  assert.equal((await limited.post(input)).status, 429);
  now += 60001;
  assert.equal((await limited.post(input)).status, 200);
});

test("collector bounds source bytes and drops unsafe/duplicate URLs", async () => {
  const big = await collectSignals(["LLM"], async () => new Response("x".repeat(1024 * 1024 + 1)));
  assert.equal(big.signals.length, 0);
  assert.ok(big.errors.length);
  const result = await collectSignals([], async url => url.endsWith("topstories.json") ? json([1, 2, 3]) :
    json({ ...signal, url: url.includes("/3.") ? "javascript:alert(1)" : signal.url }));
  assert.equal(result.signals.length, 1);
});
