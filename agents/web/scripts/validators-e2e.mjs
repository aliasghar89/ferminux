#!/usr/bin/env node
// /validators/ end to end, on an anvil fork of chain 3961 (London rules), at 390 px and 1440 px.
//
//   node scripts/validators-e2e.mjs                      # everything, from a fresh fork
//   FORK_RPC=http://127.0.0.1:8671 DEPLOYMENTS_FILE=… FOUNDRY_OUT=… node scripts/validators-e2e.mjs   # reuse one
//
// What it runs, all on 127.0.0.1 (nothing is broadcast anywhere else):
//   fork      anvil --fork-url https://rpc.ferminux.net --hardfork london (read-only fork source)
//   deploy    infra/ops/validators/pilot.sh apply with SIGNER=unlocked (the multisig owners impersonated): the
//             pilot hub, lens and router, the 20,000 FMX tranche, two throwaway test owners invited
//   proofs    the real validator app (fmx-validator, built from validator/ unless FMX_VALIDATOR names one) makes
//             each test owner's seat proof against the fork hub: `seat-proof --owner … [--json]`
//   gateway   the real waitlist routes (agents/gateway/dist, `npm run build` there first) with signatures REQUIRED
//   site      three builds of this site: VITE_VALIDATOR_HUB=off ("opens soon"), one pointed at the fork's hub, and
//             one pointed at an address with no contract (a wrong build setting: the page must say so)
//   browser   headless Chromium with an injected EIP-1193 wallet (announced over EIP-6963) whose keys live in
//             this script: throwaway keys derived from fixed labels, funded on the fork with anvil_setBalance
//
// Checks: the pilot line and "opens soon" with no deposit button; a signed waitlist entry (the gateway verifies
// the signature); an uninvited wallet gets the waitlist; an invited wallet downloads (SHA-256 from a fixture
// SHA256SUMS), pastes the app's proof (a proof for another wallet is refused), reviews the exact contract,
// method and amount, is refused while its wallet is on another chain and the switch is declined (nothing sent),
// then deposits exactly 2,000 FMX to the hub on chain 3961 (the request names chain 3961, so a wallet on another
// chain refuses it) and sees its seat start after the activation delay;
// no horizontal scroll at either width; no page errors. The page's ABI fragments are compared with the fresh
// forge build. Screenshots go to OUT (default: a temp directory, printed at the end).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { Contract, Interface, JsonRpcProvider, SigningKey, Wallet, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { HUB_ABI, LENS_ABI, attesterKeyDigest, enodeDigest, ACTIVATION_DELAY, PACKAGES } from "../src/validatorPilot.ts";
import { waitlistMessage } from "../src/validatorForm.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "../..");
const TMP = process.env.E2E_DIR || mkdtempSync(join(tmpdir(), "validators-e2e-"));
const OUT = process.env.OUT || join(TMP, "shots");
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 8681);
const WEB_PORT = Number(process.env.WEB_PORT || 4395);
const UPSTREAM = process.env.UPSTREAM_RPC || "https://rpc.ferminux.net";
const CHAIN = 3961;
const FMX = 10n ** 18n;

let passes = 0, fails = 0;
const say = (s) => console.log(s);
const pass = (s) => { passes++; say(`  ✓ ${s}`); };
const fail = (s) => { fails++; say(`  ✗ ${s}`); };
const check = (ok, s, extra = "") => (ok ? pass(s) : fail(`${s}${extra ? ` (${extra})` : ""}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(join(REPO, "explorer/web/package.json"));
const { chromium } = (() => { try { return require("@playwright/test"); } catch { return require("playwright"); } })();

const cleanups = [];
async function cleanup() { for (const f of cleanups.reverse()) { try { await f(); } catch { /* keep going */ } } }
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

async function rpcCall(url, method, params = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}

/* ------------------------------------------------------------------ fork + deploy */
say(`== validators e2e  ${new Date().toISOString()}\nscratch  : ${TMP}`);
let FORK = process.env.FORK_RPC;
if (!FORK) {
  FORK = `http://127.0.0.1:${PORT}`;
  const anvil = spawn("anvil", ["--fork-url", UPSTREAM, "--hardfork", "london", "--port", String(PORT), "--prune-history", "--silent"], { stdio: "ignore" });
  cleanups.push(() => anvil.kill());
  for (let i = 0; i < 80; i++) { try { if ((await rpcCall(FORK, "eth_chainId")).result) break; } catch { /* starting */ } await sleep(500); }
}
const provider = new JsonRpcProvider(FORK, CHAIN, { staticNetwork: true, polling: true, pollingInterval: 250 });
const client = (await rpcCall(FORK, "web3_clientVersion")).result ?? "";
check(Number((await rpcCall(FORK, "eth_chainId")).result) === CHAIN && /^anvil/.test(client), `fork ${FORK} is chain ${CHAIN} on ${client}`);
if (!/^anvil/.test(client)) { await cleanup(); process.exit(1); }

const key = (label) => keccak256(toUtf8Bytes(`ferminux-validators-page-e2e/${label}`));
const W = Object.fromEntries(["owner-1", "owner-2", "outsider-d", "outsider-p"].map((l) => [l, new Wallet(key(l), provider)]));
for (const [l, w] of Object.entries(W)) {
  const r = await rpcCall(FORK, "anvil_setBalance", [w.address, `0x${((l.startsWith("owner") ? 5000n : 10n) * FMX).toString(16)}`]);
  if (r.error) { fail(`anvil_setBalance ${l}: ${r.error.message} (a reused fork older than the upstream's state window? start a fresh one)`); await cleanup(); process.exit(1); }
}
// an address with no contract, for a build whose hub setting is wrong (touched now so the fork holds it locally)
const NOCODE = new Wallet(key("no-contract-here")).address;
await rpcCall(FORK, "anvil_setBalance", [NOCODE, "0x0"]);

let DEP = process.env.DEPLOYMENTS_FILE;
const FOUNDRY_OUT = process.env.FOUNDRY_OUT || join(TMP, "forge-out");
if (!DEP) {
  DEP = join(TMP, "deployments-validators.fork.json");
  writeFileSync(join(TMP, "allow.txt"), `# e2e invitations (fork only)\n${W["owner-1"].address}\n${W["owner-2"].address}\n`);
  say("deploying the pilot on the fork with pilot.sh apply (SIGNER=unlocked) …");
  try {
    execFileSync("bash", [join(REPO, "infra/ops/validators/pilot.sh"), "apply"], {
      env: { ...process.env, CONFIRM: "validator-pilot-3961", RPC_URL: FORK, SIGNER: "unlocked", DEPLOYMENTS_FILE: DEP, ALLOWLIST_FILE: join(TMP, "allow.txt"),
        WORK_DIR: join(TMP, "w-apply"), FOUNDRY_OUT, FOUNDRY_CACHE_PATH: join(TMP, "forge-cache"), FOUNDRY_BROADCAST: join(TMP, "broadcast") },
      stdio: ["ignore", "pipe", "pipe"], timeout: 900_000,
    });
    pass("pilot.sh apply deployed the pilot on the fork");
  } catch (e) { fail(`pilot.sh apply: ${String(e.stdout ?? e.message).split("\n").slice(-6).join(" | ")}`); await cleanup(); process.exit(1); }
}
const dep = JSON.parse(readFileSync(DEP, "utf8"));
const HUB = dep.validatorHub, LENS = dep.validatorHubLens;
const hub = new Contract(HUB, HUB_ABI, provider), lens = new Contract(LENS, LENS_ABI, provider);
check((await hub.allowlistOnly()) === true && Number(await hub.maxSeats()) === 20, `hub ${HUB}: invite-only, 20 seats`);
check((await hub.allowlisted(W["owner-1"].address)) && (await hub.allowlisted(W["owner-2"].address)) && !(await hub.allowlisted(W["outsider-d"].address)), "owners 1 and 2 invited, the outsiders not");

// the page computes both proof digests itself: they must equal the hub's own
{
  const d = new Contract(HUB, ["function attesterKeyDigest(address,address) view returns (bytes32)", "function enodeDigest(address,address) view returns (bytes32)"], provider);
  const [o, a] = [W["owner-1"].address, W["outsider-d"].address];
  check((await d.attesterKeyDigest(o, a)) === attesterKeyDigest(HUB, o, a) && (await d.enodeDigest(o, a)) === enodeDigest(HUB, o, a), "the page's attester and node digests equal the hub's");
}

// the page's ABI fragments against the fresh compile
{
  const canon = (p) => (p.baseType === "tuple" ? `tuple(${p.components.map((c) => `${canon(c)} ${c.name}`).join(",")})` : p.type);
  const sig = (f) => `${f.type} ${f.name}(${f.inputs.map(canon).join(",")})${f.outputs ? ` -> (${f.outputs.map(canon).join(",")})` : ""}${f.stateMutability && f.stateMutability !== "nonpayable" ? ` ${f.stateMutability}` : ""}`;
  for (const [name, frags] of [["ValidatorHub", HUB_ABI], ["ValidatorHubLens", LENS_ABI]]) {
    const art = join(FOUNDRY_OUT, `${name}.sol`, `${name}.json`);
    if (!existsSync(art)) { fail(`no forge artifact at ${art} (set FOUNDRY_OUT)`); continue; }
    const built = new Interface(JSON.parse(readFileSync(art, "utf8")).abi);
    const have = new Set(built.fragments.map(sig));
    const missing = new Interface(frags).fragments.map(sig).filter((s) => !have.has(s));
    check(missing.length === 0, `${name}: every fragment the page uses matches the compiled ABI`, missing.join("; "));
  }
}

/* ------------------------------------------------------------------ seat proofs from the validator app */
let FV = process.env.FMX_VALIDATOR;
if (!FV) {
  FV = join(TMP, "bin", "fmx-validator");
  try {
    execFileSync("go", ["build", "-o", FV, "./cmd/fmx-validator"], { cwd: join(REPO, "validator"), env: { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN || "go1.20.14" }, stdio: "ignore", timeout: 600_000 });
  } catch { FV = null; }
}
function proofFor(owner, label) {
  if (FV) {
    const d = join(TMP, `v-${label}`); mkdirSync(d, { recursive: true });
    const pw = join(d, "pw"); writeFileSync(pw, `fork-only-${label}-${randomBytes(6).toString("hex")}`); chmodSync(pw, 0o600);
    const nk = join(d, "nodekey"); writeFileSync(nk, randomBytes(32).toString("hex")); chmodSync(nk, 0o600);
    const base = ["--network", "mainnet", "--data-dir", d];
    execFileSync(FV, ["init", ...base, "--hub", HUB, "--node-ipc", FORK], { stdio: "ignore" });
    execFileSync(FV, ["keys", "new", ...base, "--password-file", pw], { stdio: "ignore" });
    const args = ["seat-proof", ...base, "--password-file", pw, "--nodekey", nk, "--owner", owner];
    return { json: execFileSync(FV, [...args, "--json"]).toString(), text: execFileSync(FV, args).toString(), by: "fmx-validator seat-proof" };
  }
  // no Go toolchain: the same proof, made the way the app makes it (typed data by the attester, raw digest by the node key)
  const att = new SigningKey(`0x${randomBytes(32).toString("hex")}`), node = new SigningKey(`0x${randomBytes(32).toString("hex")}`);
  const attester = new Wallet(att.privateKey).address;
  const p = { hub: HUB, chainId: CHAIN, owner, attester, attesterSig: att.sign(attesterKeyDigest(HUB, owner, attester)).serialized,
    enodePubkey: `0x${node.publicKey.slice(4)}`, enodeSig: node.sign(enodeDigest(HUB, owner, attester)).serialized };
  const json = JSON.stringify(p, null, 2);
  return { json, text: json, by: "ethers (fmx-validator not built)" };
}
const PROOF = { "owner-1": proofFor(W["owner-1"].address, "o1"), "owner-2": proofFor(W["owner-2"].address, "o2") };
// A fork of a pruning node can read an account it has not seen only while the upstream still holds the fork
// block's state (about 128 blocks): give every account the page will read a balance now, so it is local from
// here on. The desktop owner's attester gets 1 FMX for fees, the phone owner's almost none (the page says so).
await rpcCall(FORK, "anvil_setBalance", [JSON.parse(PROOF["owner-1"].json).attester, `0x${FMX.toString(16)}`]);
await rpcCall(FORK, "anvil_setBalance", [JSON.parse(PROOF["owner-2"].json).attester, `0x${(FMX / 100n).toString(16)}`]);
check(/"attesterSig"/.test(PROOF["owner-1"].json) && /attesterSig\s+0x/.test(PROOF["owner-1"].text) || !FV, `seat proofs made by ${PROOF["owner-1"].by}`);

/* ------------------------------------------------------------------ the gateway (real routes, signatures required) */
const gwDist = join(REPO, "agents/gateway/dist");
if (!existsSync(join(gwDist, "server.js"))) { fail("agents/gateway/dist is missing: run `npm run build` in agents/gateway"); await cleanup(); process.exit(1); }
delete process.env.VALIDATOR_WAITLIST_SIGNATURES;
const { buildServer } = await import(join(gwDist, "server.js"));
const { openMemoryDb } = await import(join(gwDist, "db.js"));
const gwValidators = await import(join(gwDist, "validators.js"));
const cfg = { rpcUrl: "http://127.0.0.1:1", registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719", deployBlock: 0, dataDir: ":memory:", port: 0, publicUrl: "https://ferminux.net", pollMs: 1e9, probeMs: 1e9, toolProbeMs: 1e9, bscRpcUrl: "http://127.0.0.1:1", payinRpcUrls: {}, payinDeposits: {}, webhookTickMs: 1e9, x402BatchMs: 1e9, payinPollMs: 1e9 };
const { app: gw } = await buildServer({ db: openMemoryDb(), cfg, workers: false, logger: false, commons: { forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) } });
await gw.ready();
cleanups.push(() => gw.close());
{
  const body = { address: W["owner-1"].address, platform: "linux", seats: 2, contact: "me@Example.COM", consent: true };
  const norm = gwValidators.parseWaitlistBody(body);
  check(waitlistMessage({ ...body, contact: "me@example.com" }, "ab".repeat(16), 1_900_000_000) === gwValidators.waitlistMessage(norm, "ab".repeat(16), 1_900_000_000), "the page's waitlist text is the gateway's, line for line");
}

/* ------------------------------------------------------------------ the site: two builds + a local server */
function build(name, env) {
  const out = join(TMP, name);
  if (!existsSync(join(WEB, "src/deployments.generated.ts"))) execFileSync("node", ["scripts/gen-config.mjs"], { cwd: WEB, stdio: "ignore" });
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: WEB, env: { ...process.env, ...env }, stdio: "inherit", timeout: 300_000 });
  return out;
}
const DIST = {
  soon: build("dist-soon", { VITE_VALIDATOR_HUB: "off" }),
  hub: build("dist-hub", { VITE_VALIDATOR_HUB: HUB, VITE_VALIDATOR_HUB_LENS: LENS, VITE_VALIDATOR_DEPLOY_BLOCK: String(dep.deployBlock), VITE_RPC: FORK }),
  nocode: build("dist-nocode", { VITE_VALIDATOR_HUB: NOCODE, VITE_VALIDATOR_HUB_LENS: NOCODE, VITE_RPC: FORK }),
};
pass("site built three times (no hub; the fork's hub; an address with no contract)");
// a stand-in SHA256SUMS: the release is not part of the repo, so these are hashes of fixed test strings
const SUMS = PACKAGES.map((p) => `${createHash("sha256").update(`e2e fixture ${p.file}`).digest("hex")}  ${p.file}`).join("\n") + "\n";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };
function serve(dist, port) {
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/api/validators/")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await gw.inject({ method: req.method, url: `${u.pathname}${u.search}`, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, payload: chunks.length ? Buffer.concat(chunks) : undefined });
      res.writeHead(r.statusCode, { "content-type": r.headers["content-type"] ?? "application/json" }); return res.end(r.body);
    }
    if (u.pathname === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, indexedBlock: 1e12 })); }
    if (u.pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
    if (u.pathname === "/downloads/validator-pilot/SHA256SUMS") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(SUMS); }
    let f = join(dist, decodeURIComponent(u.pathname));
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }); res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => { cleanups.push(() => new Promise((d) => srv.close(d))); r(`http://127.0.0.1:${port}`); }));
}
const SITE = { soon: await serve(DIST.soon, WEB_PORT), hub: await serve(DIST.hub, WEB_PORT + 1), nocode: await serve(DIST.nocode, WEB_PORT + 2) };

/* ------------------------------------------------------------------ the injected wallet */
const WALLET_JS = `(() => {
  const listeners = {};
  const emit = (ev, arg) => (listeners[ev] || []).slice().forEach((f) => { try { f(arg); } catch (e) {} });
  const provider = {
    isE2EWallet: true,
    async request({ method, params }) {
      const r = JSON.parse(await window.__e2eWallet(JSON.stringify({ method, params: params ?? [] })));
      if (r.emit) for (const [ev, arg] of r.emit) setTimeout(() => emit(ev, arg), 0);
      if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      return r.result;
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return provider; },
  };
  window.__e2eEmit = emit;
  window.ethereum = provider;
  const info = { uuid: "5f0e2e00-0000-4000-8000-000000000001", name: "E2E Wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'/%3E", rdns: "net.ferminux.e2e" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;

async function openPage(browser, viewport, wallet) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const w = { wallet, chainId: CHAIN, connected: false, rejectSwitch: false, sent: [], signed: [] };
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(m.text()); });
  // nothing leaves this machine: fonts and any other outside host are refused
  await page.route((u) => !/^http:\/\/127\.0\.0\.1[:/]/.test(u.toString()) && !u.toString().startsWith("data:"), (r) => r.abort());
  await page.exposeFunction("__e2eWallet", async (raw) => {
    const { method, params } = JSON.parse(raw);
    const ok = (result, emit) => JSON.stringify({ result, emit });
    const err = (code, message) => JSON.stringify({ error: { code, message } });
    const me = w.wallet.address;
    switch (method) {
      case "eth_requestAccounts": w.connected = true; return ok([me], [["accountsChanged", [me]]]);
      case "eth_accounts": return ok(w.connected ? [me] : []);
      case "eth_chainId": return ok(`0x${w.chainId.toString(16)}`);
      case "net_version": return ok(String(w.chainId));
      case "wallet_switchEthereumChain": {
        if (w.rejectSwitch) return err(4001, "User rejected the request.");
        w.chainId = Number(BigInt(params[0].chainId));
        return ok(null, [["chainChanged", params[0].chainId]]);
      }
      case "wallet_addEthereumChain": return ok(null);
      case "wallet_getPermissions": case "wallet_requestPermissions": return ok([{ parentCapability: "eth_accounts" }]);
      case "personal_sign": {
        if (!w.connected) return err(4100, "Not connected");
        const sig = await w.wallet.signMessage(getBytes(params[0]));
        w.signed.push(Buffer.from(getBytes(params[0])).toString("utf8"));
        return ok(sig);
      }
      case "eth_sendTransaction": {
        if (!w.connected) return err(4100, "Not connected");
        const t = params[0];
        // chainId: the chain the wallet is on; txChainId: the one the page named in the request (real wallets refuse a mismatch)
        w.sent.push({ ...t, chainId: w.chainId, txChainId: t.chainId === undefined ? null : Number(BigInt(t.chainId)) });
        if (w.chainId !== CHAIN) return err(-32000, `e2e wallet: refusing to send on chain ${w.chainId}`);
        if (t.chainId !== undefined && Number(BigInt(t.chainId)) !== w.chainId) return err(-32602, `e2e wallet: the transaction names chain ${t.chainId}, the wallet is on ${w.chainId}`);
        const tx = await w.wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n, gasLimit: t.gas ? BigInt(t.gas) : undefined,
          maxFeePerGas: t.maxFeePerGas ? BigInt(t.maxFeePerGas) : undefined, maxPriorityFeePerGas: t.maxPriorityFeePerGas ? BigInt(t.maxPriorityFeePerGas) : undefined, type: 2 });
        return ok(tx.hash);
      }
      default: {
        const j = await rpcCall(FORK, method, params);
        return j.error ? err(j.error.code ?? -32000, j.error.message ?? "rpc error") : ok(j.result);
      }
    }
  });
  await page.addInitScript(WALLET_JS);
  return { ctx, page, w, errors };
}

let shotN = 0;
async function shot(page, label, name) {
  const file = join(OUT, `${label}-${String(++shotN).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check(sw <= cw, `${label} ${name}: no sideways scroll`, `${sw} > ${cw}`);
  return file;
}
async function connectVia(page, selector) {
  await page.click(selector);
  await page.click('[data-testid="choice-injected"]', { timeout: 10_000 });
}
const text = (page) => page.locator("#join").innerText();

const browser = await chromium.launch();
cleanups.push(() => browser.close());

for (const [label, viewport, ownerL, outsiderL, otherL] of [
  ["desktop", { width: 1440, height: 1000 }, "owner-1", "outsider-d", "owner-2"],
  ["phone", { width: 390, height: 844 }, "owner-2", "outsider-p", "owner-1"],
]) {
  say(`\n== ${label} ${viewport.width}x${viewport.height}`);
  /* ---- A. no hub: opens soon + a signed waitlist entry */
  {
    const { ctx, page, w, errors } = await openPage(browser, viewport, W[outsiderL]);
    await page.goto(`${SITE.soon}/validators/`, { waitUntil: "load" });
    await page.waitForSelector("#vp-view h3");
    const banner = await page.locator("#status").innerText();
    check(banner.includes("Pilot: invite-only, up to 20 seats, 2,000 FMX each; opening to everyone after an external audit."), "banner states the pilot's terms");
    check((await text(page)).includes("The pilot opens soon") && (await page.locator("#vp-deposit").count()) === 0, "no hub: 'opens soon', no deposit button");
    await shot(page, label, "soon");
    await connectVia(page, "#wl-connect");
    await page.waitForFunction(() => document.querySelector("#wl-wallet .addr"));
    await page.check('input[name="platform"][value="linux"]');
    await page.fill("#wl-contact", "@ferminux_e2e");
    await page.check("#wl-consent");
    await page.click("#wl-submit");
    await page.waitForSelector("#wl-done:not([hidden])", { timeout: 20_000 });
    const signedText = w.signed.at(-1) ?? "";
    check(signedText.startsWith("Ferminux validator waitlist\n") && signedText.includes(`address: ${W[outsiderL].address}`), "the wallet signed the waitlist text for its own address");
    const count = await (await fetch(`${SITE.soon}/api/validators/waitlist/count`)).json();
    check(count.verified >= 1 && count.verified === count.total, `the gateway (signatures required) stored it as signed: ${count.verified}/${count.total}`);
    check((await page.locator("#wl-done-t").innerText()).includes("You are on the waitlist"), "'You are on the waitlist'");
    await shot(page, label, "soon-waitlist-done");
    check(errors.length === 0, "no page errors (no hub)", errors.join(" | "));
    await ctx.close();
  }

  /* ---- A2. a hub address with no contract behind it: said plainly, nothing to deposit into */
  {
    const { ctx, page, errors } = await openPage(browser, viewport, W[outsiderL]);
    await page.goto(`${SITE.nocode}/validators/`, { waitUntil: "load" });
    await page.waitForFunction(() => /not open on this page/.test(document.querySelector("#vp-view")?.textContent ?? ""), null, { timeout: 20_000 });
    const banner = await page.locator("#status").innerText();
    check(!banner.includes(NOCODE) && /no ValidatorHub contract/.test(banner) && (await page.locator("#c-pill").innerText()) === "Not on chain", "no contract at the address: the banner and the contract panel say so and name no deposit address");
    check((await page.locator("#vp-deposit").count()) === 0 && (await page.locator("#wl-box").isVisible()), "no contract: no deposit button, the waitlist is offered");
    if (label === "phone") await shot(page, label, "hub-no-contract");
    check(errors.length === 0, "no page errors (no contract)", errors.join(" | "));
    await ctx.close();
  }

  /* ---- B. hub: an uninvited wallet gets the waitlist */
  {
    const { ctx, page, errors } = await openPage(browser, viewport, W[outsiderL]);
    await page.goto(`${SITE.hub}/validators/`, { waitUntil: "load" });
    await page.waitForFunction(() => /taken/.test(document.querySelector("#join-pill")?.textContent ?? ""), null, { timeout: 20_000 });
    check((await page.locator("#join-pill").innerText()).startsWith("Invite-only"), `join pill: ${await page.locator("#join-pill").innerText()}`);
    check((await page.locator("#c-body").innerText()).includes(HUB.slice(0, 8)), "the contract panel names the hub");
    check((await page.locator("#c-body").innerText()).includes("foundation multisig, 2 of 3"), "the contract panel calls the owner the foundation multisig (it is)");
    await shot(page, label, "hub-connect");
    await connectVia(page, "#vp-connect-main");
    await page.waitForFunction(() => /not invited/.test(document.querySelector("#vp-view")?.textContent ?? ""), null, { timeout: 20_000 });
    check(await page.locator("#wl-box").isVisible(), "not invited: the waitlist is offered");
    await page.check('input[name="platform"][value="windows"]');
    await page.click("#wl-submit");
    await page.waitForSelector("#wl-done:not([hidden])", { timeout: 20_000 });
    check((await page.locator("#wl-done-t").innerText()).includes("already on the waitlist"), "the same wallet again: 'already on the waitlist' (the first signed entry stands)");
    await shot(page, label, "hub-not-invited");
    check(errors.length === 0, "no page errors (uninvited)", errors.join(" | "));
    await ctx.close();
  }

  /* ---- C. hub: an invited wallet opens a seat */
  {
    const owner = W[ownerL];
    const { ctx, page, w, errors } = await openPage(browser, viewport, owner);
    await page.goto(`${SITE.hub}/validators/`, { waitUntil: "load" });
    await page.waitForFunction(() => /taken/.test(document.querySelector("#join-pill")?.textContent ?? ""), null, { timeout: 20_000 });
    const before = Number(await hub.occupiedSeats());
    await connectVia(page, "#vp-connect-main");
    await page.waitForSelector("#vp-steps:not([hidden])", { timeout: 20_000 });
    check((await page.locator("#vp-wallet").innerText()).includes("Invited"), "invited wallet: 'Invited'");
    await page.waitForFunction(() => document.querySelectorAll(".vp-sha code").length > 0, null, { timeout: 15_000 });
    const shas = await page.locator(".vp-sha code").allInnerTexts();
    check(shas.every((s) => SUMS.includes(s)) && shas.length >= 1, `step 1 shows the SHA-256 from SHA256SUMS (${shas.length})`);
    await shot(page, label, "step1-download");
    await page.click('[data-act="to-2"]');
    await page.waitForSelector("#vp-proof");
    const cmds = (await page.locator(".vp-code code").allInnerTexts()).join("\n");
    check(cmds.includes(`--owner ${owner.address}`) && cmds.includes(`--hub ${HUB}`), "step 2 prints init --hub <hub> and seat-proof --owner <this wallet>");
    // a proof made for the other owner is refused, in words
    await page.fill("#vp-proof", PROOF[otherL].json);
    await page.waitForFunction(() => /made for the wallet/.test(document.querySelector("#vp-proof-out")?.textContent ?? ""), null, { timeout: 10_000 });
    check(await page.locator('[data-act="to-3"]').isDisabled(), "another wallet's proof: refused, cannot continue");
    // this wallet's proof: the desktop pastes the text output, the phone the JSON
    await page.fill("#vp-proof", label === "desktop" ? PROOF[ownerL].text : PROOF[ownerL].json);
    await page.waitForFunction(() => document.querySelectorAll(".vp-checks li.ok").length === 3, null, { timeout: 15_000 });
    const attester = JSON.parse(PROOF[ownerL].json).attester;
    check((await page.locator(".vp-attester").innerText()).toLowerCase().includes(attester.slice(0, 6).toLowerCase()), "the attester address from the app is shown");
    await shot(page, label, "step2-proof");
    await page.click('[data-act="to-3"]');
    await page.waitForFunction(() => /about/.test(document.querySelector("#vp-review")?.textContent ?? "") && !document.querySelector("#vp-review .sk"), null, { timeout: 20_000 });
    const rv = await page.locator("#vp-review").innerText();
    check(rv.includes("2,000 FMX") && rv.includes("2000000000000000000000 wei") && rv.includes("openSeat(attester, attesterSig, enodePubkey, enodeSig)") && rv.includes(`chain ${CHAIN}`), "review: exact amount, method and chain");
    check(rv.includes(HUB) && rv.toLowerCase().includes(attester.toLowerCase()), "review: the full hub and attester addresses");
    check((await page.locator("#vp-review-alert").innerText()).trim() === "" && /Network feeabout [\d.<,]+ FMX/.test((await page.locator("#vp-review").textContent()) ?? ""), "review: openSeat simulated fine, network fee estimated", await page.locator("#vp-review-alert").innerText());
    await shot(page, label, "step3-review");
    // the wallet moves to another chain and declines to switch back: nothing is sent
    w.chainId = 56; w.rejectSwitch = true;
    await page.evaluate(() => window.__e2eEmit("chainChanged", "0x38"));
    await page.check("#vp-ack");
    await page.click("#vp-deposit");
    await page.waitForFunction(() => /Nothing was sent/.test(document.querySelector("#vp-deposit-status")?.textContent ?? ""), null, { timeout: 20_000 });
    check(w.sent.length === 0, `wrong chain, switch declined: no transaction ("${(await page.locator("#vp-deposit-status").innerText()).slice(0, 90)}…")`);
    w.rejectSwitch = false;
    await page.click("#vp-deposit");
    await page.waitForSelector(".vp-seat", { timeout: 60_000 });
    const tx = w.sent.at(-1);
    check(w.sent.length === 1 && tx.to.toLowerCase() === HUB.toLowerCase() && BigInt(tx.value) === 2000n * FMX && tx.chainId === CHAIN, "one transaction: exactly 2,000 FMX to the hub, sent on chain 3961");
    check(tx.txChainId === CHAIN, "the request itself names chain 3961, so the wallet refuses it on any other chain", String(tx.txChainId));
    const after = Number(await hub.occupiedSeats());
    const seatId = Number((await hub.keyInfo(attester))[0]);
    const seat = await lens.seat(seatId);
    check(after === before + 1 && seat.owner === owner.address && seat.attester.toLowerCase() === attester.toLowerCase(), `seat #${seatId} is open on the fork, owned by the wallet, with the app's attester`);
    const card = await page.locator(".vp-seat").first().innerText();
    check(card.includes(`Seat #${seatId}`) && card.includes("Starting"), "step 4: the seat, 'Starting'");
    await shot(page, label, "step4-starting");
    // past the activation delay the seat has started (no checkpoint signed yet on a fork)
    const head = await provider.getBlockNumber();
    let left = Number(seat.activationBlock) - head + 5;
    while (left > 0) { const n = Math.min(left, 2000); await rpcCall(FORK, "anvil_mine", [`0x${n.toString(16)}`]); left -= n; }
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => /Started/.test(document.querySelector(".vp-seat")?.textContent ?? ""), null, { timeout: 30_000 });
    pass(`after ${ACTIVATION_DELAY.toLocaleString("en-US")}+ blocks the page shows the seat 'Started'`);
    await page.waitForFunction(() => /Read from the chain at block/.test(document.querySelector("#vp-seat-at")?.textContent ?? ""), null, { timeout: 20_000 });
    pass("after a reload the seat status keeps refreshing from the chain");
    const reviewAddr = await page.evaluate(() => document.body.textContent?.includes("Seat #"));
    check(reviewAddr === true, "the seat card survives the refresh");
    await shot(page, label, "step4-started");
    check(errors.length === 0, "no page errors (invited)", errors.join(" | "));
    await ctx.close();
  }
}

await cleanup();
say(`\n${passes} passed, ${fails} failed · screenshots in ${OUT}`);
process.exit(fails ? 1 : 0);
