/* LAZY chunk (with decode.ts): the Ferminux sentence catalogue (surfaces/explorer.md §4.13, §6.4) and the
   decoded-argument renderer. Parties are hash chips resolved by the name book; amounts are FMX to 6 dp in
   sentences and exact in tables. Every decoded view carries the "Decoded · Ferminux ABI" tag; a bare selector
   never does. Addresses from call data and topics come back lower case, so `cs()` restores the checksum (./checksum, no ethers). */
import { checksum } from "../../enrich/checksum";
import { html, type Html, type Val, dash } from "../../ui/html";
import { addrChip } from "../../ui/hash";
import { prov, kindTag } from "../../ui/marks";
import { icon } from "../../ui/icons";
import { agentById, agentFor } from "../../book";
import { agentLinks, type Job } from "../../gateway";
import { units, int, dur, utc, short, safeHref } from "../../format";
import { lc, ZERO } from "../../util";
import { isLoadTestTx } from "../../loadtest";
import type { Tx, Log, TokenTransfer } from "../../types";
import {
  decodeInput, decodeLog, decodeRevert, bigOf, addrOf, strOf, boolOf, agentTokenSymbol,
  type DCall, type DLog, type DRevert, type Arg, type V, type AbiName,
} from "../../enrich/decode";

export { ready, methodName, decodeLog, decodeInput } from "../../enrich/decode";
export type { DCall, DLog, DRevert } from "../../enrich/decode";

/** Checksummed address (the book and the index return checksums; decoded words are lower case). */
export const cs = checksum;

/* ---------------------------------------------------------------- small marks */

const fmxS = (v: bigint | null | undefined): Html => (v === null || v === undefined ? dash("Not decoded") : html`<span class="num-mono">${units(v, 18, 6)}</span><span class="unit">FMX</span>`);
const tokS = (v: bigint | null, decimals: number, sym: string): Html => (v === null ? dash() : html`<span class="num-mono">${units(v, decimals, 6)}</span><span class="unit">${sym}</span>`);
const who = (a: string | null | undefined): Html => (!a ? dash() : addrChip(cs(a), { copy: false }));
const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? dash() : html`<b class="num-mono">#${v.toString()}</b>`);
/** An agent by registry id: its name chip on the owner's address (Agent jobs tab), or "agent #12". */
export function agentChip(id: bigint | number | null | undefined): Html {
  if (id === null || id === undefined) return html`the agent`;
  const a = agentById(Number(id));
  if (!a) return html`agent <b class="num-mono">#${id.toString()}</b>`;
  return addrChip(a.owner, { label: { name: a.name, kind: "agent", id: a.id }, href: `/address/${a.owner}?tab=jobs`, copy: false });
}
const STATUS = ["None", "Active", "Paused", "Retired"];

/* ---------------------------------------------------------------- the analysis of one transaction */

export interface Ctx { tx: Tx; logs: Log[]; tts: TokenTransfer[]; job?: Job | null }
export interface Analysis {
  input: DCall | null;
  events: DLog[];
  revert: DRevert | null;
  /** The sentence (null only when nothing at all can be said). */
  story: Html | null;
  /** The story carries decoded facts (tag it), not only the bare selector. */
  decoded: boolean;
  /** Index into `events` of the event the sentence came from (-1 = from the call itself). */
  from: number;
  /** Other events besides the one the sentence came from. */
  more: number;
  jobId: number | null;
  agentIds: number[];
}

export function analyse(c: Ctx): Analysis {
  const input = decodeInput(c.tx);
  const events = c.logs.map(decodeLog);
  const revert = c.tx.status === "error" ? decodeRevert(c.tx) : null;
  const a: Analysis = { input, events, revert, story: null, decoded: false, from: -1, more: 0, jobId: null, agentIds: [] };
  // job and agent ids named anywhere in the call or its events (the job rail and the agent cards use them)
  const jobs = new Set<number>(), agents = new Set<number>();
  const note = (d: { abi: AbiName | null; args: Arg[] | null } | null) => {
    if (!d?.args) return;
    const j = bigOf(d.args, "jobId");
    if (j !== null && (d.abi === "ServiceEscrow" || d.abi === "ArbiterPool" || d.abi === "ReputationRegistry8004")) jobs.add(Number(j));
    for (const k of ["agentId", "id", "fromAgentId", "toAgentId"]) {
      const v = bigOf(d.args, k);
      if (v !== null && (k !== "id" || d.abi === "AgentRegistry")) agents.add(Number(v));
    }
  };
  note(input);
  events.forEach(note);
  a.jobId = jobs.size ? [...jobs][0] : null;
  a.agentIds = [...agents];

  const s = sentence(c, a);
  a.story = s.html; a.decoded = s.decoded; a.from = s.from;
  a.more = Math.max(0, events.length - (s.from >= 0 ? 1 : 0) - (s.consumed ?? 0));
  if (c.tx.status === "error") a.story = html`<span class="warn-text">Failed:</span> ${a.story}`;
  return a;
}

/* ---------------------------------------------------------------- the catalogue (§6.4) */

type Out = { html: Html; decoded: boolean; from: number; consumed?: number };
type Rule = (d: DLog, c: Ctx, a: Analysis) => Html | null;

const R: Record<string, Rule> = {
  "ServiceEscrow.JobRequested": (d) => html`${who(addrOf(d.args, "client"))} hired ${agentChip(bigOf(d.args, "agentId"))} for job ${num(bigOf(d.args, "jobId"))} and put ${fmxS(bigOf(d.args, "amount"))} in escrow.`,
  "ServiceEscrow.JobDelivered": (d, c) => html`${who(c.tx.from.hash)} delivered job ${num(bigOf(d.args, "jobId"))}${c.job?.client ? html` for ${who(c.job.client)}` : ""}.`,
  "ServiceEscrow.JobCompleted": (d, c, a) => {
    const job = num(bigOf(d.args, "jobId")), pay = fmxS(bigOf(d.args, "agentPayout")), fee = fmxS(bigOf(d.args, "fee"));
    const rating = bigOf(d.args, "rating");
    const agent = c.job ? agentChip(c.job.agentId) : html`the agent`;
    if (a.input?.name === "claim") return html`${who(c.tx.from.hash)} claimed job ${job} after the review window: ${pay}, ${fee} fee.`;
    return html`${who(c.tx.from.hash)} released job ${job}: ${pay} to ${agent}, ${fee} fee${rating ? html`, rated <b class="num-mono">${rating.toString()}/5</b>` : ""}.`;
  },
  "ServiceEscrow.JobRefunded": (d, c) => html`Job ${num(bigOf(d.args, "jobId"))} refunded: ${fmxS(bigOf(d.args, "amount"))} back to ${c.job?.client ? who(c.job.client) : html`the client`}${boolOf(d.args, "byAgent") ? ", by the agent" : ""}.`,
  "ServiceEscrow.JobDisputed": (d, c) => html`${who(c.tx.from.hash)} disputed job ${num(bigOf(d.args, "jobId"))}. The escrow holds the funds until it is resolved.`,
  "ServiceEscrow.JobResolved": (d, c) => html`Job ${num(bigOf(d.args, "jobId"))} resolved: ${fmxS(bigOf(d.args, "clientAmount"))} to the client, ${fmxS(bigOf(d.args, "agentPayout"))} to ${c.job ? agentChip(c.job.agentId) : html`the agent`}.`,
  "ServiceEscrow.Withdrawn": (d) => html`${who(addrOf(d.args, "to"))} withdrew ${fmxS(bigOf(d.args, "amount"))} from ServiceEscrow.`,

  "AgentRegistry.AgentRegistered": (d) => {
    const bond = bigOf(d.args, "bond");
    return html`${who(addrOf(d.args, "owner"))} registered agent ${num(bigOf(d.args, "id"))} <b>“${strOf(d.args, "name") ?? ""}”</b> at ${fmxS(bigOf(d.args, "pricePerJob"))} per job${bond ? html`, bond ${fmxS(bond)}` : ", no bond"}.`;
  },
  "AgentRegistry.AgentUpdated": (d) => html`${agentChip(bigOf(d.args, "id"))} updated its listing: ${fmxS(bigOf(d.args, "pricePerJob"))} per job.`,
  "AgentRegistry.AgentStatusChanged": (d) => html`${agentChip(bigOf(d.args, "id"))} is now <b>${STATUS[Number(bigOf(d.args, "status") ?? 0)] ?? "unknown"}</b>.`,
  "AgentRegistry.OutcomeRecorded": (d) => { const r = bigOf(d.args, "rating"); return html`Outcome recorded for ${agentChip(bigOf(d.args, "id"))}: ${boolOf(d.args, "success") ? "completed" : "failed"}${r ? html`, rated <b class="num-mono">${r.toString()}/5</b>` : ""}.`; },
  "AgentRegistry.BondChanged": (d) => html`${agentChip(bigOf(d.args, "id"))}'s bond is now ${fmxS(bigOf(d.args, "bond"))}.`,
  "AgentRegistry.OwnershipTransferred": (d) => html`Agent ${num(bigOf(d.args, "id"))} moved from ${who(addrOf(d.args, "from"))} to ${who(addrOf(d.args, "to"))}.`,
  "AgentRegistry.AgentSlashed": (d) => html`${agentChip(bigOf(d.args, "id"))} was slashed ${fmxS(bigOf(d.args, "amount"))}: ${strOf(d.args, "reason") ?? ""}.`,

  "X402Vault.Deposited": (d) => html`${who(addrOf(d.args, "payer"))} deposited ${fmxS(bigOf(d.args, "amount"))} in the x402 vault.`,
  "X402Vault.Settled": (d) => html`${who(addrOf(d.args, "payee"))} was paid ${fmxS(bigOf(d.args, "amount"))} by ${who(addrOf(d.args, "payer"))} for a pay-per-request call (${fmxS(bigOf(d.args, "fee"))} fee).`,
  "X402Vault.Withdrawn": (d) => html`${who(addrOf(d.args, "to"))} withdrew ${fmxS(bigOf(d.args, "amount"))} from the x402 vault.`,
  "X402Vault.CreditsWithdrawn": (d) => html`${who(addrOf(d.args, "to"))} withdrew ${fmxS(bigOf(d.args, "amount"))} of earned credits from the x402 vault.`,
  "X402Vault.UnlockRequested": (d) => html`${who(addrOf(d.args, "payer"))} asked to unlock their vault balance.`,
  "X402Vault.Skipped": (d) => html`An x402 payment from ${who(addrOf(d.args, "payer"))} was skipped: ${strOf(d.args, "reason") ?? "no reason given"}.`,

  "StreamPay.StreamOpened": (d) => {
    const a = bigOf(d.args, "start"), b = bigOf(d.args, "stop");
    return html`${who(addrOf(d.args, "payer"))} opened stream ${num(bigOf(d.args, "id"))} to ${who(addrOf(d.args, "payee"))}: ${fmxS(bigOf(d.args, "deposit"))}${a !== null && b !== null && b > a ? html` over <b>${dur(Number(b - a))}</b>` : ""}.`;
  },
  "StreamPay.StreamClaimed": (d, c) => html`${who(c.tx.from.hash)} claimed ${fmxS(bigOf(d.args, "payeeAmount"))} from stream ${num(bigOf(d.args, "id"))}.`,
  "StreamPay.StreamCancelled": (d) => html`Stream ${num(bigOf(d.args, "id"))} cancelled by ${who(addrOf(d.args, "by"))}: ${fmxS(bigOf(d.args, "payeeAmount"))} to the payee, ${fmxS(bigOf(d.args, "refund"))} refunded.`,
  "StreamPay.StreamToppedUp": (d, c) => html`${who(c.tx.from.hash)} topped up stream ${num(bigOf(d.args, "id"))} with ${fmxS(bigOf(d.args, "amount"))}.`,
  "StreamPay.Withdrawn": (d) => html`${who(addrOf(d.args, "to"))} withdrew ${fmxS(bigOf(d.args, "amount"))} from StreamPay.`,
  "StreamPay.Subscribed": (d) => html`${who(addrOf(d.args, "payer"))} subscribed to plan ${num(bigOf(d.args, "planId"))} for <b class="num-mono">${int(bigOf(d.args, "periods"))}</b> periods.`,
  "StreamPay.SubClaimed": (d, c) => html`${who(c.tx.from.hash)} claimed ${fmxS(bigOf(d.args, "payeeAmount"))} from subscription ${num(bigOf(d.args, "subId"))}.`,
  "StreamPay.SubRenewed": (d, c) => html`${who(c.tx.from.hash)} renewed subscription ${num(bigOf(d.args, "subId"))} for <b class="num-mono">${int(bigOf(d.args, "periods"))}</b> periods.`,
  "StreamPay.SubCancelled": (d) => html`Subscription ${num(bigOf(d.args, "subId"))} cancelled: ${fmxS(bigOf(d.args, "refund"))} refunded.`,
  "StreamPay.PlanCreated": (d) => { const p = bigOf(d.args, "period"); return html`${who(addrOf(d.args, "payee"))} created plan ${num(bigOf(d.args, "planId"))}: ${fmxS(bigOf(d.args, "pricePerPeriod"))}${p ? html` every <b>${dur(Number(p))}</b>` : ""}.`; },

  "FerminuxAgents.Minted": (d, c) => {
    const id = bigOf(d.args, "tokenId");
    const tt = c.tts.find((t) => t.total?.token_id === id?.toString());
    const arch = tt?.total?.token_instance?.metadata?.attributes?.find((x) => x.trait_type === "Archetype")?.value;
    return html`${who(addrOf(d.args, "to"))} minted <a href="/token/0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd/instance/${id?.toString() ?? ""}"><b>Ferminux Agents #${id?.toString() ?? "?"}</b></a>${typeof arch === "string" ? html` (${arch})` : ""} for ${fmxS(bigOf(d.args, "paid"))}.`;
  },
  "FerminuxCitizens.TokenMinted": (d, c) => {
    const id = bigOf(d.args, "tokenId");
    const tier = ["Common", "Rare", "Epic", "Legendary"][Number(bigOf(d.args, "tier") ?? -1)];
    const tt = c.tts.find((t) => t.total?.token_id === id?.toString());
    const nm = tt?.total?.token_instance?.metadata?.name;
    const paid = bigOf(d.args, "paid");
    return html`${who(addrOf(d.args, "to"))} minted <a href="/token/${d.log.address.hash}/instance/${id?.toString() ?? ""}"><b>${typeof nm === "string" && nm ? nm : `Ferminux Citizens #${id?.toString() ?? "?"}`}</b></a>${tier ? html` (${tier})` : ""}${paid ? html` for ${fmxS(paid)}` : " as a reserve"}.`;
  },
  "AgentAccountFactory.AccountCreated": (d) => html`${who(addrOf(d.args, "owner"))} created agent wallet ${who(addrOf(d.args, "account"))}.`,
  "AgentAccount.Executed": (d) => { const v = bigOf(d.args, "value"); return html`Agent wallet ${who(d.log.address.hash)} called ${who(addrOf(d.args, "to"))}${v ? html` with ${fmxS(v)}` : ""}${boolOf(d.args, "ok") === false ? " (failed)" : ""}.`; },
  "AgentTokenFactory.Launched": (d) => html`${agentChip(bigOf(d.args, "agentId"))} launched agent token <b>${strOf(d.args, "symbol") ?? ""}</b>.`,
  "AgentTokenFactory.Bought": (d) => { const t = addrOf(d.args, "token"); return html`${who(addrOf(d.args, "buyer"))} bought ${tokS(bigOf(d.args, "amountOut"), 18, agentTokenSymbol(t) ?? "tokens")} for ${fmxS(bigOf(d.args, "fmxIn"))}.`; },
  "AgentTokenFactory.Sold": (d) => { const t = addrOf(d.args, "token"); return html`${who(addrOf(d.args, "seller"))} sold ${tokS(bigOf(d.args, "amountIn"), 18, agentTokenSymbol(t) ?? "tokens")} for ${fmxS(bigOf(d.args, "fmxOut"))}.`; },
  "AgentTokenFactory.Claimed": (d) => { const t = addrOf(d.args, "token"); return html`${who(addrOf(d.args, "holder"))} claimed ${fmxS(bigOf(d.args, "amount"))} of ${agentTokenSymbol(t) ?? "agent token"} distributions.`; },
  "AgentTokenFactory.Distributed": (d) => { const t = addrOf(d.args, "token"); return html`${who(addrOf(d.args, "from"))} distributed ${fmxS(bigOf(d.args, "amount"))} to ${agentTokenSymbol(t) ?? "agent token"} holders.`; },
  "AgentTokenFactory.Withdrawn": (d) => html`${who(addrOf(d.args, "to"))} withdrew ${fmxS(bigOf(d.args, "amount"))} from AgentTokenFactory.`,

  "ArbiterPool.CaseOpened": (d) => html`Dispute case ${num(bigOf(d.args, "caseId"))} opened for job ${num(bigOf(d.args, "jobId"))}.`,
  "ArbiterPool.Voted": (d) => html`${who(addrOf(d.args, "arbiter"))} voted on case ${num(bigOf(d.args, "caseId"))}.`,
  "ArbiterPool.CaseClosed": (d) => { const b = bigOf(d.args, "clientBps"); return html`Case ${num(bigOf(d.args, "caseId"))} closed: <b class="num-mono">${b === null ? "—" : (Number(b) / 100).toString()}%</b> to the client.`; },
  "ArbiterPool.ArbiterJoined": (d) => html`${who(addrOf(d.args, "arbiter"))} joined the arbiter pool with ${fmxS(bigOf(d.args, "stake"))}.`,

  "ReputationRegistry8004.NewFeedback": (d) => html`${who(addrOf(d.args, "clientAddress"))} left feedback for ${agentChip(bigOf(d.args, "agentId"))}: <b class="num-mono">${scaled(bigOf(d.args, "value"), bigOf(d.args, "valueDecimals"))}</b>.`,
  "ReputationRegistry8004.EscrowSynced": (d) => html`Job ${num(bigOf(d.args, "jobId"))}'s rating was recorded as feedback for ${agentChip(bigOf(d.args, "agentId"))}: <b class="num-mono">${bigOf(d.args, "value")?.toString() ?? "—"}</b>.`,
  "ValidationRegistry8004.ValidationResponse": (d) => html`${who(addrOf(d.args, "validatorAddress"))} answered a validation request for ${agentChip(bigOf(d.args, "agentId"))}.`,
  "ValidationRegistry8004.ValidationRequest": (d, c) => html`${who(c.tx.from.hash)} asked ${who(addrOf(d.args, "validatorAddress"))} to validate ${agentChip(bigOf(d.args, "agentId"))}.`,
  "IdentityRegistry8004.Registered": (d) => html`${who(addrOf(d.args, "owner"))} registered agent identity ${num(bigOf(d.args, "agentId"))}.`,

  "AgentRegistry.EscrowSet": (d) => html`AgentRegistry now settles jobs through ${who(addrOf(d.args, "escrow"))}.`,
  "AgentAccount.SessionAdded": (d) => { const x = bigOf(d.args, "expiry"); return html`Agent wallet ${who(d.log.address.hash)} added session key ${who(addrOf(d.args, "key"))}: up to ${fmxS(bigOf(d.args, "capPerDay"))} a day${x ? html` until <span class="num-mono">${utc(Number(x))}</span>` : ""}.`; },
  "AgentAccount.SessionRevoked": (d) => html`Agent wallet ${who(d.log.address.hash)} revoked session key ${who(addrOf(d.args, "key"))}.`,
  "AgentAccount.Received": (d) => html`Agent wallet ${who(d.log.address.hash)} received ${fmxS(bigOf(d.args, "amount"))} from ${who(addrOf(d.args, "from"))}.`,
  "AgentAccount.OwnershipTransferred": (d) => html`Agent wallet ${who(d.log.address.hash)} now belongs to ${who(addrOf(d.args, "current"))}.`,
  "Multisig.Submitted": (d) => { const v = bigOf(d.args, "value"); return html`${who(addrOf(d.args, "proposer"))} proposed multisig transaction ${num(bigOf(d.args, "txId"))} to ${who(addrOf(d.args, "to"))}${v ? html` with ${fmxS(v)}` : ""}.`; },
  "Multisig.Confirmed": (d) => html`${who(addrOf(d.args, "owner"))} confirmed multisig transaction ${num(bigOf(d.args, "txId"))}.`,
  "Multisig.Revoked": (d) => html`${who(addrOf(d.args, "owner"))} withdrew their confirmation of multisig transaction ${num(bigOf(d.args, "txId"))}.`,
  "Multisig.Executed": (d) => html`${who(addrOf(d.args, "executor"))} executed multisig transaction ${num(bigOf(d.args, "txId"))}.`,
  "Multisig.Deposit": (d) => html`${who(addrOf(d.args, "sender"))} sent ${fmxS(bigOf(d.args, "value"))} to the governance multisig.`,
  "Faucet.Dripped": (d) => html`The faucet sent ${fmxS(bigOf(d.args, "amount"))} to ${who(addrOf(d.args, "to"))}.`,
  "FMXVesting.Released": (d) => html`FMXVesting released ${fmxS(bigOf(d.args, "amount"))}.`,
  "FMXVesting.Funded": (d) => html`${who(addrOf(d.args, "from"))} funded FMXVesting with ${fmxS(bigOf(d.args, "amount"))}.`,
  "TokenFactory.TokenLaunched": (d) => html`${who(addrOf(d.args, "creator"))} launched token <b>${strOf(d.args, "symbol") ?? ""}</b> (${strOf(d.args, "name") ?? ""}) at ${who(addrOf(d.args, "token"))}.`,
  "DexFactory.PairCreated": (d) => html`A DEX pair ${who(addrOf(d.args, "pair"))} was created for ${who(addrOf(d.args, "token0"))} and ${who(addrOf(d.args, "token1"))}.`,
  "LiquidityLocker.Locked": (d) => { const u = bigOf(d.args, "unlockAt"); return html`${who(addrOf(d.args, "owner"))} locked liquidity in lock ${num(bigOf(d.args, "id"))}${u ? html` until <span class="num-mono">${utc(Number(u))}</span>` : ""}.`; },
  "LiquidityLocker.Withdrawn": (d) => html`${who(addrOf(d.args, "to"))} withdrew the liquidity in lock ${num(bigOf(d.args, "id"))}.`,
  // any Ferminux contract (matched after the contract-specific rules)
  "*.GovernanceChanged": (d) => html`${who(d.log.address.hash)}'s governance moved from ${who(addrOf(d.args, "previous"))} to ${who(addrOf(d.args, "current"))}.`,
  "*.FeeChanged": (d) => { const b = bigOf(d.args, "feeBps"); return b === null ? null : html`${who(d.log.address.hash)}'s fee is now <b class="num-mono">${(Number(b) / 100).toString()}%</b>.`; },
  "*.FeeRecipientChanged": (d) => html`${who(d.log.address.hash)} now pays its fees to ${who(addrOf(d.args, "feeRecipient"))}.`,
  "*.OwnershipTransferred": (d) => { const to = addrOf(d.args, "current") ?? addrOf(d.args, "to") ?? addrOf(d.args, "newOwner"); return to ? html`${who(d.log.address.hash)} now belongs to ${who(to)}.` : null; },
  "WFMX.Deposit": (d) => html`${who(addrOf(d.args, "dst"))} wrapped ${fmxS(bigOf(d.args, "wad"))}.`,
  "WFMX.Withdrawal": (d) => html`${who(addrOf(d.args, "src"))} unwrapped ${fmxS(bigOf(d.args, "wad"))}.`,
};

const ruleFor = (d: DLog): Rule | undefined => (d.generic || !d.name ? undefined : R[`${d.abi}.${d.name}`] ?? R[`*.${d.name}`]);
const scaled = (v: bigint | null, dec: bigint | null) => (v === null ? "—" : units(v, Number(dec ?? 0n), Number(dec ?? 0n)));
const methodWord = (a: Analysis, tx: Tx): Html => (a.input ? html`<code>${a.input.name}</code>` : tx.method ? html`<code class="sel">${tx.method}</code>` : html`a method`);

function sentence(c: Ctx, a: Analysis): Out {
  const tx = c.tx;
  const failed = tx.status === "error";
  // contract creation
  if (tx.created_contract) return { html: html`${who(tx.from.hash)} ${failed ? "tried to create" : "created"} contract ${who(tx.created_contract.hash)}.`, decoded: false, from: -1 };
  // plain FMX transfer (a Wizrd load-test transfer too: its input is the FXLT marker from a load-test wallet, not a
  // call; src/loadtest.ts)
  const lt = isLoadTestTx(tx);
  if (!tx.raw_input || tx.raw_input === "0x" || lt) return { html: html`${who(tx.from.hash)} ${failed ? "tried to send" : "sent"} ${fmxS(BigInt(tx.value || "0"))} to ${who(tx.to?.hash)}${lt ? " in Wizrd's load test" : ""}.`, decoded: false, from: -1 };
  if (failed) return { html: html`${who(tx.from.hash)} tried to call ${methodWord(a, tx)} on ${who(tx.to?.hash)}${BigInt(tx.value || "0") > 0n ? html` with ${fmxS(BigInt(tx.value))}` : ""}.`, decoded: !!a.input, from: -1 };

  // x402 batch: several Settled events read as one line
  const settled = a.events.filter((e) => e.abi === "X402Vault" && e.name === "Settled");
  if (settled.length > 1) {
    const sum = settled.reduce((s, e) => s + (bigOf(e.args, "amount") ?? 0n), 0n);
    return { html: html`<b class="num-mono">${settled.length}</b> x402 payments settled, ${fmxS(sum)} in total.`, decoded: true, from: a.events.indexOf(settled[0]), consumed: settled.length - 1 };
  }
  // DEX swap: amounts from the token-transfer list (the pair event carries no symbols)
  const swap = a.events.find((e) => e.name === "Swap" && (e.abi === "DexPair" || e.generic));
  if (swap) { const s = swapLine(c, a); if (s) return { html: s, decoded: true, from: a.events.indexOf(swap) }; }

  // the first event with a catalogue entry
  for (let i = 0; i < a.events.length; i++) {
    const e = a.events[i];
    if (!e.name || e.generic) continue;
    const rule = ruleFor(e);
    if (!rule) continue;
    const h = rule(e, c, a);
    if (h) return { html: h, decoded: true, from: i };
  }
  // no known event: the call itself
  const v = BigInt(tx.value || "0");
  return { html: html`${who(tx.from.hash)} called ${methodWord(a, tx)} on ${who(tx.to?.hash)}${v > 0n ? html` with ${fmxS(v)}` : ""}.`, decoded: !!a.input, from: -1 };
}

function swapLine(c: Ctx, a: Analysis): Html | null {
  const me = lc(c.tx.from.hash);
  const tts = c.tts.filter((t) => t.total?.value);
  const inT = tts.find((t) => lc(t.from.hash) === me);
  const outT = [...tts].reverse().find((t) => lc(t.to.hash) === me);
  const v = BigInt(c.tx.value || "0");
  const inH = inT ? tokS(BigInt(inT.total.value!), Number(inT.token.decimals ?? 18), inT.token.symbol ?? "tokens") : v > 0n ? fmxS(v) : null;
  const unwrap = a.events.find((e) => e.name === "Withdrawal" && e.abi === "WFMX");
  const outH = outT ? tokS(BigInt(outT.total.value!), Number(outT.token.decimals ?? 18), outT.token.symbol ?? "tokens") : unwrap ? fmxS(bigOf(unwrap.args, "wad")) : null;
  if (!inH || !outH) return null;
  return html`${who(c.tx.from.hash)} swapped ${inH} for ${outH}.`;
}

/** The short sentence for one event in the Events tab (null when the catalogue has none). */
export function eventLine(d: DLog, c: Ctx, a: Analysis): Html | null {
  if (!d.name || d.generic) return null;
  const rule = ruleFor(d);
  try { return rule ? rule(d, c, a) : null; } catch { return null; }
}

/* ---------------------------------------------------------------- decoded arguments table */

/** uint names that carry FMX (wei) in these contracts; token contracts never do. */
const FMX_NAMES = /^(amount|pricePerJob|bond|agentPayout|fee|clientAmount|deposit|ratePerSec|payeeAmount|refund|paid|fmxIn|fmxOut|minFmx|pricePerPeriod|stake|minStake|minBond|newMinBond|value|wad|amountFMX|amountFMXMin|price|p|evidenceAmountWei|minPaidWei)$/;
const TOKEN_ABIS = new Set<AbiName>(["AgentToken", "AZNT", "USDF", "FerminuxToken", "DexPair", "Generic", "Bridge", "LiquidityLocker"]);
const TIME_NAMES = /^(expiry|deadline|start|stop|at|paidThrough|registeredAt|unlockAt|releaseAt)$/;

function intCell(v: bigint, name: string, abi: AbiName | null, fnName: string | null): Html {
  const fmx = abi && !TOKEN_ABIS.has(abi) && FMX_NAMES.test(name) && !(abi === "AgentTokenFactory" && /^(amountIn|amountOut)$/.test(name)) && !(fnName === "setFee" || name === "feeBps")
    && !(abi === "FerminuxAgents" && name === "p" && fnName !== "setPrice");
  const t = TIME_NAMES.test(name) && v > 1_500_000_000n && v < 4_000_000_000n;
  const en = abi === "AgentRegistry" && (name === "status" || name === "s") ? STATUS[Number(v)] : null;
  return html`<span class="num-mono">${int(v)}</span>${fmx && v > 0n ? html` <span class="faint">= ${units(v, 18, 18)} FMX</span>` : ""}${t ? html` <span class="faint">= ${utc(Number(v))}</span>` : ""}${en ? html` <span class="faint">(${en})</span>` : ""}`;
}
function strCell(s: string): Html {
  const m = s.match(/^fmx:\/\/payload\/(0x[0-9a-fA-F]{64})$/);
  if (m) return html`<a class="link-inline mono" href="${agentLinks(0).payload(m[1])}" target="_blank" rel="noopener" data-external>${s}</a>`;
  if (/^https?:\/\//i.test(s) && safeHref(s) !== "#") return html`<a class="link-inline mono" href="${s}" target="_blank" rel="noopener nofollow" data-external>${s}</a>`;
  return html`<span class="mono str">“${s}”</span>`;
}
export function valueCell(v: V, name = "", abi: AbiName | null = null, fnName: string | null = null): Html {
  switch (v.k) {
    case "int": return intCell(v.v, name, abi, fnName);
    case "addr": return lc(v.v) === ZERO ? html`<span class="mono faint">${v.v}</span> <span class="tag">none</span>` : addrChip(cs(v.v), { full: true });
    case "bool": return html`<span class="mono">${String(v.v)}</span>`;
    case "bytes": return html`<span class="mono tx-wrap">${v.v}</span>`;
    case "str": return strCell(v.v);
    case "hashed": return html`<span class="mono tx-wrap">${v.v}</span> <span class="faint">(hashed)</span>`;
    case "arr": return v.v.length ? html`<ol class="arg-arr">${v.v.map((x) => html`<li>${valueCell(x, name, abi, fnName)}</li>`)}</ol>` : html`<span class="faint">empty</span>`;
    case "tuple": return argsTable(v.v, abi, fnName, true);
  }
}
/** Name · type · value rows. */
export function argsTable(args: Arg[], abi: AbiName | null, fnName: string | null, nested = false): Html {
  if (!args.length) return html`<p class="faint small">No arguments.</p>`;
  return html`<table class="args${nested ? " nested" : ""}"><thead class="vh"><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Value</th></tr></thead><tbody>${args.map((x) =>
    html`<tr><th scope="row" class="a-n">${x.n || "—"}${x.i ? html` <span class="faint">indexed</span>` : ""}</th><td class="a-t">${x.t}</td><td class="a-v">${valueCell(x.v, x.n, abi, fnName)}</td></tr>`)}</tbody></table>`;
}

/** The decoded input block for the overview (function signature, args, provenance). */
export function inputBlock(d: DCall): Html {
  return html`<div class="dec"><div class="dec-h"><code class="fn">${d.name}</code>${d.generic ? kindTag("Standard") : ""}${prov("abi")}</div><p class="dec-sig mono faint">${d.sig}</p>${argsTable(d.args, d.abi, d.name)}</div>`;
}

/* ---------------------------------------------------------------- the job rail (§4.13, §6.5) */

export interface Step { name: string; state: "done" | "current" | "todo" | "warn"; ts: number | null; tx: string | null }
export function jobSteps(job: Job, closedTs: number | null): Step[] {
  const st = job.status;
  const closedWords = ["Completed", "Released", "Claimed", "Refunded", "Resolved"];
  const closed = closedWords.includes(st);
  const delivered = !!(job.tx?.delivered || job.deliveredAt);
  const s1: Step = { name: "Requested", state: "done", ts: job.createdAt || null, tx: job.tx?.requested ?? null };
  const s2: Step = { name: "Delivered", state: delivered ? "done" : closed ? "todo" : "current", ts: job.deliveredAt ?? null, tx: job.tx?.delivered ?? null };
  const s3: Step = st === "Disputed"
    ? { name: "Disputed", state: "warn", ts: closedTs, tx: job.tx?.closed ?? null }
    : { name: closed ? st : "Closed", state: closed ? "done" : delivered ? "current" : "todo", ts: closed ? closedTs : null, tx: job.tx?.closed ?? null };
  return [s1, s2, s3];
}

export function jobRail(job: Job, here: string, closedTs: number | null): Html {
  const steps = jobSteps(job, closedTs);
  const agent = agentById(job.agentId);
  const links = agentLinks(job.agentId);
  return html`<section class="job" aria-labelledby="job-h">
  <h3 id="job-h" class="job-h"><span>Job <b class="num-mono">#${job.id}</b></span><span>${agentChip(job.agentId)}</span><span>${fmxS(BigInt(job.amount || "0"))}</span><span class="faint">client</span> ${who(job.client)}</h3>
  <ol class="rail">${steps.map((s) => html`<li class="step ${s.state}"${s.tx && lc(s.tx) === lc(here) ? html` aria-current="step"` : ""}>
    <span class="dot" aria-hidden="true"></span>
    <span class="nm">${s.name}${s.state === "current" ? html` <span class="faint">(next)</span>` : ""}</span>
    <span class="tm">${s.ts ? html`<time datetime="${new Date(s.ts * 1000).toISOString()}" title="${utc(s.ts)}">${utc(s.ts)}</time>` : s.state === "todo" || s.state === "current" ? html`<span class="faint">not yet</span>` : dash("No time reported")}</span>
    <span class="tx">${s.tx ? lc(s.tx) === lc(here) ? html`<span class="this">this transaction</span>` : html`<a class="mono" href="/tx/${s.tx}">${short(s.tx, 4)}</a>` : ""}</span>
  </li>`)}</ol>
  <p class="job-links">${payloadLink("Input", job.inputURI)}${payloadLink("Output", job.outputURI)}<a class="link-arrow" href="${links.job(job.id)}" target="_blank" rel="noopener" data-external>Raw job record (JSON) ${icon("i-ext", "", 14)}</a>${agent ? html`<a class="link-arrow" href="${links.record}" target="_blank" rel="noopener" data-external>${agent.name}'s record ${icon("i-ext", "", 14)}</a>` : ""}</p>
</section>`;
}
function payloadLink(label: string, uri: string | null | undefined): Val {
  const m = uri?.match(/^fmx:\/\/payload\/(0x[0-9a-fA-F]{64})$/);
  return m ? html`<a class="link-arrow" href="${agentLinks(0).payload(m[1])}" target="_blank" rel="noopener" data-external>${label} payload ${icon("i-ext", "", 14)}</a>` : "";
}

/* ---------------------------------------------------------------- agents named by the tx (side cards) */

export function agentsInTx(tx: Tx, a: Analysis | null): number[] {
  const ids = new Set<number>(a?.agentIds ?? []);
  for (const addr of [tx.from?.hash, tx.to?.hash]) if (addr) agentFor(addr).forEach((x) => ids.add(x.id));
  return [...ids].filter((id) => agentById(id));
}
