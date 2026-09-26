// Entry point: node dist/main.js
//   DATA_DIR    private volume: seed.txt (0600, created on first start), state.json, HALT / DRAIN files
//   PUBLIC_DIR  public volume: stats.json, addresses.bin (read-only in the gateway)
// Dry-run unless LOADTEST_ENABLED=true. SIGTERM/SIGINT stop after the current tick (state is saved).
import { loadConfig } from "./config.js";
import { makeLogger } from "./log.js";
import { Rpc } from "./rpc.js";
import { Runner } from "./runner.js";
import { loadOrCreateSeed } from "./wallets.js";

async function main() {
  const cfg = loadConfig();
  const log = makeLogger(cfg.logLevel);
  const { phrase, created } = loadOrCreateSeed(cfg.seedFile);
  log.secret(phrase);
  if (created) log.info("seed created", { file: cfg.seedFile, mode: "0600" });
  const rpc = new Rpc(cfg.rpcUrl);
  const runner = new Runner(cfg, phrase, { rpc, log });
  const stop = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { log.info("signal", { sig }); stop.abort(); });
  await runner.run(stop.signal);
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "fatal", error: (e as Error).message }) + "\n");
  process.exit(1);
});
