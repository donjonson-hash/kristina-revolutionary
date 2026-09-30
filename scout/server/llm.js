const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function callLLM(apiKey, model, prompt) {
  const body = JSON.stringify({
    model: model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
    max_tokens: 1200,
  });

  const tmpFile = path.join(os.tmpdir(), `scout-llm-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, body);

  try {
    const cmd = `curl -s -w '\\nHTTP_CODE:%{http_code}' https://openrouter.ai/api/v1/chat/completions \\
      -H "Authorization: Bearer ${apiKey}" \\
      -H "Content-Type: application/json" \\
      -H "HTTP-Referer: https://scout-trend.local" \\
      -H "X-Title: Scout Trend Agent" \\
      -d @${tmpFile}`;

    const output = execSync(cmd, { encoding: "utf8", timeout: 30000 });
    const parts = output.trim().split("\nHTTP_CODE:");
    const bodyText = parts[0];
    const status = parseInt(parts[1] || "0");

    console.log("[llm] status:", status, "preview:", bodyText.slice(0, 200));
    if (status !== 200) throw new Error("HTTP " + status);

    const parsed = JSON.parse(bodyText);
    const content = parsed.choices?.[0]?.message?.content || "";
    const jsonText = content.replace(/^```json\s*/, "").replace(/```\s*$/, "").trim();
    const result = JSON.parse(jsonText);
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

module.exports = { callLLM };
