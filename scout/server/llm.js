const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Keep the curl transport, but never put the key or prompt in a shell/argv.
async function callLLM(apiKey, model, prompt, { run = execFile } = {}) {
  if (typeof apiKey !== "string" || !/^[A-Za-z0-9._-]{1,512}$/.test(apiKey)) throw new Error("Invalid LLM key format");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scout-llm-"));
  const config = path.join(directory, "headers.conf");
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(config, `header = "Authorization: Bearer ${apiKey}"\n`, { mode: 0o600 });
    const body = JSON.stringify({
      model, messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: 1200,
    });
    const output = await new Promise((resolve, reject) => {
      const child = run("curl", [
        "--disable", "--config", config,
        "--silent", "--show-error", "--proto", "=https", "--connect-timeout", "5", "--max-time", "15",
        "https://openrouter.ai/api/v1/chat/completions",
        "--header", "Content-Type: application/json", "--header", "X-Title: Scout Trend Agent",
        "--data-binary", "@-", "--write-out", "\nHTTP_CODE:%{http_code}",
      ], { encoding: "utf8", timeout: 18000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
      (error, stdout) => error ? reject(new Error("LLM transport failed")) : resolve(stdout));
      child.stdin.on("error", () => {}); // execFile's callback reports an early process exit.
      child.stdin.end(body);
    });
    const marker = output.lastIndexOf("\nHTTP_CODE:");
    if (marker < 0 || output.slice(marker + 11).trim() !== "200") throw new Error("LLM HTTP error");
    const envelope = JSON.parse(output.slice(0, marker));
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > 16000) throw new Error("Invalid LLM response");
    return JSON.parse(content.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { callLLM };
