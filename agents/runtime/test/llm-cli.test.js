// LLM_CLI safety (audit 2026-09-24): paid, untrusted input must not reach a CLI that still has file/shell
// tools, and the CLI child must not inherit the agent's wallet key or webhook secret.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cliToolsDisabled, cliEnv, llmHandler } from "../dist/handlers/llm.js";

test("cliToolsDisabled: only claude with --tools \"\" (or a full --disallowedTools list) counts as tool-free", () => {
  assert.equal(cliToolsDisabled('claude -p --tools "" --output-format text --system-prompt "$AGENT_PROMPT" "$(cat)"'), true);
  assert.equal(cliToolsDisabled("claude --tools '' -p"), true);
  assert.equal(cliToolsDisabled('/usr/local/bin/claude -p --tools=""'), true);
  assert.equal(cliToolsDisabled('claude -p --output-format text --system-prompt "$AGENT_PROMPT" "$(cat)"'), false, "the deployed command: tools on");
  assert.equal(cliToolsDisabled('claude -p --tools "Read"'), false);
  assert.equal(cliToolsDisabled('claude -p --disallowedTools "Read,Glob,Grep,Bash,WebFetch,Write,Edit"'), true);
  assert.equal(cliToolsDisabled('claude -p --disallowedTools "Bash"'), false);
  assert.equal(cliToolsDisabled("codex exec --skip-git-repo-check --sandbox read-only"), false);
  assert.equal(cliToolsDisabled("gemini -p"), false);
});

test("cliEnv keeps PATH/HOME/CLI auth vars and drops the wallet key and secrets", () => {
  const env = cliEnv({ PATH: "/bin", HOME: "/root", ANTHROPIC_API_KEY: "a", FERMINUX_PRIVATE_KEY: "0xdead", WEBHOOK_SECRET: "w", GATEWAY_INVOKE_SECRET: "g", LLM_API_KEY: "k" }, "be brief");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ANTHROPIC_API_KEY, "a");
  assert.equal(env.AGENT_PROMPT, "be brief");
  for (const k of ["FERMINUX_PRIVATE_KEY", "WEBHOOK_SECRET", "GATEWAY_INVOKE_SECRET", "LLM_API_KEY"]) assert.equal(env[k], undefined, k);
});

test("llm handler refuses a tool-enabled LLM_CLI unless LLM_CLI_ALLOW_TOOLS=1", async (t) => {
  const saved = { ...process.env };
  t.after(() => { for (const k of ["LLM_CLI", "LLM_API_KEY", "LLM_CLI_ALLOW_TOOLS", "FERMINUX_PRIVATE_KEY"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  delete process.env.LLM_API_KEY;
  process.env.LLM_CLI = 'cat; printf " key=%s" "$FERMINUX_PRIVATE_KEY"';
  process.env.FERMINUX_PRIVATE_KEY = "0xsecret";
  await assert.rejects(llmHandler("hello"), /refused/);
  process.env.LLM_CLI_ALLOW_TOOLS = "1";
  const out = await llmHandler("hello");
  assert.equal(out.output, "hello key=", "runs, and the child never sees the wallet key");
});

test("llm handler: an upstream error keeps the provider's body out of the message (it reaches decline reasons); the redacted body is err.detail", async (t) => {
  const KEY = "sk-proj-Ab12cd34EF56gh78";
  const server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. See https://x.example/k?key=${KEY}` } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  t.after(() => {
    server.close();
    for (const k of ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_CLI"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.LLM_MODEL = "m";
  process.env.LLM_API_KEY = KEY;
  delete process.env.LLM_CLI;
  const err = await llmHandler("hello").then(() => null, (e) => e);
  assert.ok(err, "rejects");
  assert.equal(err.message, "llm handler: upstream 401");
  assert.match(err.detail ?? "", /Incorrect API key provided: \[redacted\]/);
  assert.ok(!String(err.detail).includes(KEY));
});

test("redactSecrets: secret env values, bearer tokens, sk- keys and key= parameters", async () => {
  const { redactSecrets } = await import("../dist/handlers/util.js");
  const env = { LLM_API_KEY: "plainvalue-123456", WEBHOOK_SECRET: "whsec-abcdefgh", PORT: "8801", SHORT_KEY: "abc" };
  const out = redactSecrets("a plainvalue-123456 b whsec-abcdefgh c Bearer eyJhbGciOi.x.y d sk-ant-api03-XYZxyz123456 e ?api_key=zzz&x=1 port 8801 abc", env);
  assert.equal(out, "a [redacted] b [redacted] c Bearer [redacted] d [redacted] e ?api_key=[redacted]&x=1 port 8801 abc");
});
