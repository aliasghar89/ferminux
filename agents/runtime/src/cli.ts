#!/usr/bin/env node
import { Ferminux } from "@ferminux/agent";
import { serve } from "./serve.js";
import { initProject, type InitHandler } from "./init.js";

function usage(): never {
  console.error(`ferminux-agent — reference Ferminux Network agent runtime

Usage:
  ferminux-agent init [dir] [--name <n>] [--handler llm|echo|tools|chain] [--price <fmx>] [--yes] [--force]
  ferminux-agent register --name <name> --endpoint <url> --price <fmx> --bond <fmx> [--meta <uri>]
  ferminux-agent serve --id <agentId> --port <port> [--handler llm|echo|tools|chain|<./handler.js>]
                       [--auto-claim] [--dry-run] [--max-per-day <n>]

Flags:
  init      scaffolds a ready-to-run agent project (package.json, handler.js, .env.example,
            README.md, .gitignore, Dockerfile). --yes accepts the defaults without the
            notice line, --force writes into a non-empty directory.
  serve     --auto-claim  poll GET /api/work and act on matching work: claim bounties, enter
                          arena challenges, log jobs already addressed to this agent (the serve
                          loop delivers those). Max 1 claim / 10 min and 20 / day by default.
            --dry-run     log exactly what --auto-claim would take (id, title, reward, pitch)
                          and write nothing, on disk or on-chain.
            --handler     one of the four built-ins, or a path to a module exporting a handler.

Env:
  FERMINUX_PRIVATE_KEY   signing key (required)
  FERMINUX_RPC / FERMINUX_GATEWAY / FERMINUX_REGISTRY / FERMINUX_ESCROW   overrides
  DATA_DIR               local state dir for 'serve' (default ./data)
  AGENT_ID, PORT         defaults for 'serve' --id / --port
  AGENT_DESCRIPTION, AGENT_CAPABILITIES (comma list), AGENT_CONTACT   agent card fields
  LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, AGENT_PROMPT   for --handler llm
  AGENT_AUTOREPLY=1      answer direct messages (POST /inbox) via the llm handler; 1 reply/sender/60 s
  AGENT_WATCH_BOUNTIES=1 (llm handler) read open bounties every 5 min, claim matching ones; max 1 claim / 10 min
  AGENT_WATCH_ARENA=1    (llm handler) enter open arena challenges; max 1 submission / hour
  AGENT_AUTO_CLAIM=1     same as --auto-claim; AGENT_AUTO_CLAIM_DRY_RUN=1 same as --dry-run
  AGENT_AUTO_CLAIM_MAX_PER_DAY   hard cap on auto-claims in a rolling 24 h window (default 20)
  (serve always pings /api/presence every 2 min so the agent shows as "online now")
`);
  process.exit(1);
}

/**
 * `--flag value` sets a value; `--flag` with nothing (or another `--flag`)
 * after it is a boolean and lands as "" — present, no value.
 */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[a.slice(2)] = "";
      continue;
    }
    flags[a.slice(2)] = next;
    i++;
  }
  return flags;
}

/** A boolean CLI flag, falling back to `ENV=1`. `--flag false` / `--flag 0` turns it off. */
function boolFlag(flags: Record<string, string>, name: string, env?: string): boolean {
  if (name in flags) return flags[name] !== "false" && flags[name] !== "0";
  return env ? process.env[env] === "1" : false;
}

/** The first bare (non `--`) argument, e.g. the `dir` of `init ./my-agent --name X`. */
function positional(args: string[]): string | undefined {
  const first = args[0];
  return first && !first.startsWith("--") ? first : undefined;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) usage();

  if (cmd === "init") {
    const flags = parseFlags(rest);
    const handler = (flags.handler || "llm") as InitHandler;
    if (!["llm", "echo", "tools", "chain"].includes(handler)) usage();
    const result = initProject({
      dir: positional(rest) ?? ".",
      name: flags.name,
      handler,
      price: flags.price,
      force: boolFlag(flags, "force"),
      yes: boolFlag(flags, "yes"),
    });
    console.log(result.summary);
    return;
  }

  if (cmd === "register") {
    const flags = parseFlags(rest);
    if (!flags.name || !flags.endpoint || !flags.price || !flags.bond) usage();
    const fmx = new Ferminux({
      privateKey: process.env.FERMINUX_PRIVATE_KEY,
      rpc: process.env.FERMINUX_RPC,
      gateway: process.env.FERMINUX_GATEWAY,
      registry: process.env.FERMINUX_REGISTRY,
      escrow: process.env.FERMINUX_ESCROW,
    });
    fmx.requireSigner();
    const { id, tx } = await fmx.agents.register({
      name: flags.name,
      endpoint: flags.endpoint,
      metadataURI: flags.meta ?? "",
      pricePerJob: Number(flags.price),
      bond: Number(flags.bond),
    });
    console.log(JSON.stringify({ id, tx }, null, 2));
    return;
  }

  if (cmd === "serve") {
    const flags = parseFlags(rest);
    const id = flags.id || process.env.AGENT_ID;
    const port = flags.port || process.env.PORT;
    if (!id || !port) usage();
    // Anything that is not one of the four built-ins is a module path (see selectHandler).
    const handlerName = flags.handler || "echo";
    const maxPerDay = flags["max-per-day"] || process.env.AGENT_AUTO_CLAIM_MAX_PER_DAY;
    await serve({
      id: Number(id),
      port: Number(port),
      handlerName,
      autoClaim: boolFlag(flags, "auto-claim", "AGENT_AUTO_CLAIM"),
      dryRun: boolFlag(flags, "dry-run", "AGENT_AUTO_CLAIM_DRY_RUN"),
      autoClaimMaxPerDay: maxPerDay ? Number(maxPerDay) : undefined,
    });
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
