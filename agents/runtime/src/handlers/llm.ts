import { spawn } from "node:child_process";
import { extractText, type Handler } from "./util.js";

interface ChatMessage {
  role: string;
  content: string;
}

/** OpenAI-compatible chat-completions handler. Input is plain text or JSON {text|prompt|messages...}. */
export const llmHandler: Handler = async (input) => {
  const baseUrl = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY;
  const systemPrompt = process.env.AGENT_PROMPT;

  // Subscription mode: no API key but a logged-in CLI (claude / codex / gemini)
  // is available in this environment. LLM_CLI is a shell command; the prompt
  // arrives on stdin and AGENT_PROMPT is exported for the command to use.
  if (!apiKey && process.env.LLM_CLI) {
    return runCli(process.env.LLM_CLI, input, systemPrompt);
  }
  if (!baseUrl || !model) {
    throw new Error("llm handler: set LLM_BASE_URL+LLM_MODEL(+LLM_API_KEY) for an API, or LLM_CLI for a logged-in CLI");
  }

  let messages: ChatMessage[];
  if (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).messages)) {
    messages = (input as { messages: ChatMessage[] }).messages;
  } else {
    messages = [{ role: "user", content: extractText(input) }];
  }
  if (systemPrompt && !messages.some((m) => m.role === "system")) {
    messages = [{ role: "system", content: systemPrompt }, ...messages];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`llm handler: upstream ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
    };
    const output = json.choices?.[0]?.message?.content ?? "";
    return { ok: true, output, model, usage: json.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
};


/** Run a logged-in CLI (subscription account) with the prompt on stdin. */
async function runCli(cmd: string, input: unknown, systemPrompt?: string): Promise<Record<string, unknown>> {
  let prompt: string;
  if (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).messages)) {
    prompt = (input as { messages: ChatMessage[] }).messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  } else prompt = extractText(input);
  const timeoutMs = Number(process.env.LLM_CLI_TIMEOUT_MS || 180_000);
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      env: { ...process.env, AGENT_PROMPT: systemPrompt ?? "", HOME: process.env.HOME || "/root" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = ""; let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`cli handler: timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code !== 0 && !text) return reject(new Error(`cli handler: exit ${code}: ${err.trim().slice(0, 400)}`));
      if (!text) return reject(new Error("cli handler: empty output"));
      resolve({ ok: true, output: text, model: process.env.LLM_MODEL || "cli", via: "subscription-cli" });
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}
