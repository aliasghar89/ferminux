import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDNodeWallet } from "ethers";
import { loadConfig } from "../dist/config.js";
import { makeLogger } from "../dist/log.js";
import { Runner } from "../dist/runner.js";
import { makeRng } from "../dist/amounts.js";
import { FakeChain, fakeFetch } from "./fakechain.mjs";

export const PHRASE = "test test test test test test test test test test test junk";
export const SINK = "0xD7175A244a3Eab83f574135318d037Fb6221C358";
export const WEI = 10n ** 18n;

export function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "fxlt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function testEnv(dir, over = {}) {
  return {
    LOADTEST_ENABLED: "true", LOADTEST_ALLOW_HIGH_RATE: "1", RPC_URL: "http://fake", STATUS_URL: "http://gw/api/status",
    EXPLORER_API: "http://explorer/api/v2", SINK, WALLETS: "40", RATE_TX_PER_S: "100", WAVE_SIZE: "8", MAX_ACTIVE_WAVES: "3",
    MAX_FLOAT_IN_FLIGHT_FMX: "40", FLOAT_RESERVE_FMX: "5", FLOAT_MIN_FMX: "1", SINK_SWEEP_INTERVAL_S: "30", SINK_SWEEP_MIN_FMX: "1",
    LOOP: "false", GUARD_INTERVAL_S: "2", INDEX_READ_INTERVAL_S: "2", ORGANIC_CONFIRMATIONS: "2", RECEIPT_TIMEOUT_S: "20", STUCK_AFTER_S: "30", DATA_DIR: join(dir, "data"), PUBLIC_DIR: join(dir, "public"),
    PUBLISH_INTERVAL_S: "1", TICK_MS: "100", ...over,
  };
}

export function world(t, over = {}, chainOpts = {}) {
  const dir = tmp(t);
  let now = 1_790_000_000_000;
  const clock = () => now;
  const chain = new FakeChain({ clock, ...chainOpts });
  const fetchOpts = { explorerLag: 0, explorerDown: false, gatewayActive: null };
  const lines = [];
  const env = testEnv(dir, over);
  const make = (seed = 7) => {
    const cfg = loadConfig(env);
    const log = makeLogger("debug", (l) => lines.push(l));
    log.secret(PHRASE);
    return new Runner(cfg, PHRASE, { rpc: chain, log, fetchImpl: fakeFetch(chain, fetchOpts), nowMs: clock, sleep: async () => {}, rng: makeRng(seed) });
  };
  const advance = (ms) => { now += ms; };
  return { dir, chain, clock, advance, make, lines, fetchOpts, env };
}

/** Tick the runner, advance time 250 ms per tick, make a block every `blockEvery` ticks. */
export async function drive(w, runner, { until, maxTicks = 20_000, blockEvery = 4, stepMs = 250, onTick } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    await runner.tick();
    w.advance(stepMs);
    if (i % blockEvery === 0) w.chain.confirmBlock();
    if (onTick) await onTick(i);
    if (until && until(runner)) return i;
  }
  throw new Error(`drive: condition not reached in ${maxTicks} ticks (mode ${runner.mode}, pass ${runner.s.pass}, next ${runner.s.nextIndex}, waves ${runner.s.waves.length}, pending ${runner.s.pending.length})`);
}

export const addrOf = (i) => HDNodeWallet.fromPhrase(PHRASE, undefined, `m/44'/60'/7'/0/${i}`).address;
