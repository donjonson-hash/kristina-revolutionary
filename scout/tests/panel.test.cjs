const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { JSDOM } = createRequire(require.resolve("../server/package.json"))("jsdom");
const root = path.join(__dirname, "../extension");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function panel(t, data) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "sidepanel.html"), "utf8"), {
    runScripts: "outside-only", url: "https://extension.invalid/",
  });
  t.after(() => dom.window.close());
  let changed;
  dom.window.chrome = {
    storage: {
      local: {
        async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]))); },
        async set(values) { Object.assign(data, structuredClone(values)); },
      },
      onChanged: { addListener(fn) { changed = fn; } },
    },
    runtime: { async sendMessage() { return { ok: false, reason: "busy" }; } },
  };
  for (const file of ["storage.js", "sidepanel.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), dom.getInternalVMContext());
  }
  await tick();
  return { window: dom.window, document: dom.window.document, changed: (...args) => changed(...args) };
}
test("panel escapes text/attributes, rejects unsafe URLs and updates on storage change", async t => {
  const data = { profile: { niche: '<img src=x onerror="boom">', topics: ["LLM"], onboarded: true },
    digests: [{ createdAt: new Date().toISOString(), profile: { niche: "Original niche" }, sections: {
      rising: [{ title: '<script>boom</script>', url: 'javascript:alert(1)' }],
      growing: [{ title: "safe", url: 'https://example.org/a" onclick="boom' }],
      noise: [], action: "Actual recommendation",
    } }] };
  const p = await panel(t, data);
  assert.equal(p.document.querySelectorAll("#digestContent script, #digestContent img, #digestContent [onclick]").length, 0);
  assert.equal(p.document.querySelectorAll("#digestContent a").length, 1);
  assert.ok(p.document.getElementById("digestContent").textContent.includes("Actual recommendation"));
  assert.ok(p.document.getElementById("digestContent").textContent.includes("Original niche"));
  assert.ok(!p.document.getElementById("digestContent").textContent.includes(data.profile.niche));
  data.lastError = "Retry later";
  p.changed({ lastError: {} }, "local"); await tick();
  assert.equal(p.document.getElementById("digestStatus").textContent, "Retry later");
  await p.window.requestDigest();
  assert.ok(p.document.getElementById("digestStatus").textContent.includes("уже выполняется"));
  assert.equal(p.document.querySelector('[data-action="generate"]').disabled, false);
});
test("onboarding refuses empty topics and settings preserve frequency and quiet hours", async t => {
  const data = { profile: { niche: "AI tools", topics: ["LLM"], onboarded: false,
    frequency: "every_3_days", quietHours: { from: "21:00", to: "09:00" } } };
  const p = await panel(t, data);
  p.document.getElementById("niche").value = "AI tools";
  await p.window.finishOnboarding();
  assert.ok(p.document.getElementById("profileError").textContent);
  assert.equal(data.profile.onboarded, false);
  await p.window.resetOnboarding();
  assert.equal(p.document.getElementById("frequency").value, "every_3_days");
  assert.equal(p.document.getElementById("quietFrom").value, "21:00");
  await p.window.finishOnboarding();
  assert.equal(data.profile.onboarded, true);
});
test("manifest points at packaged classic worker and notification icon", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.background.type, undefined);
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1/*"));
  assert.ok(fs.existsSync(path.join(root, manifest.icons["128"])));
  assert.ok(!/\sonclick\s*=/.test(fs.readFileSync(path.join(root, "sidepanel.html"), "utf8")));
});
