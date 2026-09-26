/* Playwright smoke for the validators lane (Step 1: checkpoint attestation, no consensus change —
   scratchpad/validators/PLAN.md; the read surface verified against agents/contracts/src/validators/
   {ValidatorHub,ValidatorHubLens}.sol as they stood on 2026-09-25, see src/validators/abi.ts). Runs against
   the real production build (`npm run build`, then `vite preview`), so this is the same bundle nginx would
   ship, minus the server's own headers. The build is made with VITE_VALIDATOR_HUB(_LENS) set (see
   playwright.config.ts webServer.command): that is the ONLY difference from a normal build — the checked-in
   contracts.3961.json still has validatorHub/validatorHubLens: null, so production stays byte-for-byte
   unchanged by this lane until the contracts/deploy lanes turn it on for real (verified separately:
   `npm run build` with no env vars reproduces DEPLOY.md's checked-in CSP hash).
   Every chain read is a static mock (mockRpc below), built from the same ABI the app uses (src/validators/
   abi.ts), so the mock and the app can never silently drift apart: no network call reaches rpc.ferminux.net,
   the index or the gateway. */
import { test, expect, type Page, type Route } from "@playwright/test";
import { hub, lens } from "../src/validators/abi";

const HEAD = 400_200; // a checkpoint height itself (400200 % 200 === 0), so it's the newest row
const SIGNERS = ["0x3322f60acea9f88658665e83beb30a516036187d", "0x71377e0f553a5b0cb847443ab6648235977919b0"];
const en = (n: number) => n.toLocaleString("en-US");

/** One seat, deliberately mixed: bonded but jailed, a queued attester rotation, both a deposit and
 *  claimable rewards non-zero. Field order matches ValidatorHub.Seat's declaration (abi.ts's own comment
 *  explains why order, not names, is what ABI struct encoding keys on). */
const SEAT = {
  claimable: 1_500_000_000_000_000_000n, // 1.5 FMX
  lastAttestedCp: BigInt((HEAD - 400) / 200),
  dutyStartCp: 1n,
  activationBlock: 300_050n,
  countedSince: 386_400n,
  status: 1n, // Bonded
  jailed: true,
  owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  unjailBlock: BigInt(HEAD - 50),
  unbondEndBlock: 0n,
  slashState: 0n,
  qualified: false,
  attester: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  deposit: 2000n * 10n ** 18n,
  pendingAttester: "0xdddddddddddddddddddddddddddddddddddddddd",
  attesterRotateBlock: BigInt(HEAD + 500),
  signingKey: "0x0000000000000000000000000000000000000000",
  rewardTo: "0xcccccccccccccccccccccccccccccccccccccccc",
};

/** ValidatorHub.certifies(): eligible ≥ 30 and count ≥ max(20, ceil(2/3·eligible)). The newest checkpoint
 *  (HEAD) is deliberately short of that, so the smoke exercises both badge states. checkpoint() returns the
 *  full Checkpoint struct, with `certified` already computed on-chain (this mock computes it the same way
 *  attestBatch() does, so it stays honest about what the real contract would store). */
function mockCheckpoint(height: number): { blockHash: string; count: number; eligible: number; total: number; snapshotBlock: number; certified: boolean } {
  if (height <= 0) return { blockHash: "0x" + "00".repeat(32), count: 0, eligible: 0, total: 0, snapshotBlock: 0, certified: false };
  const eligible = 40, count = height === HEAD ? 12 : 28, total = count;
  const need = Math.max(20, Math.ceil((2 * eligible) / 3));
  return { blockHash: "0x" + height.toString(16).padStart(64, "0"), count, eligible, total, snapshotBlock: height + 64, certified: eligible >= 30 && count >= need };
}

function rawBlock(n: number) {
  const h = (v: number) => "0x" + Math.max(0, v).toString(16);
  return {
    number: h(n), hash: "0x" + n.toString(16).padStart(64, "0"), parentHash: "0x" + Math.max(0, n - 1).toString(16).padStart(64, "0"),
    timestamp: h(Math.floor(Date.now() / 1000) - (HEAD - n) * 7), miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x2", extraData: "0x" + "00".repeat(32) + "00".repeat(65), gasLimit: h(100_000_000), gasUsed: h(21_000),
    baseFeePerGas: h(1_000_000_000), size: h(600), nonce: "0x0000000000000000",
    mixHash: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32),
    transactionsRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256),
    totalDifficulty: h(n * 2), transactions: [] as string[], uncles: [] as string[],
  };
}

/** One JSON-RPC call → one reply, keyed off the app's own ABIs (abi.ts) so a re-sync against the real
 *  contracts only ever needs this file's fixtures touched, never its selector-matching logic. `to`
 *  distinguishes the hub from the lens (client.ts calls each at its own configured address). */
function reply(call: { id: number; method: string; params: unknown[] }): { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } } {
  const { id, method, params } = call;
  const ok = (result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
  const err = (message: string) => ({ jsonrpc: "2.0" as const, id, error: { code: -32000, message } });
  if (method === "eth_blockNumber") return ok("0x" + HEAD.toString(16));
  if (method === "eth_getBlockByNumber") {
    const tag = params[0] as string;
    return ok(rawBlock(tag === "latest" ? HEAD : parseInt(tag, 16)));
  }
  if (method === "clique_getSigner") return ok(SIGNERS[parseInt(params[0] as string, 16) % SIGNERS.length]);
  if (method === "clique_getSigners") return ok(SIGNERS);
  if (method === "eth_call") {
    const { data } = params[0] as { to: string; data: string };
    const selector = data.slice(0, 10);
    try {
      if (selector === hub.getFunction("seatCount")!.selector) return ok(hub.encodeFunctionResult("seatCount", [37n]));
      if (selector === hub.getFunction("eligibleCount")!.selector) return ok(hub.encodeFunctionResult("eligibleCount", [31n]));
      if (selector === hub.getFunction("checkpoint")!.selector) {
        const [height] = hub.decodeFunctionData("checkpoint", data);
        const cp = mockCheckpoint(Number(height));
        return ok(hub.encodeFunctionResult("checkpoint", [[cp.blockHash, cp.count, cp.eligible, cp.total, cp.snapshotBlock, cp.certified]]));
      }
      if (selector === hub.getFunction("attested")!.selector) {
        const [, height] = hub.decodeFunctionData("attested", data);
        // a deterministic pattern so the strip shows both colours: miss every 5th checkpoint
        return ok(hub.encodeFunctionResult("attested", [Number(height) % 1000 !== 0]));
      }
      if (selector === hub.getFunction("participation")!.selector) {
        const [, n] = hub.decodeFunctionData("participation", data);
        return ok(hub.encodeFunctionResult("participation", [Number(n) - Math.floor(Number(n) / 5)]));
      }
      if (selector === lens.getFunction("seat")!.selector) {
        const [seatId] = lens.decodeFunctionData("seat", data);
        if (seatId !== 7n) return ok(lens.encodeFunctionResult("seat", [[0, 0, 0, 0, 0, 0, false, "0x0000000000000000000000000000000000000000", 0, 0, 0, false, "0x0000000000000000000000000000000000000000", 0, "0x0000000000000000000000000000000000000000", 0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"]]));
        return ok(lens.encodeFunctionResult("seat", [[SEAT.claimable, SEAT.lastAttestedCp, SEAT.dutyStartCp, SEAT.activationBlock, SEAT.countedSince, SEAT.status, SEAT.jailed, SEAT.owner, SEAT.unjailBlock, SEAT.unbondEndBlock, SEAT.slashState, SEAT.qualified, SEAT.attester, SEAT.deposit, SEAT.pendingAttester, SEAT.attesterRotateBlock, SEAT.signingKey, SEAT.rewardTo]]));
      }
    } catch { /* an undecodable call: fall through to the generic revert below */ }
    return err("execution reverted: unknown selector");
  }
  return err(`mockRpc: unhandled method ${method}`);
}

function rpcHandler(route: Route) {
  const body = route.request().postDataJSON() as unknown;
  const calls = Array.isArray(body) ? body : [body];
  const results = (calls as { id: number; method: string; params: unknown[] }[]).map(reply);
  void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? results : results[0]) });
}

/** Mocks the chain RPC; the index and the gateway 404 fast (this lane never reads either, but book.ts /
 *  signer.ts warm them on every page load regardless — a fast 404 keeps that from slowing the test down). */
async function mockChain(page: Page) {
  await page.route(/^https:\/\/rpc\.ferminux\.net\/?$/, rpcHandler);
  await page.route(/\/api\/v2\//, (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"message":"Not found"}' }));
  await page.route(/^https:\/\/ferminux\.net\/api\//, (route) => route.fulfill({ status: 404, contentType: "application/json", body: "[]" }));
}

for (const vp of [{ name: "390 (phone)", width: 390, height: 844 }, { name: "1440 (desktop)", width: 1440, height: 900 }]) {
  test.describe(`validators @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("nav: hidden by default, revealed once the hub is configured, navigates to /validators", async ({ page }) => {
      await mockChain(page);
      await page.goto("/");
      const headerLink = page.locator(".xnav [data-validators-link]");
      if (vp.width >= 1100) {
        await expect(headerLink).toBeVisible();
        await headerLink.click();
      } else {
        await expect(headerLink).toBeHidden(); // the header nav itself is CSS-hidden below 1100; the sheet carries it there
        await page.getByRole("button", { name: "Menu" }).click();
        const sheetLink = page.locator("#menu-sheet [data-validators-link]");
        await expect(sheetLink).toBeVisible();
        await sheetLink.click();
      }
      await expect(page).toHaveURL(/\/validators$/);
      await expect(page.getByRole("heading", { level: 1, name: "Validators" })).toBeVisible();
    });

    test("/validators: seats, eligible count and recent checkpoints with a certified badge", async ({ page }) => {
      await mockChain(page);
      await page.goto("/validators");
      await expect(page.getByRole("heading", { level: 1, name: "Validators" })).toBeVisible();
      await expect(page.locator('[data-k="seats"]')).toHaveText("37"); // seatCount()
      await expect(page.locator('[data-k="elig"]')).toHaveText("31"); // eligibleCount()
      const table = page.getByRole("table", { name: "Recent checkpoints" });
      await expect(table).toBeVisible();
      await expect(table.getByText("Certified", { exact: true }).first()).toBeVisible();
      await expect(table.getByText("Attested by 12")).toBeVisible(); // HEAD: 12 of 40, below threshold
      // the certified row (HEAD - 200) links to its block
      const certifiedHeight = en(HEAD - 200);
      await expect(table.getByRole("link", { name: certifiedHeight })).toHaveAttribute("href", `/block/${HEAD - 200}`);
    });

    test("/validators/:id: owner, jail state, a pending rotation, rewards and the attestation strip", async ({ page }) => {
      await mockChain(page);
      await page.goto("/validators/7");
      await expect(page.getByRole("heading", { level: 1, name: "Validator seat #7" })).toBeVisible();
      // ethers checksums the address on decode (EIP-55 mixed case), so match it case-insensitively
      await expect(page.getByText(new RegExp(SEAT.owner, "i"))).toBeVisible();
      await expect(page.getByText("Jailed", { exact: true })).toBeVisible();
      await expect(page.getByText("Pending attester", { exact: true })).toBeVisible();
      await expect(page.getByText("1.5", { exact: false })).toBeVisible(); // claimable
      await expect(page.getByText(/Attested .* of the last 32 closed checkpoints/)).toBeVisible();
      await expect(page.locator(".vd-part li").first()).toBeVisible();
    });

    test("an unopened seat 404s instead of showing an empty owner", async ({ page }) => {
      await mockChain(page);
      await page.goto("/validators/9999");
      await expect(page.getByRole("heading", { level: 1, name: /hasn't been opened/ })).toBeVisible();
    });

    test("a checkpoint block page shows the certified badge", async ({ page }) => {
      await mockChain(page);
      const height = HEAD - 200;
      await page.goto(`/block/${height}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(en(height));
      await expect(page.getByText("Certified", { exact: true })).toBeVisible();
    });

    test("a non-checkpoint block page never fetches the hub", async ({ page }) => {
      await mockChain(page);
      let hubCalls = 0;
      await page.route(/^https:\/\/rpc\.ferminux\.net\/?$/, async (route) => {
        const body = route.request().postDataJSON() as unknown;
        const calls = Array.isArray(body) ? body : [body];
        if (calls.some((c) => (c as { method?: string }).method === "eth_call")) hubCalls++;
        rpcHandler(route);
      });
      await page.goto(`/block/${HEAD - 1}`); // 400,199: not a multiple of 200
      await expect(page.getByRole("heading", { level: 1 })).toContainText(en(HEAD - 1));
      await expect(page.getByText("Certified", { exact: true })).toHaveCount(0);
      expect(hubCalls).toBe(0);
    });
  });
}
