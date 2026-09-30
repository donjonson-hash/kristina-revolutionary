const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { callLLM } = require("../server/llm");
const payload = { rising: [], growing: [], noise: [], action: "ok" };
const success = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }) + "\nHTTP_CODE:200";

test("curl is asynchronous, shell-free, bounded; key is private and prompt uses stdin", async () => {
  let config, input, timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  const run = (binary, args, options, callback) => {
    config = args[args.indexOf("--config") + 1];
    assert.equal(binary, "curl");
    assert.equal(args[0], "--disable");
    assert.ok(args.includes("@-"));
    assert.ok(!args.some(arg => arg.includes("fake-key") || arg.includes("private prompt")));
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 18000);
    assert.equal(options.maxBuffer, 256 * 1024);
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(config)).mode & 0o777, 0o700);
    return { stdin: { on() {}, end(value) {
      input = JSON.parse(value);
      setTimeout(() => callback(null, success), 20);
    } } };
  };
  const result = await callLLM("fake-key", "test-model", "private prompt", { run });
  clearTimeout(timer);
  assert.ok(timerFired);
  assert.deepEqual(result, payload);
  assert.equal(input.messages[0].content, "private prompt");
  assert.ok(!fs.existsSync(path.dirname(config)));
});

test("HTTP, parse and child failures remove secret files without leaking diagnostics", async () => {
  for (const output of ["{}\nHTTP_CODE:500", "broken\nHTTP_CODE:200", "{}\nHTTP_CODE:200", null]) {
    let config;
    const run = (_binary, args, _options, callback) => {
      config = args[args.indexOf("--config") + 1];
      return { stdin: { on() {}, end() {
        setImmediate(() => callback(output === null ? new Error("fake-key raw secret") : null, output));
      } } };
    };
    await assert.rejects(callLLM("fake-key", "test", "prompt", { run }), error => !error.message.includes("fake-key"));
    assert.ok(!fs.existsSync(path.dirname(config)));
  }
  await assert.rejects(callLLM('bad"\nkey', "test", "prompt"), /key format/);
});
