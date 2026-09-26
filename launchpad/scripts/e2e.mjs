#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Ferminux Launchpad — e2e data-layer test.
//
// Spawns a throwaway anvil on port 8548 (chain-id 3961), deploys the real
// TokenFactory (bytecode from the contracts project's forge artifact), then
// drives src/lib/factory.ts — the exact module the UI uses in production —
// through the full launch / registry / trust-badge flow.
//
//   node scripts/e2e.mjs         (or: npm run e2e)
//
// Requires: anvil (foundry) on PATH, and a `forge build` artifact at
// ../contracts/out/TokenFactory.sol/TokenFactory.json.
// Never touches the live devnet on 8545/8546.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroAddress,
  parseEther,
  parseUnits,
} from "ethers";

// The production data layer under test — imported unchanged from the app.
import {
  TOKEN_ABI,
  factoryContract,
  formatAmount,
  formatFmx,
  getLaunchFee,
  getTokenCount,
  getTokenDetails,
  getTokensNewestFirst,
  launchToken,
  trustBadges,
} from "../src/lib/factory.ts";

const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 3961;

// anvil's deterministic dev accounts
const KEY_DEPLOYER =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // #0
const COLLECTOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // #1 (EOA fee collector)

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = resolve(
  here,
  "../../contracts/out/TokenFactory.sol/TokenFactory.json",
);

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

async function waitForRpc(provider, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`anvil did not come up on ${RPC}`);
}

async function main(anvil) {
  // cacheTimeout -1 disables ethers' 250ms read cache — anvil instamines, so
  // back-to-back balance reads would otherwise return stale values.
  const provider = new JsonRpcProvider(RPC, undefined, {
    staticNetwork: true,
    cacheTimeout: -1,
    pollingInterval: 100,
  });
  await waitForRpc(provider);
  const net = await provider.getNetwork();
  check(`anvil up on :${PORT} with chain-id ${CHAIN_ID}`, Number(net.chainId) === CHAIN_ID);

  const wallet = new Wallet(KEY_DEPLOYER, provider);
  // NonceManager avoids a pending-nonce race between anvil instamine and
  // ethers' getTransactionCount polling.
  const deployer = new NonceManager(wallet);

  // -- deploy the real TokenFactory from the forge artifact ----------------
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const cf = new ContractFactory(artifact.abi, artifact.bytecode.object, deployer);
  const deployed = await cf.deploy(COLLECTOR);
  await deployed.waitForDeployment();
  const factoryAddress = await deployed.getAddress();
  console.log(`\nTokenFactory deployed at ${factoryAddress} (collector = ${COLLECTOR})\n`);

  // From here on, ONLY the app's module talks to the chain.
  const factory = factoryContract(factoryAddress, deployer);

  // -- 1. live launch fee ---------------------------------------------------
  const fee = await getLaunchFee(factory);
  check("launchFee() == 10 FMX (10e18 wei)", fee === parseEther("10"), `got ${fee}`);
  check(`formatFmx renders "10 FMX"`, formatFmx(fee) === "10 FMX", formatFmx(fee));

  // -- 2. empty registry ----------------------------------------------------
  const empty = await getTokensNewestFirst(factory, 0, 10);
  check("empty registry: total 0, no entries", empty.total === 0 && empty.entries.length === 0);

  // -- 3. launch token A (mintable, uncapped), paying the live fee ----------
  const collectorBefore = await provider.getBalance(COLLECTOR);
  const a = await launchToken(
    factory,
    {
      name: "Alpha Coin",
      symbol: "ALPHA",
      decimals: 18,
      initialSupply: parseUnits("1000000", 18),
      maxSupply: 0n,
      mintable: true,
    },
    fee,
  );
  check("launch A returns a token address", /^0x[0-9a-fA-F]{40}$/.test(a.token), a.token);
  check("launch A returns the tx hash", /^0x[0-9a-fA-F]{64}$/.test(a.txHash));
  const collectorAfter = await provider.getBalance(COLLECTOR);
  check(
    "10 FMX fee forwarded to feeCollector",
    collectorAfter - collectorBefore === fee,
    `delta ${collectorAfter - collectorBefore}`,
  );
  check("isFactoryToken(A) == true", (await factory.isFactoryToken(a.token)) === true);

  // -- 4. registry contains A -----------------------------------------------
  const one = await getTokensNewestFirst(factory, 0, 10);
  check("tokensPage returns launched token", one.total === 1 && one.entries[0]?.token === a.token);
  check("registry entry carries name/symbol", one.entries[0]?.name === "Alpha Coin" && one.entries[0]?.symbol === "ALPHA");
  check("registry entry creator == launcher", one.entries[0]?.creator === wallet.address);
  const now = Math.floor(Date.now() / 1000);
  check(
    "registry createdAt is a sane timestamp",
    Math.abs(one.entries[0].createdAt - now) < 3600,
    `createdAt ${one.entries[0].createdAt}`,
  );

  // -- 5. launch B (fixed supply, 6 decimals) and C (for ordering) ----------
  const b = await launchToken(
    factory,
    {
      name: "Beta Stable",
      symbol: "BETA",
      decimals: 6,
      initialSupply: parseUnits("500000", 6),
      maxSupply: parseUnits("500000", 6),
      mintable: false,
    },
    fee,
  );
  const c = await launchToken(
    factory,
    {
      name: "Gamma Coin",
      symbol: "GAMMA",
      decimals: 18,
      initialSupply: parseUnits("42", 18),
      maxSupply: 0n,
      mintable: true,
    },
    fee,
  );
  check("tokenCount == 3", (await getTokenCount(factory)) === 3);

  // -- 6. newest-first pagination -------------------------------------------
  const p0 = await getTokensNewestFirst(factory, 0, 2);
  const p1 = await getTokensNewestFirst(factory, 1, 2);
  const p9 = await getTokensNewestFirst(factory, 9, 2);
  check(
    "page 0 (size 2) is [C, B] — newest first",
    p0.entries.length === 2 && p0.entries[0].token === c.token && p0.entries[1].token === b.token,
  );
  check("page 1 (size 2) is [A]", p1.entries.length === 1 && p1.entries[0].token === a.token);
  check("page past the end is empty, total still 3", p9.entries.length === 0 && p9.total === 3);

  // -- 7. trust badges: fresh state ------------------------------------------
  const detA = await getTokenDetails(provider, p1.entries[0]);
  const infoB = p0.entries[1];
  const detB = await getTokenDetails(provider, infoB);
  const badgesA = trustBadges(detA);
  const badgesB = trustBadges(detB);
  check("A: Factory verified badge", badgesA.factoryVerified === true);
  check("A (mintable, owned): no renounced / no fixed-supply badge", !badgesA.renounced && !badgesA.fixedSupply);
  check("A: owner() == creator before renounce", detA.owner === wallet.address);
  check("B (mintable=false): Fixed supply badge", badgesB.fixedSupply === true);
  check("B: decimals read back as 6", detB.decimals === 6);
  check(
    "B: supply formats with separators",
    formatAmount(detB.totalSupply, detB.decimals) === "500,000",
    formatAmount(detB.totalSupply, detB.decimals),
  );

  // -- 8. renounce A, badge flips --------------------------------------------
  const tokenA = new Contract(a.token, TOKEN_ABI, deployer);
  await (await tokenA.renounceOwnership()).wait();
  const detA2 = await getTokenDetails(provider, detA);
  const badgesA2 = trustBadges(detA2);
  check("A after renounce: owner() == 0x0", detA2.owner === ZeroAddress, detA2.owner);
  check("A after renounce: Ownership renounced badge", badgesA2.renounced === true);
  check("A after renounce: still Factory verified", badgesA2.factoryVerified === true);

  // -- 9. underpaying the fee reverts ----------------------------------------
  let reverted = false;
  let reason = "";
  try {
    await launchToken(
      factory,
      { name: "Cheap", symbol: "CHP", decimals: 18, initialSupply: 1n, maxSupply: 0n, mintable: false },
      fee - 1n,
    );
  } catch (e) {
    reverted = true;
    reason = String(e?.reason ?? e?.message ?? e);
  }
  check("underpaid launch reverts with FACTORY: fee", reverted && reason.includes("FACTORY: fee"), reason);

  provider.destroy();
}

// ------------------------------------------------------------------ runner
console.log(`starting anvil --port ${PORT} --chain-id ${CHAIN_ID} ...`);
const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", String(CHAIN_ID), "--silent"], {
  stdio: ["ignore", "ignore", "pipe"],
});
let anvilErr = "";
anvil.stderr.on("data", (d) => (anvilErr += d));

try {
  await main(anvil);
} catch (err) {
  failed++;
  console.error(`\nUNEXPECTED ERROR: ${err?.stack ?? err}`);
  if (anvilErr) console.error(`anvil stderr:\n${anvilErr}`);
} finally {
  anvil.kill("SIGTERM");
}

console.log(`\ne2e result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
