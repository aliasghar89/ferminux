// Wizrd's labelled network load test (agents/loadtest): the public, read-only side.
//
//   GET /api/loadtest/stats           the runner's counters (transactions, per day, addresses, volume, gas,
//                                     float, last pause), for the explorer's organic numbers and anyone else
//   GET /api/loadtest/address/:addr   { loadtest: true|false, index, role } — is this a load-test wallet?
//   GET /api/loadtest/manifest        the disclosure (nginx serves it as /.well-known/wizrd-loadtest.json)
//
// The runner writes stats.json and addresses.bin (20 bytes per wallet, index 0 = the float) to its public
// volume, mounted read-only here at LOADTEST_DIR (default /loadtest). Membership is an in-memory map built
// from addresses.bin up to the highest activated index; every newly loaded range is spot-checked against
// the published xpub (BIP-32 public derivation), so the file cannot claim an address the seed does not own.
// No key, seed or private state is ever read here. CORS: the gateway answers every route with
// access-control-allow-origin: * (explorer.ferminux.net reads these from the browser).
import type { FastifyInstance } from "fastify";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { HDNodeWallet, getAddress } from "ethers";

export const LOADTEST_MARKER = "0x46584c54";
export const LOADTEST_MARKER_DATA = "0x46584c5401";
const RELOAD_MS = 2000;

interface RunnerStats {
  schema?: string;
  mode?: string;
  startedAt?: number | null;
  sink?: string;
  float?: { address?: string };
  derivation?: { path?: string; xpub?: string };
  wallets?: { planned?: number; highestIndex?: number };
  rate?: number;
  [k: string]: unknown;
}

export class LoadtestReader {
  private stats: RunnerStats | null = null;
  private statsMtime = -1;
  private checkedAt = 0;
  private members = new Map<string, number>();
  private list: string[] = []; // index → lower-case address
  private loaded = 0; // wallets loaded from addresses.bin
  private bad: string | null = null;

  constructor(readonly dir: string | null, private readonly nowMs: () => number = Date.now) {}

  get deployed(): boolean {
    return !!this.dir && existsSync(join(this.dir, "stats.json"));
  }

  /** Re-read the files when they changed (at most every 2 s). */
  refresh(): void {
    if (!this.dir) return;
    const now = this.nowMs();
    if (now - this.checkedAt < RELOAD_MS) return;
    this.checkedAt = now;
    const sf = join(this.dir, "stats.json");
    if (!existsSync(sf)) { this.stats = null; return; }
    const m = statSync(sf).mtimeMs;
    if (m !== this.statsMtime) {
      try {
        this.stats = JSON.parse(readFileSync(sf, "utf8")) as RunnerStats;
        this.statsMtime = m;
      } catch { /* mid-write on a non-atomic copy: keep the last good one */ }
    }
    this.loadMembers();
  }

  private loadMembers(): void {
    const s = this.stats;
    const af = join(this.dir!, "addresses.bin");
    if (!s || !existsSync(af)) return;
    const top = Number(s.wallets?.highestIndex ?? 0);
    const want = Math.min(top + 1, Math.floor(statSync(af).size / 20));
    const float = s.float?.address?.toLowerCase();
    if (this.loaded > 0 && float && this.addrAt(0) !== float) this.reset(); // a new seed: start over
    if (want <= this.loaded) return;
    const buf = Buffer.alloc((want - this.loaded) * 20);
    const fd = openSync(af, "r");
    try { readSync(fd, buf, 0, buf.length, this.loaded * 20); } finally { closeSync(fd); }
    const first = this.loaded;
    for (let i = first; i < want; i++) {
      const a = "0x" + buf.subarray((i - first) * 20, (i - first) * 20 + 20).toString("hex");
      this.members.set(a, i);
      this.list[i] = a;
    }
    this.loaded = want;
    // spot-check the new range against the published xpub: its first and last entries, and index 0
    const xpub = s.derivation?.xpub;
    if (xpub) {
      try {
        const node = HDNodeWallet.fromExtendedKey(xpub);
        for (const i of new Set([0, first, want - 1])) {
          if (this.addrAt(i) !== node.deriveChild(i).address.toLowerCase()) throw new Error(`addresses.bin entry ${i} does not derive from the published xpub`);
        }
        if (float && this.addrAt(0) !== float) throw new Error("addresses.bin entry 0 is not the float");
        this.bad = null;
      } catch (e) {
        this.bad = (e as Error).message;
        this.reset();
      }
    }
  }

  private reset() { this.members.clear(); this.list = []; this.loaded = 0; }
  private addrAt(i: number): string | undefined { return this.list[i]; }

  getStats(): RunnerStats | null { this.refresh(); return this.stats; }
  problem(): string | null { return this.bad; }
  size(): number { return this.loaded; }

  /** { loadtest, index, role } for an address. */
  lookup(addr: string): { loadtest: boolean; index: number | null; role: "float" | "wallet" | "sink" | null } {
    this.refresh();
    const a = addr.toLowerCase();
    const i = this.members.get(a);
    if (i !== undefined) return { loadtest: true, index: i, role: i === 0 ? "float" : "wallet" };
    if (this.stats?.sink && this.stats.sink.toLowerCase() === a) return { loadtest: false, index: null, role: "sink" };
    return { loadtest: false, index: null, role: null };
  }
}

export function loadtestManifest(r: LoadtestReader, publicUrl: string) {
  const base = publicUrl.replace(/\/+$/, "");
  const s = r.getStats();
  const planned = Number(s?.wallets?.planned ?? 100_000);
  return {
    name: "Wizrd network load test",
    purpose: `A labelled load test of chain 3961 run by Wizrd (agent #12): up to ${planned.toLocaleString("en-US")} wallets make small FMX transfers (mostly 0.01 to 1 FMX, now and then up to 20 FMX) and sweep every coin back to Wizrd's address. It is not organic usage: it is excluded from the network's public usage numbers and every one of its transactions is marked.`,
    operator: { name: "Wizrd", agentId: 12, sink: s?.sink ?? "0xD7175A244a3Eab83f574135318d037Fb6221C358", agentPage: `${base}/agents/?id=12` },
    chainId: 3961,
    status: s ? (s.mode ?? "unknown") : "not started",
    startDate: s?.startedAt ? new Date(Number(s.startedAt) * 1000).toISOString() : null,
    marker: {
      data: LOADTEST_MARKER_DATA,
      prefix: LOADTEST_MARKER,
      ascii: "FXLT",
      version: 1,
      rule: "Every load-test transaction is a plain FMX transfer whose input is 0x46584c5401: the four bytes FXLT and a version byte. A transfer to an account with no code ignores its input, so the marker only costs gas (21,080 per transfer).",
    },
    addresses: {
      float: s?.float?.address ?? null,
      sink: s?.sink ?? null,
      derivation: {
        standard: "BIP-32 / BIP-44",
        path: s?.derivation?.path ?? "m/44'/60'/7'/0/i",
        xpub: s?.derivation?.xpub ?? null,
        float: 0,
        wallets: `1 to ${planned - 1}`,
        activatedUpTo: s?.wallets?.highestIndex ?? 0,
      },
    },
    verify: [
      `One address: GET ${base}/api/loadtest/address/<address> answers {"loadtest": true, "index": i} for a test wallet.`,
      "Offline: derive child i (non-hardened) of the published xpub for i = 0 to activatedUpTo. Index 0 is the float; the xpub derives addresses only and cannot spend.",
      "One transaction: it belongs to the test when its input starts with 0x46584c54 and its sender is a test wallet.",
      `Money: the float funds the wallets, the wallets sweep back to the float, and the float sends what it holds above its working reserve to the sink every hour and everything at the end. Sink transfers are listed in ${base}/api/loadtest/stats.`,
    ],
    counters: `${base}/api/loadtest/stats`,
    excludedFrom: [
      "explorer.ferminux.net home: Transactions (total and last 24 h), the 30-day sparkline and Addresses show the organic figure, with the load test's own transactions and wallets beside them, labelled",
      "explorer.ferminux.net/stats: Transactions (total and last 24 h), Addresses and Transactions per day",
      "explorer.ferminux.net/txs: the total on chain and the last 24 h (the list itself shows every transaction, load-test ones labelled)",
      "explorer.ferminux.net/accounts: the number of addresses seen on chain (the list itself shows every address)",
    ],
    counting: "Organic transactions (total and last 24 h) are counted from the chain itself: the runner reads every block and counts every transaction that is not the load test's (organic in the counters). Addresses come from the explorer's index, which recounts its totals every 5 minutes: the runner reads the index every few seconds and, when a figure changes, records the range of its own count that the figure can hold (indexSnapshot), so the explorer subtracts what the figure actually contains, not the live count.",
    labelled: [
      "explorer.ferminux.net: every marked transaction carries a \"Wizrd load test\" chip in lists and on its page",
      "explorer.ferminux.net: every test wallet's page says \"Wizrd load-test wallet\" and links here",
    ],
    limits: {
      rateTxPerS: s?.rate ?? 2,
      pausesWhen: [
        "the chain head is older than 30 s",
        "fewer than 3 signers confirmed a block in the last 64",
        "more than 2,000 transactions are pending in the node's pool",
        "the explorer's index is more than 100 blocks behind",
        "the float runs dry",
      ],
    },
    manifest: `${base}/.well-known/wizrd-loadtest.json`,
    updatedAt: s && typeof s.updatedAt === "number" ? new Date(s.updatedAt * 1000).toISOString() : null,
  };
}

export function registerLoadtestRoutes(app: FastifyInstance, opts: { dir: string | null; publicUrl: string }): LoadtestReader {
  const reader = new LoadtestReader(opts.dir);
  const base = opts.publicUrl.replace(/\/+$/, "");
  const links = { manifest: `${base}/.well-known/wizrd-loadtest.json`, address: `${base}/api/loadtest/address/{address}` };

  app.get("/api/loadtest/stats", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=5");
    const s = reader.getStats();
    if (!s) return { deployed: false, available: false, detail: "The load test has not started on this network.", ...links };
    return { deployed: true, available: true, ...s, membership: { loaded: reader.size(), problem: reader.problem() }, ...links };
  });

  app.get<{ Params: { addr: string } }>("/api/loadtest/address/:addr", async (req, reply) => {
    // hex only, any case (a mixed-case checksum is not enforced: the answer is the same either way). ethers'
    // isAddress would also take an ICAP "XE…" string, which is not a key of the set and made getAddress throw.
    const raw = String(req.params.addr ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return reply.code(400).send({ error: "not an address: 0x followed by 40 hexadecimal characters", code: "bad_address" });
    reply.header("cache-control", "public, max-age=60");
    const lower = raw.toLowerCase();
    const r = reader.lookup(lower);
    return { address: getAddress(lower), ...r, available: reader.deployed && !reader.problem(), manifest: links.manifest };
  });

  app.get("/api/loadtest/manifest", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=60");
    return loadtestManifest(reader, base);
  });
  return reader;
}

/** OpenAPI paths for the three routes (merged into openapi.ts). */
export function loadtestOpenApiPaths(): Record<string, unknown> {
  const json = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
  return {
    "/api/loadtest/stats": {
      get: {
        tags: ["loadtest"], operationId: "loadtestStats",
        summary: "Wizrd's labelled network load test: its counters (transactions in total, per kind and per UTC day, the last 24 h, addresses, volume, gas), the organic transactions counted from the chain (organic), the explorer index's figures paired with what they hold of the test (indexSnapshot, indexRead), the float and the sink, the marker and the xpub of the wallet branch, and whether it is running or paused and why. `deployed: false` when the test has not started.",
        responses: { "200": json("Counters") },
      },
    },
    "/api/loadtest/address/{addr}": {
      get: {
        tags: ["loadtest"], operationId: "loadtestAddress",
        summary: "Is this address a load-test wallet? `loadtest: true` with its derivation index (0 = the float) for wallets up to the highest activated index; `role: \"sink\"` for Wizrd's address that receives the sweeps.",
        parameters: [{ name: "addr", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, description: "Address" }],
        responses: { "200": json("Membership"), "400": json("Not an address") },
      },
    },
    "/api/loadtest/manifest": {
      get: {
        tags: ["loadtest"], operationId: "loadtestManifest",
        summary: "The public disclosure of the load test (also at /.well-known/wizrd-loadtest.json): purpose, marker, float and sink, how to verify membership, where it is excluded from usage numbers, and the live counters link.",
        responses: { "200": json("Manifest") },
      },
    },
  };
}
