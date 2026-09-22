// Mock gateway/chain state for Addendum v3 (Agent Economy), used only when VITE_MOCK=1. Shapes match
// the real gateway (gateway/src/v3/*.ts) and contracts (../contracts/abi/*.json), not the earlier
// inferred version of this file. Kept separate from the large existing mock.ts. Dynamically imported
// by economy.ts.
import { formatEther, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { AGENTS, JOBS, MOCK_WALLET } from "./mock";
import type {
  AccountRow, AccountView, AgentTokenView, ArbiterCase, ArbiterPoolView, Author, CaseEvidenceRow, ComputeListing, MemoryKeyView, MemoryQuota,
  PayinAssets, PayinChainInfo, PayinQuote, PayinQuoteRequest, PayinStatus, PlanView, ReputationSummary, StreamView, SubView, VoucherRecord, WebhookEvent, WebhookView, X402PayerView, X402Resource,
} from "./types";

const now = Math.floor(Date.now() / 1000);
const E = (n: string) => parseEther(n).toString();
const delay = <T,>(v: T, ms = 220) => new Promise<T>((res) => setTimeout(() => res(v), ms));
const owners = ["0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"];
const author = (addr: string): Author => { const a = AGENTS.find((x) => x.owner.toLowerCase() === addr.toLowerCase()); return a ? { address: a.owner, name: a.name, agentId: a.id } : { address: addr, name: null, agentId: null }; };
const own = (name: string) => AGENTS.find((a) => a.name === name)!.owner;
const agentOf = (name: string) => AGENTS.find((a) => a.name === name)!;
const randAddr = () => "0x" + Array.from(crypto.getRandomValues(new Uint8Array(20))).map((b) => b.toString(16).padStart(2, "0")).join("");

/* ============================================================== C1 x402 */
const RESOURCES: X402Resource[] = [
  { agentId: agentOf("Scribe").id, agentName: "Scribe", owner: agentOf("Scribe").owner, pricePerCallWei: E("0.05"), resource: "/a/scribe/invoke", description: "Summarise or translate up to 4 KB of text per call." },
  { agentId: agentOf("Prism").id, agentName: "Prism", owner: agentOf("Prism").owner, pricePerCallWei: E("0.02"), resource: "/a/prism/invoke", description: "Caption one image." },
  { agentId: agentOf("Ledger").id, agentName: "Ledger", owner: agentOf("Ledger").owner, pricePerCallWei: E("0.08"), resource: "/a/ledger/invoke", description: "Extract one invoice." },
];
export const x402Resources = () => delay({ items: RESOURCES });
export const x402SupportedInfo = () => delay({ x402Version: 1, kinds: [{ scheme: "ferminux-voucher", network: "ferminux:3961", asset: "FMX", vault: null, settlement: "disabled", facilitator: null }], domain: { name: "FerminuxX402", version: "1", chainId: 3961, verifyingContract: null } });

let vaultBalance = E("12.5"), vaultUnlockAt: number | null = null, vaultNonce = 40;
const VOUCHERS: VoucherRecord[] = [
  { payer: MOCK_WALLET, payee: own("Scribe"), amount: E("0.05"), nonce: "12", expiry: now + 3600, ref: keccak256(toUtf8Bytes("call-1")), resource: "/a/scribe/invoke", status: "settled", txHash: "0x" + "b4".repeat(32).slice(0, 64), error: null, createdAt: now - 900, settledAt: now - 880 },
  { payer: MOCK_WALLET, payee: own("Scribe"), amount: E("0.05"), nonce: "13", expiry: now + 3600, ref: keccak256(toUtf8Bytes("call-2")), resource: "/a/scribe/invoke", status: "settled", txHash: "0x" + "c7".repeat(32).slice(0, 64), error: null, createdAt: now - 700, settledAt: now - 680 },
  { payer: MOCK_WALLET, payee: own("Prism"), amount: E("0.02"), nonce: "3", expiry: now + 3600, ref: keccak256(toUtf8Bytes("call-3")), resource: "/a/prism/invoke", status: "queued", txHash: null, error: null, createdAt: now - 60, settledAt: null },
];
export function x402Payer(addr: string): Promise<X402PayerView> {
  const mine = addr.toLowerCase() === MOCK_WALLET.toLowerCase();
  const vouchers = mine ? VOUCHERS.slice().sort((a, b) => b.createdAt - a.createdAt) : [];
  const pending = vouchers.filter((v) => v.status === "queued" || v.status === "submitted");
  let pendingWei = 0n; for (const v of pending) pendingWei += BigInt(v.amount);
  return delay({ address: addr, vault: null, balance: mine ? vaultBalance : "0", unlockAt: mine ? vaultUnlockAt : null, pendingWei: pendingWei.toString(), pending, settledCount: vouchers.filter((v) => v.status === "settled").length, vouchers });
}
export function x402Deposit(amountWei: bigint) { vaultBalance = (BigInt(vaultBalance) + amountWei).toString(); return delay({ balance: vaultBalance }, 500); }
export function x402RequestUnlock() { vaultUnlockAt = now + 3600; return delay({ unlockAt: vaultUnlockAt }, 400); }
export function x402Withdraw(amountWei: bigint) { vaultBalance = (BigInt(vaultBalance) - amountWei > 0n ? BigInt(vaultBalance) - amountWei : 0n).toString(); vaultUnlockAt = null; return delay({ balance: vaultBalance }, 500); }
export function x402RecordVoucher(payee: string, amountWei: bigint, ref: string) {
  const v: VoucherRecord = { payer: MOCK_WALLET, payee, amount: amountWei.toString(), nonce: String(++vaultNonce), expiry: now + 3600, ref, resource: "", status: "queued", txHash: null, error: null, createdAt: now, settledAt: null };
  VOUCHERS.unshift(v); return delay(v, 400);
}

/* ============================================================== C2 accounts (gateway: AccountRow only; sessions/balance are mock-only extras used directly by the wallet page) */
const ACCOUNTS: AccountView[] = [
  {
    account: "0x" + "aa".repeat(20), owner: MOCK_WALLET, createdAt: now - 86400 * 6, txHash: "0x" + "aa".repeat(32).slice(0, 64), balanceWei: E("4.2"),
    sessions: [
      { key: "0x" + "11".repeat(20), capPerDayWei: E("5"), spentTodayWei: E("1.3"), expiry: now + 86400 * 20, anyTarget: false, targets: [own("Scribe")] },
      { key: "0x" + "22".repeat(20), capPerDayWei: E("2"), spentTodayWei: E("2"), expiry: now - 3600, anyTarget: true, targets: [] },
    ],
  },
];
export const myAccounts = (owner: string) => delay({ items: ACCOUNTS.filter((a) => a.owner.toLowerCase() === owner.toLowerCase()) });
export function createAccount(owner: string): Promise<AccountRow> {
  const a: AccountView = { account: randAddr(), owner, createdAt: now, txHash: "0x" + "cc".repeat(32).slice(0, 64), balanceWei: "0", sessions: [] };
  ACCOUNTS.unshift(a); return delay(a, 500);
}
export function addSession(account: string, key: string, capPerDayWei: string, expiry: number, targets: string[]) {
  const a = ACCOUNTS.find((x) => x.account === account); if (!a) return Promise.reject(new Error("Account not found."));
  (a.sessions ??= []).unshift({ key, capPerDayWei, spentTodayWei: "0", expiry, anyTarget: targets.length === 0, targets });
  return delay(a, 400);
}
export function revokeSession(account: string, key: string) {
  const a = ACCOUNTS.find((x) => x.account === account); if (!a) return Promise.reject(new Error("Account not found."));
  a.sessions = (a.sessions ?? []).filter((s) => s.key !== key); return delay(a, 300);
}

/* ============================================================== C3 streams */
const STREAMS: StreamView[] = [
  { id: 501, payer: author(MOCK_WALLET), payee: author(own("Scribe")), ratePerSec: "115740740740", deposit: E("5"), claimed: E("1.1"), start: now - 3600 * 9, stop: now - 3600 * 9 + Math.floor(Number(E("5")) / 115740740740), cancelled: false, status: "open", txOpened: "0x" + "51".repeat(32).slice(0, 64) },
  { id: 498, payer: author(owners[0]), payee: author(MOCK_WALLET), ratePerSec: "57870370370", deposit: E("2"), claimed: E("0.4"), start: now - 3600 * 20, stop: now - 3600 * 20 + Math.floor(Number(E("2")) / 57870370370), cancelled: false, status: "open", txOpened: "0x" + "52".repeat(32).slice(0, 64) },
];
const PLANS: (PlanView & { name?: string })[] = [
  { id: 21, payee: author(own("Ledger")), pricePerPeriod: E("2"), period: 7 * 86400, active: true, metadataURI: "fmx://payload/plan21", createdAt: now - 86400 * 30, activeSubs: 14, name: "Ledger — weekly extraction" },
  { id: 22, payee: author(own("Sentry")), pricePerPeriod: E("15"), period: 30 * 86400, active: true, metadataURI: "fmx://payload/plan22", createdAt: now - 86400 * 60, activeSubs: 6, name: "Sentry — monthly audit retainer" },
  { id: 23, payee: author(MOCK_WALLET), pricePerPeriod: E("1"), period: 86400, active: true, metadataURI: "fmx://payload/plan23", createdAt: now - 86400 * 10, activeSubs: 3, name: "Scribe — daily digest" },
];
const SUBS: SubView[] = [
  { id: 900, planId: 21, payer: author(MOCK_WALLET), paidThrough: now + 3 * 86400, cancelled: false, createdAt: now - 4 * 86400, payee: PLANS[0].payee, pricePerPeriod: PLANS[0].pricePerPeriod, period: PLANS[0].period, active: true },
];
export const myStreams = (addr: string) => delay({ items: STREAMS.filter((s) => s.payer.address.toLowerCase() === addr.toLowerCase() || s.payee.address.toLowerCase() === addr.toLowerCase()) });
export const myPlans = (addr: string) => delay({ items: PLANS.filter((p) => p.payee.address.toLowerCase() === addr.toLowerCase()) });
export const allPlans = () => delay({ items: PLANS.filter((p) => p.active) });
export const mySubs = (addr: string) => delay({ items: SUBS.filter((s) => s.payer.address.toLowerCase() === addr.toLowerCase()) });
export function claimableOf(s: StreamView): bigint {
  const elapsed = BigInt(Math.max(0, Math.min(now, Number(s.stop)) - Number(s.start)));
  const accrued = elapsed * BigInt(s.ratePerSec);
  const claimable = accrued - BigInt(s.claimed);
  return claimable > 0n ? claimable : 0n;
}
export function openStream(payee: string, ratePerSec: string, deposit: string) {
  const id = 500 + STREAMS.length + 1;
  const s: StreamView = { id, payer: author(MOCK_WALLET), payee: author(payee), ratePerSec, deposit, claimed: "0", start: now, stop: now + Math.floor(Number(deposit) / Number(ratePerSec)), cancelled: false, status: "open", txOpened: null };
  STREAMS.unshift(s); return delay(s, 500);
}
export function claimStream(id: number) {
  const s = STREAMS.find((x) => x.id === id); if (!s) return Promise.reject(new Error("Stream not found."));
  s.claimed = (BigInt(s.claimed) + claimableOf(s)).toString(); return delay(s, 400);
}
export function cancelStream(id: number) {
  const s = STREAMS.find((x) => x.id === id); if (!s) return Promise.reject(new Error("Stream not found."));
  s.cancelled = true; s.status = "cancelled"; return delay(s, 400);
}
export function subscribe(planId: number, periods: number) {
  const p = PLANS.find((x) => x.id === planId); if (!p) return Promise.reject(new Error("Plan not found."));
  const sub: SubView = { id: 900 + SUBS.length + 1, planId, payer: author(MOCK_WALLET), paidThrough: now + periods * p.period, cancelled: false, createdAt: now, payee: p.payee, pricePerPeriod: p.pricePerPeriod, period: p.period, active: true };
  SUBS.unshift(sub); return delay(sub, 500);
}
export function cancelSub(id: number) { const s = SUBS.find((x) => x.id === id); if (!s) return Promise.reject(new Error("Not found.")); s.cancelled = true; s.active = false; return delay(s, 400); }
export function setPlanActive(planId: number, active: boolean) {
  const p = PLANS.find((x) => x.id === planId); if (!p) return Promise.reject(new Error("Plan not found."));
  p.active = active; return delay(p, 400);
}
export function createPlan(pricePerPeriod: string, period: number, name: string) {
  const p: PlanView & { name?: string } = { id: 20 + PLANS.length + 1, payee: author(MOCK_WALLET), pricePerPeriod, period, active: true, metadataURI: `fmx://payload/plan-${Date.now()}`, createdAt: now, activeSubs: 0, name };
  PLANS.unshift(p); return delay(p, 500);
}

/* ============================================================== C4 disputes */
const disputedJob = JOBS.find((j) => j.status === "Disputed");
let nextEvidenceId = 900;
const CASES: ArbiterCase[] = disputedJob ? [{
  id: 71, jobId: disputedJob.id, agentId: disputedJob.agentId, client: disputedJob.client, opener: author(MOCK_WALLET),
  evidenceURI: "fmx://payload/" + keccak256(toUtf8Bytes("evidence-71")),
  evidence: [
    { id: ++nextEvidenceId, caseId: 71, by: MOCK_WALLET, uri: "fmx://payload/" + keccak256(toUtf8Bytes("evidence-71")), ts: now - 3600 * 20, txHash: null },
    { id: ++nextEvidenceId, caseId: 71, by: own("Ledger"), uri: "fmx://payload/" + keccak256(toUtf8Bytes("reply-71")), ts: now - 3600 * 14, txHash: null },
  ],
  openedAt: now - 3600 * 20, votes: 2, closed: false, status: "open", result: null, closedAt: null, txOpened: null,
}] : [];
const CASE_VOTES = new Map<number, { arbiter: string; clientBps: number }[]>([[71, [{ arbiter: own("Sentry"), clientBps: 6000 }, { arbiter: own("Cipher"), clientBps: 5500 }]]]);
const poolStake = new Map<string, bigint>([[own("Sentry"), 500n * 10n ** 18n], [own("Cipher"), 750n * 10n ** 18n], [own("Atlas"), 500n * 10n ** 18n]]);
export const casesList = (status?: string) => delay({ items: status ? CASES.filter((c) => c.status === status) : CASES.slice() });
export function arbiterCase(id: number) { const c = CASES.find((x) => x.id === id); return c ? delay(c) : Promise.reject(Object.assign(new Error("Not found."), { status: 404 })); }
export function caseVotes(caseId: number) { return delay(CASE_VOTES.get(caseId) ?? []); }
export function arbiterPool(addr?: string): Promise<ArbiterPoolView> {
  return delay({ minStakeWei: E("500"), votingWindowSec: 3 * 86400, quorum: 3, arbiterCount: poolStake.size, myStakeWei: addr ? (poolStake.get(addr)?.toString() ?? null) : null });
}
export function joinPool(addr: string, amountWei: bigint) { poolStake.set(addr, (poolStake.get(addr) ?? 0n) + amountWei); return delay({ ok: true }, 500); }
export function leavePool(addr: string) { poolStake.delete(addr); return delay({ ok: true }, 500); }
export function submitEvidence(caseId: number, by: string, uri: string) {
  const c = CASES.find((x) => x.id === caseId); if (!c) return Promise.reject(new Error("Not found."));
  const row: CaseEvidenceRow = { id: ++nextEvidenceId, caseId, by, uri, ts: now, txHash: null };
  c.evidence.push(row); return delay(c, 400);
}
export function voteCase(caseId: number, by: string, clientBps: number) {
  const c = CASES.find((x) => x.id === caseId); if (!c) return Promise.reject(new Error("Not found."));
  const votes = CASE_VOTES.get(caseId) ?? []; votes.push({ arbiter: by, clientBps }); CASE_VOTES.set(caseId, votes);
  c.votes = votes.length; return delay(c, 400);
}
export function closeCase(caseId: number) {
  const c = CASES.find((x) => x.id === caseId); if (!c) return Promise.reject(new Error("Not found."));
  const votes = CASE_VOTES.get(caseId) ?? []; const sorted = votes.map((v) => v.clientBps).sort((a, b) => a - b);
  c.result = sorted[Math.floor(sorted.length / 2)] ?? 5000; c.closed = true; c.status = "closed"; c.closedAt = now; return delay(c, 500);
}

/* ============================================================== C5 ERC-8004 */
const RATED_AGENTS: Record<number, { avg: number; count: number }> = { 1: { avg: 4.8, count: 60 }, 3: { avg: 4.9, count: 22 }, 6: { avg: 4.4, count: 140 } };
export function reputationSummary(agentId: number): Promise<ReputationSummary> {
  const r = RATED_AGENTS[agentId];
  return delay(r ? { agentId, count: r.count, avg: r.avg } : { agentId, count: 0, avg: null });
}
/** GET /api/agents/:id embeds this — mirrored here so mock.ts's agent()/agents() can attach it inline. */
export function mockValidationFor(agentId: number) {
  if (agentId !== 3) return { count: 0, avgResponse: null, latest: null };
  return {
    count: 1, avgResponse: 96,
    latest: { requestHash: keccak256(toUtf8Bytes("val-3")), validator: own("Cipher"), agentId: 3, jobId: null, requestURI: "fmx://payload/val-3-req", response: 96, responseURI: "fmx://payload/val-3-res", tag: "audit-quality", requestedAt: now - 3600 * 6, respondedAt: now - 3600 * 5, txRequest: null, txResponse: null },
  };
}
export function mockLinksFor(agentId: number) {
  return { a2a: `https://ferminux.net/a/${agentId}/.well-known/agent.json`, erc8004: `https://ferminux.net/api/agents/${agentId}/erc8004.json`, audit: `https://ferminux.net/api/agents/${agentId}/audit.jsonl` };
}

/* ============================================================== C6 tokens */
const TOKENS: AgentTokenView[] = [
  { token: "0x" + "5c".repeat(20), agentId: agentOf("Scribe").id, symbol: "SCRB", launchedAt: now - 86400 * 20, buys: 61, sells: 12, fmxIn: E("48"), fmxOut: E("6.8"), distributed: E("2.1"), txLaunched: null, agentName: "Scribe", owner: own("Scribe"), agent: author(own("Scribe")), base: E("0.001"), slope: "2000000000", supply: E("184000"), reserveWei: E("41.2"), priceWei: (BigInt(E("0.001")) + BigInt("2000000000") * BigInt(E("184000")) / 10n ** 18n).toString(), totalDistributed: E("2.1"), claimableWei: E("0.14") },
  { token: "0x" + "5e".repeat(20), agentId: agentOf("Sentry").id, symbol: "SNTR", launchedAt: now - 86400 * 12, buys: 24, sells: 5, fmxIn: E("35"), fmxOut: E("4.2"), distributed: "0", txLaunched: null, agentName: "Sentry", owner: own("Sentry"), agent: author(own("Sentry")), base: E("0.01"), slope: "9000000000", supply: E("52000"), reserveWei: E("30.8"), priceWei: (BigInt(E("0.01")) + BigInt("9000000000") * BigInt(E("52000")) / 10n ** 18n).toString(), totalDistributed: "0", claimableWei: "0" },
];
export const tokensList = () => delay({ items: TOKENS.slice() });
export function tokenOf(agentId: number) { const t = TOKENS.find((x) => x.agentId === agentId); return delay(t ?? null); }
export function quoteBuy(symbol: string, fmxIn: bigint): bigint {
  const t = TOKENS.find((x) => x.symbol === symbol); if (!t) return 0n;
  const base = BigInt(t.base ?? "0"), slope = BigInt(t.slope ?? "0"), s = BigInt(t.supply ?? "0");
  // out solves fmxIn = base*out + slope*(s*out + out^2/2)/1e18 — approximate with current marginal price for the mock.
  const price = base + (slope * s) / 10n ** 18n;
  return price > 0n ? (fmxIn * 10n ** 18n) / price : 0n;
}
export function quoteSell(symbol: string, amountIn: bigint): bigint {
  const t = TOKENS.find((x) => x.symbol === symbol); if (!t) return 0n;
  const base = BigInt(t.base ?? "0"), slope = BigInt(t.slope ?? "0"), s = BigInt(t.supply ?? "0");
  const price = base + (slope * s) / 10n ** 18n;
  return (amountIn * price) / 10n ** 18n;
}
export function buyToken(symbol: string, fmxIn: bigint) {
  const t = TOKENS.find((x) => x.symbol === symbol); if (!t) return Promise.reject(new Error("Not found."));
  const out = quoteBuy(symbol, fmxIn); t.supply = (BigInt(t.supply ?? "0") + out).toString(); t.reserveWei = (BigInt(t.reserveWei ?? "0") + fmxIn).toString(); t.buys++; t.fmxIn = (BigInt(t.fmxIn) + fmxIn).toString();
  return delay({ out: out.toString() }, 500);
}
export function sellToken(symbol: string, amountIn: bigint) {
  const t = TOKENS.find((x) => x.symbol === symbol); if (!t) return Promise.reject(new Error("Not found."));
  const out = quoteSell(symbol, amountIn); const supply = BigInt(t.supply ?? "0") - amountIn; t.supply = (supply > 0n ? supply : 0n).toString();
  const reserve = BigInt(t.reserveWei ?? "0") - out; t.reserveWei = (reserve > 0n ? reserve : 0n).toString(); t.sells++; t.fmxOut = (BigInt(t.fmxOut) + out).toString();
  return delay({ out: out.toString() }, 500);
}
export function launchToken(agentId: number, symbol: string, baseWei: string, slope: string) {
  const a = AGENTS.find((x) => x.id === agentId); if (!a) return Promise.reject(new Error("Agent not found."));
  const t: AgentTokenView = { token: randAddr(), agentId, symbol, launchedAt: now, buys: 0, sells: 0, fmxIn: "0", fmxOut: "0", distributed: "0", txLaunched: null, agentName: a.name, owner: a.owner, agent: author(a.owner), base: baseWei, slope, supply: "0", reserveWei: "0", priceWei: baseWei, totalDistributed: "0", claimableWei: "0" };
  TOKENS.unshift(t); return delay(t, 600);
}

/* ============================================================== compute */
const COMPUTE: ComputeListing[] = [
  { id: 1, owner: author(own("Sentry")), name: "sentry-h100", url: "https://compute.sentry.agents.example", gpu: "H100 80GB", vramGb: 80, pricePerSecond: "138888888888889", region: "eu-central", endpoint: "https://compute.sentry.agents.example", online: true, lastSeen: now - 300, lastProbeAt: now - 300, createdAt: now - 86400 * 8 },
  { id: 2, owner: author(own("Atlas")), name: "atlas-a100", url: "https://compute.atlas.agents.example", gpu: "A100 40GB", vramGb: 40, pricePerSecond: "69444444444444", region: "us-east", endpoint: "https://compute.atlas.agents.example", online: true, lastSeen: now - 500, lastProbeAt: now - 500, createdAt: now - 86400 * 5 },
  { id: 3, owner: author(own("Prism")), name: "prism-4090", url: "https://gpu.prism.agents.example", gpu: "RTX 4090 24GB", vramGb: 24, pricePerSecond: "22222222222222", region: "eu-central", endpoint: "https://gpu.prism.agents.example", online: false, lastSeen: now - 4000, lastProbeAt: now - 4000, createdAt: now - 86400 * 2 },
];
export function computeList(q: { region?: string; q?: string } = {}) {
  let list = COMPUTE.slice();
  if (q.region) list = list.filter((c) => c.region === q.region);
  if (q.q) { const s = q.q.toLowerCase(); list = list.filter((c) => c.gpu.toLowerCase().includes(s) || c.region.includes(s)); }
  return delay({ items: list, total: list.length });
}

/* ============================================================== memory */
const MEMORY = new Map<string, { value: string; updatedAt: number; createdAt: number }>([
  ["agent-notes", { value: JSON.stringify({ lastRun: now - 900, wins: 12 }), updatedAt: now - 900, createdAt: now - 86400 }],
  ["session-cache", { value: "eyJzaWQiOiJhYmMxMjMifQ==", updatedAt: now - 3600 * 6, createdAt: now - 86400 * 3 }],
  ["prefs", { value: JSON.stringify({ theme: "dark", locale: "az" }), updatedAt: now - 86400 * 2, createdAt: now - 86400 * 9 }],
]);
const memPricing = { perBlockWei: E("0.01"), blockBytes: 64 * 1024, creditTtlSeconds: 30 * 86400, payTo: "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB" };
function memQuota(): MemoryQuota {
  const used = [...MEMORY.values()].reduce((s, v) => s + new TextEncoder().encode(v.value).length, 0);
  const free = 5 * 1024 * 1024;
  return { usedBytes: used, keys: MEMORY.size, freeBytes: free, paidBytes: 0, quotaBytes: free, pricing: memPricing };
}
export function memoryList(): Promise<{ items: MemoryKeyView[] } & MemoryQuota> {
  const items: MemoryKeyView[] = Array.from(MEMORY.entries()).map(([key, v]) => { const size = new TextEncoder().encode(v.value).length; return { key, size, bytes: size, createdAt: v.createdAt, updatedAt: v.updatedAt }; });
  return delay({ items, ...memQuota() });
}
export function memoryGet(key: string) {
  const v = MEMORY.get(key); if (!v) return Promise.reject(Object.assign(new Error("Not found."), { status: 404 }));
  let value: unknown = v.value; try { value = JSON.parse(v.value); } catch { /* raw text */ }
  return delay({ value, size: new TextEncoder().encode(v.value).length });
}
export function memoryPut(key: string, value: string) { MEMORY.set(key, { value, updatedAt: now, createdAt: MEMORY.get(key)?.createdAt ?? now }); return delay(memQuota(), 300); }
export function memoryDelete(key: string) { MEMORY.delete(key); return delay(memQuota(), 300); }

/* ============================================================== webhooks */
const WEBHOOKS: WebhookView[] = [
  { id: 1, owner: author(MOCK_WALLET), url: "https://hooks.example.com/ferminux", events: ["job.completed", "job.disputed", "dm.received"], active: true, secretHint: "whsk", createdAt: now - 86400 * 4, updatedAt: now - 86400 * 4, deliveries: { pending: 0, ok: 12, failed: 1 } },
];
export const webhooksMine = () => delay({ items: WEBHOOKS.slice() });
export function webhookSet(url: string, events: WebhookEvent[]) {
  const w: WebhookView = { id: WEBHOOKS.length ? Math.max(...WEBHOOKS.map((x) => x.id)) + 1 : 1, owner: author(MOCK_WALLET), url, events, active: true, secretHint: "whsk", createdAt: now, updatedAt: now, deliveries: { pending: 0, ok: 0, failed: 0 } };
  WEBHOOKS.unshift(w); return delay(w, 400);
}
export function webhookDelete(id: number) { const i = WEBHOOKS.findIndex((w) => w.id === id); if (i >= 0) WEBHOOKS.splice(i, 1); return delay({ ok: true }, 300); }

/* ============================================================== pay-in */
const randHash = () => "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
const PAYINS = new Map<string, { status: PayinStatus; polls: number }>();
const PAYIN_PRICE = "0.52"; // operator-fixed USD per FMX
const PAYIN_NATIVE_USD: Record<string, string> = { BNB: "805.12", ETH: "2776.4", POL: "0.4", AVAX: "22.5" };
const PAYIN_DEPOSIT = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const PAYIN_CHAINS_MOCK: (PayinChainInfo & { confirmations: number })[] = [
  { chain: "eth", chainId: 1, name: "Ethereum", explorer: "https://etherscan.io", confirmations: 6, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, stable: true },
    { symbol: "ETH", kind: "native", token: null, decimals: 18, stable: false },
  ] },
  { chain: "bsc", chainId: 56, name: "BNB Smart Chain", explorer: "https://bscscan.com", confirmations: 12, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, stable: true },
    { symbol: "BNB", kind: "native", token: null, decimals: 18, stable: false },
  ] },
  { chain: "base", chainId: 8453, name: "Base", explorer: "https://basescan.org", confirmations: 20, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, stable: true },
    { symbol: "ETH", kind: "native", token: null, decimals: 18, stable: false },
  ] },
  { chain: "arbitrum", chainId: 42161, name: "Arbitrum One", explorer: "https://arbiscan.io", confirmations: 20, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, stable: true },
    { symbol: "ETH", kind: "native", token: null, decimals: 18, stable: false },
  ] },
  { chain: "polygon", chainId: 137, name: "Polygon", explorer: "https://polygonscan.com", confirmations: 60, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, stable: true },
    { symbol: "POL", kind: "native", token: null, decimals: 18, stable: false },
  ] },
  { chain: "optimism", chainId: 10, name: "Optimism", explorer: "https://optimistic.etherscan.io", confirmations: 20, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, stable: true },
    { symbol: "ETH", kind: "native", token: null, decimals: 18, stable: false },
  ] },
  { chain: "avalanche", chainId: 43114, name: "Avalanche C-Chain", explorer: "https://snowtrace.io", confirmations: 6, depositAddress: PAYIN_DEPOSIT, assets: [
    { symbol: "USDC", kind: "erc20", token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, stable: true },
    { symbol: "USDT", kind: "erc20", token: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, stable: true },
    { symbol: "AVAX", kind: "native", token: null, decimals: 18, stable: false },
  ] },
];
export function payinAssets(): Promise<PayinAssets> {
  return delay({ enabled: true, priceUsdPerFmx: PAYIN_PRICE, spreadBps: 200, minUsd: 1, maxUsd: 10_000, expires: 900, chains: PAYIN_CHAINS_MOCK });
}
const unitsOf = (text: string, decimals: number): bigint => { const [w, f = ""] = text.split("."); return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals)); };
const fmtUnits = (u: bigint, decimals: number): string => { const d = 10n ** BigInt(decimals); const frac = (u % d).toString().padStart(decimals, "0").replace(/0+$/, ""); return `${u / d}.${frac || "0"}`; };
export function payinQuote(p: PayinQuoteRequest): Promise<PayinQuote> {
  const chain = PAYIN_CHAINS_MOCK.find((c) => c.chain === p.chain)!;
  const a = chain.assets.find((x) => x.symbol === p.asset);
  if (!a) return Promise.reject(Object.assign(new Error(`asset must be one of ${chain.assets.map((x) => x.symbol).join("|")} on ${chain.name}`), { status: 400 }));
  if (!/^\d+(\.\d+)?$/.test(p.amount) || Number(p.amount) <= 0) return Promise.reject(Object.assign(new Error(`amount must be a positive decimal ${a.symbol} amount like "10.00"`), { status: 400 }));
  const assetUsd = a.stable ? "1.0" : PAYIN_NATIVE_USD[a.symbol]!;
  const requested = unitsOf(p.amount, a.decimals);
  // supersede this payer's/recipient's other open quotes on the same (chain, asset): frees the exact
  // requested amount so a repeat request (e.g. retrying the same 5 USDT four times) doesn't need dust at all
  for (const row of PAYINS.values()) {
    const s = row.status;
    if (s.status !== "quoted" || s.chain !== p.chain || s.asset !== p.asset) continue;
    // match by address identity in EITHER role: a wallet that was the recipient on an old quote and shows up
    // as the payer on a new one (or vice versa) is still "the same wallet retrying"
    const oldAddrs = [s.target.toLowerCase(), s.payer?.toLowerCase()].filter(Boolean);
    const newAddrs = [p.to.toLowerCase(), p.from?.toLowerCase()].filter(Boolean);
    if (oldAddrs.some((a) => newAddrs.includes(a))) s.status = "superseded";
  }
  // unique amount per open quote on (chain, asset): dust is SUBTRACTED on collision (never adds to what the
  // payer has to send — a quote must never ask for more than the requested amount)
  const taken = new Set([...PAYINS.values()].filter((x) => x.status.chain === p.chain && x.status.asset === p.asset && x.status.status === "quoted").map((x) => x.status.amountUnits));
  let units = requested;
  while (taken.has(units.toString())) {
    units -= 1n;
    if (units <= 0n) return Promise.reject(Object.assign(new Error("too many open quotes at this amount; try a slightly different amount"), { status: 503 }));
  }
  const usd = Number(fmtUnits(units, a.decimals)) * Number(assetUsd);
  if (usd < 1 || usd > 10_000) return Promise.reject(Object.assign(new Error(`amount must be worth between 1 and 10000 USD (this is ≈ ${usd.toFixed(2)} USD)`), { status: 400 }));
  const fmxOut = parseEther(((usd * 0.98) / Number(PAYIN_PRICE)).toFixed(18)).toString();
  const quoteId = "q_" + Math.random().toString(36).slice(2, 10);
  const amount = fmtUnits(units, a.decimals);
  const dust = requested - units;
  const dustDirection: "down" | "up" | "none" = dust > 0n ? "down" : "none";
  const q: PayinQuote = {
    quoteId, chain: p.chain, chainId: chain.chainId, chainName: chain.name, asset: a.symbol, assetKind: a.kind, token: a.token, decimals: a.decimals,
    amount, amountRequested: fmtUnits(requested, a.decimals), dustUnits: dust.toString(), dustDirection, sendExactly: units.toString(), sendExactlyFormatted: amount,
    usd: usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0"), assetUsd, depositAddress: PAYIN_DEPOSIT, fmxOut, fmxOutFormatted: formatEther(fmxOut), priceUsdPerFmx: PAYIN_PRICE, spreadBps: 200,
    to: p.to, from: p.from ?? null, expiresAt: Math.floor(Date.now() / 1000) + 900, expires: 900, confirmations: chain.confirmations, status: "quoted", explorer: chain.explorer,
    note: `Send exactly ${amount} ${a.symbol} on ${chain.name} to ${PAYIN_DEPOSIT}; FMX is sent to ${p.to} after ${chain.confirmations} confirmations.${dust > 0n ? ` (${dust} unit${dust === 1n ? "" : "s"} below what you asked for, so the payment never exceeds your balance.)` : ""}`,
  };
  PAYINS.set(quoteId, { polls: 0, status: {
    quoteId, chain: p.chain, chainId: chain.chainId, asset: a.symbol, assetKind: a.kind, token: a.token, decimals: a.decimals, amount, amountUnits: units.toString(), sendExactly: units.toString(), sendExactlyFormatted: amount,
    usd: q.usd, usdc: q.usd, usdcUnits: "0", fmxOut, fmxOutFormatted: q.fmxOutFormatted, priceUsdPerFmx: PAYIN_PRICE, target: p.to, payer: p.from ?? null, depositAddress: PAYIN_DEPOSIT, status: "quoted",
    txHashIn: null, blockIn: null, confirmations: 0, required: chain.confirmations, txHashOut: null, txHashes: { deposit: null, fmx: null }, error: null, createdAt: q.expiresAt - 900, expiresAt: q.expiresAt, seenAt: null, paidAt: null, enabled: true,
  } });
  return delay(q, 500);
}
/** Demo ledger: a quote that was "paid" (markPayinSent) walks seen → confirmed → paid over successive polls. */
export function markPayinSent(quoteId: string, txHash: string): void {
  const p = PAYINS.get(quoteId); if (!p || p.status.status !== "quoted") return;
  p.status.txHashIn = txHash; p.status.status = "seen"; p.status.seenAt = Math.floor(Date.now() / 1000); p.status.confirmations = 1;
  p.status.txHashes.deposit = { chain: p.status.chain, chainId: p.status.chainId, hash: txHash, url: `${PAYIN_CHAINS_MOCK.find((c) => c.chain === p.status.chain)!.explorer}/tx/${txHash}` };
}
export function payinStatus(quoteId: string): Promise<PayinStatus> {
  const p = PAYINS.get(quoteId); if (!p) return Promise.reject(Object.assign(new Error("Quote not found."), { status: 404 }));
  const s = p.status;
  if (s.status === "seen") { p.polls++; s.confirmations = Math.min(12, 1 + p.polls * 4); if (s.confirmations >= 12) s.status = "confirmed"; }
  else if (s.status === "confirmed") { s.status = "paid"; s.paidAt = Math.floor(Date.now() / 1000); s.txHashOut = randHash(); s.txHashes.fmx = { chain: "ferminux", chainId: 3961, hash: s.txHashOut, url: `https://explorer.ferminux.net/tx/${s.txHashOut}` }; }
  return delay({ ...s, txHashes: { ...s.txHashes } });
}
