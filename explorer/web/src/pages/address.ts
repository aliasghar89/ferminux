/* Address `/address/:addr` (surfaces/explorer.md §5.6, §5.7, §6.3).
   Requests, in parallel from the first frame: BS /addresses/:a, /counters, /tabs-counters; GW agents, agent
   wallets and agent tokens (cached lists); RPC clique_getSigners; RPC eth_getCode when the book doesn't know
   the address and the index says "not a contract" (API.md #5: that can mean "not yet known").
   Variants, from the data (one address can be several): account · signer · agent owner · agent wallet ·
   contract · token contract · unused. The head, stats and panels paint as their data lands; the tabs paint
   once the index's counters and the variant are known (the gateway gets at most 2.5 s to add "Agent jobs").
   Tabs (?tab= values are the index's): txs · token_transfers · tokens · coin_balance_history ·
   blocks_validated · logs · contract · jobs. `internal_txns` lands on Transactions with the honest note. */
import "./address/address.css";
import { html, mount, dash, type Html } from "../ui/html";
import { copyBtn } from "../ui/copy";
import { addrChip, txChip, blockLink, halfWidth } from "../ui/hash";
import { kindTag, prov } from "../ui/marks";
import { statSkeleton, sk } from "../ui/skeleton";
import { liveText } from "../motion";
import { txCount } from "../counts";
import { nonCanonical, canonicalCount, excludedText } from "../canon";
import { tableSkeleton } from "../ui/table";
import { tabsHtml, bindTabs, type TabDef } from "../ui/tabs";
import { note, showError, empty } from "../ui/state";
import { icon } from "../ui/icons";
import { short, int, amountExact, units } from "../format";
import { isAddr, lc, isAbort, sleep } from "../util";
import { api, ApiError, countersPending } from "../api";
import { rpc, RPC_DOWN, FRC721_PROBE, FRC165_INVALID } from "../rpc";
import { supports721 } from "./tokens/classify";
import { gw, GW_DOWN, type Agent, type AgentWallet, type AgentToken } from "../gateway";
import { authorisedSigners, signerNo } from "../signer";
import { knownContract, POSA_BLOCK } from "../known";
import { label as bookLabel } from "../book";
import { shell, crumbs as crumbsHtml, slot } from "./_shell";
import { notFound } from "./notFound";
import { resolveTab, setMeta, setSection, type Params } from "../router";
import type { Address, AddressCounters, Capped, TabsCounters } from "../types";
import type { Ctx } from "./address/common";
import { txsTab, transfersTab } from "./address/txs";
import { tokensTab } from "./address/holdings";
import { historyTab } from "./address/history";
import { blocksTab } from "./address/blocks";
import { eventsTab } from "./address/events";
import { jobsTab, loadJobs, type JobRow } from "./address/jobs";
import { agentCards } from "./address/agent";
import { signerPanel } from "./address/signerPanel";
import { bookData, templateData, cloneTarget, type AbiItem } from "./address/abi";
import { ltAddressLabel } from "../loadtest";

const INTERNAL_NOTE = "Internal transactions are not indexed on this network: the public node keeps no traces. Value that contracts pay out appears as events on each transaction (for example StreamPay Withdrawn).";
const STAT_LABELS = ["Balance", "Transactions", "Token transfers", "Tokens"];

/** The variant flags (§5.6 table). */
interface Kind {
  contract: boolean; token: boolean; signer: boolean; wallet: AgentWallet | null; owned: Agent[]; walletAgents: Agent[]; unused: boolean;
}

const ok = <T,>(p: Promise<T>): Promise<T | null> => p.catch((e) => { if (isAbort(e)) throw e; return null; });

export function render(p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const a0 = p.addr;
  if (!isAddr(a0)) {
    notFound(root, { h1: "That isn't an address", body: `An address is 0x followed by 40 hexadecimal characters.${/^0x[0-9a-f]*$/i.test(a0) ? ` This one has ${a0.length - 2}.` : ""}`, query: a0 });
    return;
  }
  const choice = resolveTab("address", query);
  const book = knownContract(a0);
  const l0 = bookLabel(a0);
  if (book) setSection("contracts");
  setMeta({ title: l0 ? `${l0.name} (${short(a0, 4)})` : `Address ${short(a0, 4)}`, description: `Address ${a0} on Ferminux Network (chain 3961): balance, transactions, tokens and agent work.` });
  shell(root, {
    crumbs: book ? [{ href: "/verified-contracts", label: "Contracts" }, { label: short(a0, 4) }] : [{ href: "/accounts", label: "Accounts" }, { label: short(a0, 4) }],
    h1: l0 ? h1Label(l0.name, l0.kind === "agent" || l0.kind === "agent-wallet" ? l0.id : undefined) : "Address",
    ident: html`<span class="ad-kinds" data-kinds>${book ? kindTag(book.kind === "token" ? "Token" : "Contract") : html`<span class="sk" style="width:64px"></span>`}</span><span class="hc-full" style="${halfWidth(a0)}">${a0}</span>${copyBtn(a0, `Copy address ${short(a0, 4)}`)}`,
    body: html`${choice.note ? note(INTERNAL_NOTE) : ""}
      <div data-slot="banner"></div>
      <div data-slot="lt"></div>
      <div data-slot="agent"></div>
      <div data-slot="stats">${statSkeleton(STAT_LABELS)}</div>
      <p class="ad-sub" data-slot="sub"></p>
      <div data-slot="signer"></div>
      <div data-slot="tabs"><div class="xtabs skel" aria-hidden="true">${sk("320px")}</div>${tableSkeleton({ caption: "Transactions", captionHidden: true, cols: [{ label: "Tx", cell: () => "" }, { label: "Kind / method", cell: () => "" }, { label: "From → To", cell: () => "", line: 2 }, { label: "Value (FMX)", cell: () => "", align: "r", line: 3 }] }, 8)}</div>`,
  });
  root.querySelector(".page")?.classList.add("adx");
  void ltAddressLabel(root.querySelector<HTMLElement>('[data-slot="lt"]'), a0, signal); // Wizrd load-test wallets
  void load(a0, choice, query, signal, root);
}

const h1Label = (name: string, id?: number): Html => html`${name}${id ? html` <span class="ad-h1-id">#${id}</span>` : ""}`;

async function load(a0: string, choice: ReturnType<typeof resolveTab>, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const book = knownContract(a0);
  // everything that doesn't depend on another answer starts now (the RPC calls share one batch)
  const A = api.address(a0, { signal });
  const C = ok(api.addressCounters(a0, { signal }));
  const T = ok(api.addressTabsCounters(a0, { signal }));
  const GA = ok(gw.agents(signal)), GAcc = ok(gw.accounts(signal)), GT = ok(gw.tokens(signal));
  const SET = ok(authorisedSigners(signal));
  // the chain's balance: the index updates a balance only when it indexes a change (a signer earns every block)
  const BAL = ok(rpc.balance(a0, signal));
  let codeP: Promise<string | null> | null = null;
  const code = () => (codeP ??= rpc.code(a0, signal).catch((e) => { if (isAbort(e)) throw e; return null; }));

  let addr: Address;
  try { addr = await A; } catch (e) {
    if (signal.aborted || isAbort(e)) return;
    if (e instanceof ApiError && e.notFound) {
      notFound(root, { h1: "Address not found", body: "The explorer's index doesn't know this address.", query: a0 });
      return;
    }
    const s = slot(root, "stats");
    showError(s, e, () => { root.replaceChildren(); render({ addr: a0 }, query, signal, root); });
    slot(root, "tabs")?.replaceChildren();
    return;
  }
  if (signal.aborted) return;
  const a = addr.hash || a0;

  // is it a contract? the book and the index first; the code only when both say no (API.md #5)
  const needCode = !book && !addr.is_contract;
  const codeHex = needCode ? await code() : null;
  if (signal.aborted) return;
  const isContract = !!book || addr.is_contract || (!!codeHex && codeHex !== "0x");

  const [set, counters, tabsC, chainBal] = await Promise.all([SET, C, T, BAL]);
  if (signal.aborted) return;
  const ctx: Ctx = { a, signal, query, initialTab: choice.tab ?? "", addr, isContract, chainBal, select: () => {} };
  // a signer: in the current set, a numbered signer, or it confirmed blocks from 160,000 on (a proof-of-work
  // producer such as the treasury's early blocks is not a signer)
  let signer = !isContract && (!!set?.includes(lc(a)) || signerNo(a) !== null);
  if (!signer && !isContract && addr.has_validated_blocks) {
    const last = await ok(api.addressBlocksConfirmed(a, null, { signal }));
    if (signal.aborted) return;
    signer = !!last?.items[0] && last.items[0].height >= POSA_BLOCK;
  }
  const kind: Kind = {
    contract: isContract,
    token: !!addr.token || book?.kind === "token",
    signer,
    wallet: null, owned: [], walletAgents: [],
    unused: !isContract && addr.coin_balance === null && !addr.has_logs && !addr.has_tokens && !addr.has_token_transfers && !addr.has_validated_blocks,
  };

  // gateway roles (bounded wait for the tabs; cards paint whenever they land)
  const roles = Promise.all([GA, GAcc, GT]).then(([agents, wallets, tokens]) => {
    if (!agents && !wallets) return null;
    const wallet = wallets?.find((w) => lc(w.account) === lc(a)) ?? null;
    return {
      agents: agents ?? [], wallets: wallets ?? [], tokens: tokens ?? [], wallet,
      owned: (agents ?? []).filter((x) => lc(x.owner) === lc(a)),
      walletAgents: wallet ? (agents ?? []).filter((x) => lc(x.owner) === lc(wallet.owner)) : [],
    };
  });
  // jobs: as a client (any account or agent wallet) and as an agent's owner; book contracts have none
  const jobsP: Promise<JobRow[] | null> = roles.then((r) => (r && !book && (!kind.contract || r.wallet) ? loadJobs(a, r.owned.length ? a : r.wallet?.owner ?? null, signal) : null)).catch((e) => { if (isAbort(e)) throw e; return null; });
  const agentTokenP = roles.then((r) => !!r?.tokens.some((t) => lc(t.token) === lc(a))).catch(() => false);


  paintHead(root, a, addr, kind, counters, tabsC, chainBal, signal);
  if (kind.unused) { paintUnused(root, a, signal); return; }
  if (kind.signer) signerPanel(slot(root, "signer")!, a, signal);

  // agent cards and the gateway's words in the head
  roles.then((r) => {
    if (signal.aborted) return;
    const host = slot(root, "agent")!;
    if (!r) { if (!kind.contract && !kind.signer) mount(host, html`<p class="ad-gw-down">${GW_DOWN}</p>`); return; }
    kind.wallet = r.wallet; kind.owned = r.owned; kind.walletAgents = r.walletAgents;
    const list = r.owned.length ? r.owned : r.walletAgents;
    if (list.length) {
      mount(host, agentCards(list, { wallets: r.wallets, tokens: r.tokens as AgentToken[], self: a }, true));
      host.querySelector("[data-jobs]")?.addEventListener("click", () => { ctx.select("jobs"); slot(root, "tabs")?.scrollIntoView({ block: "start" }); });
    }
    if (r.wallet) {
      const ag = r.walletAgents[0];
      mount(slot(root, "banner"), html`<p class="ad-banner">${icon("i-bot", "", 14)} <span>Agent wallet of</span> ${ag ? addrChip(ag.owner, { label: { name: ag.name, kind: "agent", id: ag.id } }) : addrChip(r.wallet.owner)} <span class="faint">· created in</span> ${txChip(r.wallet.txHash)} <span class="faint">through AgentAccountFactory</span></p>`);
    }
    paintKinds(root, a, addr, kind);
    const l = bookLabel(a, addr.name);
    if (l) { const h = root.querySelector("h1"); if (h) mount(h, h1Label(l.name, l.kind === "agent" || l.kind === "agent-wallet" ? l.id : undefined)); }
    setMeta({ title: l ? `${l.name} (${short(a, 4)})` : `Address ${short(a, 4)}`, description: descr(a, l?.name ?? null, kind) });
  }).catch(() => { /* aborted */ });

  // the tabs: wait for the jobs (≤ 2.5 s) so "Agent jobs" is in the list from the start
  const jobs = book ? null : await Promise.race([jobsP, sleep(2500, signal).then(() => undefined)]).catch(() => undefined);
  if (signal.aborted) return;
  paintTabs(root, ctx, kind, addr, counters, tabsC, choice, jobs ?? null, jobsP, code, agentTokenP);
}

/* ---------------------------------------------------------------- head */

function descr(a: string, name: string | null, k: Kind) {
  const what = k.token ? "token contract" : k.contract ? "contract" : k.signer ? "signer" : k.wallet ? "agent wallet" : "address";
  return `${name ? `${name}, ` : ""}${what} ${a} on Ferminux Network (chain 3961): balance, transactions, tokens${k.contract ? ", events and source" : " and agent work"}.`;
}

function paintKinds(root: HTMLElement, a: string, addr: Address, k: Kind) {
  const tags: string[] = [];
  if (k.token) tags.push("Token");
  if (k.contract) tags.push("Contract");
  if (k.wallet) tags.push("Agent wallet");
  if (k.signer) tags.push("Signer");
  if (!tags.length) tags.push("Account");
  mount(root.querySelector("[data-kinds]"), html`${tags.map((t) => kindTag(t))}${addr.is_verified ? html` ${prov("verified")}` : ""}`);
}

/** A tab's count: the list's own (exact up to 50, "50+" above); above 50 the index's counter only when it
 *  agrees that the list is longer than 50 (the counter drifts and reads "0" before the index has counted). */
const tabCount = (tabs: Capped | undefined, total: string | undefined): number | Capped | null => {
  if (!tabs) return total !== undefined && Number(total) > 0 ? Number(total) : null;
  if (tabs.capped && total !== undefined && Number(total) > 50) return Number(total);
  return tabs;
};
const n = (c: number | Capped | null) => (c === null ? null : typeof c === "number" ? c : c.n);

function balanceHtml(wei: string | bigint | null): Html {
  if (wei === null) return html`0<span class="unit">FMX</span>`;
  const s = amountExact(wei);
  if (s === "—") return dash();
  const [i, f] = s.split(".");
  return html`${i}${f ? html`<span class="frac">.${f}</span>` : ""}<span class="unit">FMX</span>`;
}

/** A token contract the index hasn't catalogued as a token (it lists one from its Transfer events): the book calls
 *  it a token, or its code passes the FRC-165 test for FRC-721 (tokens/classify.ts). The banner links to the token
 *  page, which reads it from the chain. Two eth_calls in one batch; a contract without supportsInterface just
 *  reverts (no banner). The copy promises nothing: a collection may never emit a Transfer (a view over a registry). */
function unindexedTokenBanner(root: HTMLElement, a: string, signal: AbortSignal) {
  const book = knownContract(a);
  const read = (data: string) => rpc.ethCall(a, data, signal).catch((e: unknown) => { if (isAbort(e)) throw e; return null; });
  Promise.all([read(FRC721_PROBE), read(FRC165_INVALID)]).then(([probe, invalid]) => {
    const is721 = supports721(probe, invalid);
    if (signal.aborted || (!is721 && book?.kind !== "token")) return;
    const what = book ? `This is the ${book.name}${is721 ? " FRC-721" : " token"} contract.` : "This is an FRC-721 contract.";
    mount(slot(root, "banner"), html`<p class="ad-banner">${icon("i-coins", "", 14)}<span class="t">${what} The explorer's index has no Transfer from it yet, so it isn't listed as a token.</span><a class="link-arrow" href="/token/${a}">Token page ${icon("i-arrow")}</a></p>`);
  }).catch(() => { /* aborted */ });
}

function paintHead(root: HTMLElement, a: string, addr: Address, k: Kind, c: AddressCounters | null, t: TabsCounters | null, chainBal: bigint | null, signal: AbortSignal) {
  paintKinds(root, a, addr, k);
  if (k.contract) {
    setSection("contracts");
    const cr = root.querySelector(".crumbs");
    if (cr) cr.outerHTML = crumbsHtml([{ href: "/verified-contracts", label: "Contracts" }, { label: short(a, 4) }]).s;
  }
  // token banner
  if (addr.token) {
    const tk = addr.token;
    mount(slot(root, "banner"), html`<p class="ad-banner">${icon("i-coins", "", 14)} This is the ${tk.name ?? "token"}${tk.symbol ? ` (${tk.symbol})` : ""} ${tk.type} contract. <a class="link-arrow" href="/token/${addr.hash}">Token page ${icon("i-arrow")}</a></p>`);
  } else if (k.contract) unindexedTokenBanner(root, a, signal);
  if (k.unused) return;
  /* Stat cells. Counts come from the index's lists, which are right, not from its /counters, which drift:
     - Transactions: the list count (exact up to 50 in /tabs-counters, else counted page by page: counts.ts);
     - Token transfers: the list count up to 50, else the counter;
     - Blocks confirmed: the counter minus forked and uncle blocks (canon.ts), so it means canonical blocks;
     - Gas used: the counter. An all-"0" /counters means the index hasn't counted yet (it does so on first
       request): show "—" and ask again, never a false 0. */
  const counting = countersPending(c) && !!t && (t.transactions_count.n > 0 || t.token_transfers_count.n > 0 || t.blocksConfirmed.n > 0 || t.logs_count.n > 0);
  const COUNTING = "The explorer's index is still counting this address; the figure appears in a few seconds";
  const txsV = t && !t.transactions_count.capped ? int(t.transactions_count.n) : t ? html`<span class="faint" title="At least 50; counting">50+</span>` : sk("48px");
  const ttOf = (cc: AddressCounters | null): Html | string => !t ? (cc && !countersPending(cc) ? int(cc.token_transfers_count) : dash("Not reported by the index"))
    : !t.token_transfers_count.capped ? int(t.token_transfers_count.n)
      : cc && Number(cc.token_transfers_count) > 50 ? int(cc.token_transfers_count) : html`<span title="At least 50">50+</span>`;
  const showBlocks = k.signer || addr.has_validated_blocks || (!!c && Number(c.blocksConfirmed) > 0);
  const cells: Html[] = [
    html`<div class="ad-bal"><span class="l">Balance</span><span class="v" title="${chainBal !== null ? "Read from the chain (eth_getBalance at the latest block)" : "From the explorer's index"}">${balanceHtml(chainBal ?? addr.coin_balance)}</span></div>`,
    html`<div><span class="l">Transactions</span><span class="v" data-st="txs">${txsV}</span></div>`,
    html`<div><span class="l">Token transfers</span><span class="v" data-st="tt">${ttOf(c)}</span></div>`,
    html`<div data-tokens><span class="l">Tokens</span><span class="v">${t ? int(t.token_balances_count.n) : dash("Not reported by the index")}</span><span class="s" data-split></span></div>`,
  ];
  if (showBlocks) cells.push(html`<div><span class="l">${k.signer ? "Blocks confirmed" : "Blocks produced"}</span><span class="v" data-st="blocks">${sk("64px")}</span><span class="s" data-st="blocks-s"></span></div>`);
  cells.push(html`<div><span class="l">Gas used</span><span class="v" data-st="gas">${!c ? dash("Not reported by the index") : counting ? dash(COUNTING) : int(c.gas_usage_count)}</span></div>`);
  mount(slot(root, "stats"), html`<div class="statgrid ad-stats" style="--n:${cells.length - 1}">${cells}</div>`);
  const st = (key: string) => root.querySelector<HTMLElement>(`[data-st="${key}"]`);

  // Transactions: exact, from the list (one request up to 50, a few pages above that)
  if (!t || t.transactions_count.capped) {
    txCount(a, { signal, counter: c?.transactions_count }).then((r) => {
      if (signal.aborted) return;
      const el = st("txs");
      if (el) { el.title = r.exact ? "Counted from the explorer's index" : "The index's counter: too many transactions to count here"; liveText(el, int(r.n)); }
      const tab = root.querySelector<HTMLElement>('#adtabs-t-txs .n');
      if (tab && r.exact) tab.textContent = int(r.n);
    }, (e) => { if (!isAbort(e)) mount(st("txs"), dash("Not reported by the index")); });
  }

  // Blocks confirmed: canonical only
  const paintBlocks = (cc: AddressCounters | null) => {
    const el = st("blocks");
    if (!el) return;
    const raw = cc && !countersPending(cc) ? Number(cc.blocksConfirmed) : null;
    if (raw === null) { mount(el, t && t.blocksConfirmed.n > 0 && cc ? dash(COUNTING) : dash("Not reported by the index")); return; }
    nonCanonical(a, signal).then((nc) => {
      if (signal.aborted) return;
      const n0 = canonicalCount(raw, nc), why = excludedText(nc);
      el.title = `Canonical blocks: the index's ${int(raw)} minus ${why ? why.replace(/^excludes /, "") : "none"}`;
      liveText(el, int(n0));
      mount(st("blocks-s"), why);
    }, (e) => { if (!isAbort(e)) mount(el, dash("Not reported by the index")); });
  };
  if (showBlocks) paintBlocks(counting ? null : c);

  // the index counts on first request: ask again (uncached) until it answers, then roll the digits
  if (counting) {
    void (async () => {
      for (const wait of [3000, 5000, 9000]) {
        try { await sleep(wait, signal); } catch { return; }
        const c2 = await api.addressCounters(a, { signal, fresh: true }).catch(() => null);
        if (signal.aborted) return;
        if (!c2 || countersPending(c2)) continue;
        const g = st("gas");
        if (g) { g.removeAttribute("title"); liveText(g, int(c2.gas_usage_count)); }
        const ttEl = st("tt");
        if (ttEl && t?.token_transfers_count.capped) mount(ttEl, ttOf(c2));
        if (showBlocks) paintBlocks(c2);
        return;
      }
    })();
  }
  // FRC-20 · FRC-721 split of the tokens held (a flat list, also the Tokens tab's first page)
  if (t && t.token_balances_count.n > 0) {
    api.addressTokenBalances(a).then((bs) => {
      const f20 = bs.filter((b) => b.token.type === "FRC-20").length, f721 = bs.filter((b) => b.token.type === "FRC-721").length;
      mount(root.querySelector("[data-split]"), `${f20} FRC-20 · ${f721} FRC-721`);
    }).catch(() => { /* the count stays */ });
  }
  // under the stats: balance block, creator
  const parts: Html[] = [];
  if (chainBal !== null) parts.push(html`<span>Balance read from the chain just now ${prov("chain")}</span>`);
  else if (addr.block_number_balance_updated_at) parts.push(html`<span>Balance updated at block ${blockLink(addr.block_number_balance_updated_at)}, from the explorer's index</span>`);
  if (addr.creator_address_hash) parts.push(html`<span>Created by ${addrChip(addr.creator_address_hash)}${addr.creation_transaction_hash ? html` in ${txChip(addr.creation_transaction_hash)}` : ""}</span>`);
  mount(slot(root, "sub"), html`${parts}`);
}

function paintUnused(root: HTMLElement, a: string, signal: AbortSignal) {
  mount(slot(root, "stats"), html`<div class="empty ad-unused">No activity yet on chain 3961. <span data-bal>${sk("120px")}</span></div>`);
  slot(root, "tabs")?.replaceChildren();
  rpc.balance(a, signal).then((b) => {
    mount(root.querySelector("[data-bal]"), html`Balance <span class="num-mono">${units(b, 18, 18)}</span> FMX ${prov("chain")}`);
  }, (e) => { if (!isAbort(e)) mount(root.querySelector("[data-bal]"), html`Balance ${dash(RPC_DOWN)}`); });
}

/* ---------------------------------------------------------------- tabs */

function paintTabs(root: HTMLElement, ctx: Ctx, k: Kind, addr: Address, c: AddressCounters | null, t: TabsCounters | null, choice: ReturnType<typeof resolveTab>,
  jobs: JobRow[] | null, jobsP: Promise<JobRow[] | null>, code: () => Promise<string | null>, agentToken: Promise<boolean>) {
  // transactions: the list's own count ("50+" until counts.ts has counted it; paintHead updates the tab)
  const txs: number | Capped | null = t?.transactions_count ?? (c && Number(c.transactions_count) > 0 ? Number(c.transactions_count) : null);
  // this list carries the forked and uncle rows too, so its count is the index's counter (not the canonical stat)
  const blocksCount: number | Capped = c && Number(c.blocksConfirmed) > 0 ? Number(c.blocksConfirmed) : t?.blocksConfirmed ?? 0;
  const blocksN = n(blocksCount) ?? 0;
  const def = k.signer && (n(txs) ?? 0) === 0 && blocksN > 0 ? "blocks_validated" : "txs";
  const tabs: TabDef[] = [
    { key: "txs", label: "Transactions", count: txs },
    { key: "token_transfers", label: "Token transfers", count: tabCount(t?.token_transfers_count, c?.token_transfers_count) },
    { key: "tokens", label: "Tokens", count: t?.token_balances_count ?? null },
    { key: "coin_balance_history", label: "Balance history", always: addr.coin_balance !== null },
    { key: "blocks_validated", label: k.signer || blocksN === 0 ? "Blocks confirmed" : "Blocks produced", count: blocksCount },
    { key: "logs", label: "Events", count: t?.logs_count ?? (addr.has_logs ? null : 0) },
  ];
  if (k.contract) tabs.push({ key: "contract", label: "Contract", always: true });
  if (jobs && jobs.length) tabs.push({ key: "jobs", label: "Agent jobs", count: jobs.length });
  // hide "no data" tabs that the helper would show for a null count
  const shown = tabs.filter((x) => x.always || x.key === def || x.key === choice.tab || (x.count !== null && x.count !== undefined) || (x.key === "logs" && addr.has_logs));
  const active = choice.tab && shown.some((x) => x.key === choice.tab) ? choice.tab : def;
  ctx.initialTab = active; // only the tab the page opened on reads ?page= from the URL
  const host = slot(root, "tabs")!;
  mount(host, tabsHtml("adtabs", shown, active, "Address sections"));
  // a transaction list longer than 50: the exact count once counts.ts has it (shared with the stat cell)
  if (t?.transactions_count.capped) {
    txCount(ctx.a, { signal: ctx.signal, counter: c?.transactions_count }).then((r) => {
      const n = host.querySelector<HTMLElement>("#adtabs-t-txs .n");
      if (n && r.exact && !ctx.signal.aborted) n.textContent = int(r.n);
    }, () => { /* the tab keeps "50+" */ });
  }
  const abi = (): Promise<AbiItem[] | null> => bookData(ctx.a).then(async (b) => {
    if (b) return b.abi;
    const cl = cloneTarget(await code());
    if (cl) return (await bookData(cl))?.abi ?? null;
    return (await agentToken) ? (await templateData("agenttoken"))?.abi ?? null : null;
  });
  const handle = bindTabs(host, "adtabs", def, (key, panel) => {
    if (key === "txs") txsTab(ctx, panel);
    else if (key === "token_transfers") transfersTab(ctx, panel);
    else if (key === "tokens") tokensTab(ctx, panel, choice.sub);
    else if (key === "coin_balance_history") historyTab(ctx, panel);
    else if (key === "blocks_validated") blocksTab(ctx, panel);
    else if (key === "logs") eventsTab(ctx, panel, abi);
    else if (key === "jobs") jobsTab(ctx, panel, jobsP.then((r) => r ?? []));
    else if (key === "contract") {
      void import("./contract").then(({ renderContract }) => renderContract(panel, { a: ctx.a, addr, code: code(), signal: ctx.signal, agentToken }));
    } else mount(panel, empty("Nothing here."));
  }, ctx.signal);
  ctx.select = (key) => handle.select(key, true);
  // the source state in the line under the stats, once the page has painted (the Contract tab reuses the work)
  if (k.contract) {
    const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 600));
    idle(() => {
      if (ctx.signal.aborted) return;
      void import("./contract").then(({ sourceState }) => sourceState({ a: ctx.a, addr, code: code(), signal: ctx.signal, agentToken })).then((st) => {
        const sub = slot(root, "sub");
        if (ctx.signal.aborted || !sub) return;
        const word = st === "verified" ? prov("verified") : st === "matches" ? prov("matches") : prov("unverified");
        const why = st === "differs" ? "the deployed code differs from the repository build" : st === "unknown" ? "bytecode only" : "";
        sub.insertAdjacentHTML("beforeend", html`<span>Source ${word}${why ? html` <span class="faint">${why}</span>` : ""} <a class="link-inline" href="/address/${ctx.a}?tab=contract" data-tab-link>Contract tab</a></span>`.s);
        sub.querySelector("[data-tab-link]")?.addEventListener("click", (e) => { e.preventDefault(); ctx.select("contract"); host.scrollIntoView({ block: "start" }); });
      }).catch(() => { /* the tab shows its own error */ });
    });
  }
  // a late gateway answer can still add the Agent jobs tab
  if (!jobs && !knownContract(ctx.a)) {
    jobsP.then((r) => {
      if (ctx.signal.aborted || !r?.length || host.querySelector('[data-tab="jobs"]')) return;
      const list = host.querySelector<HTMLElement>("#adtabs")!;
      list.querySelector(".ind")!.insertAdjacentHTML("beforebegin", html`<button type="button" class="tab" role="tab" id="adtabs-t-jobs" data-tab="jobs" aria-controls="adtabs-p-jobs" aria-selected="false" tabindex="-1">Agent jobs<span class="n">${r.length}</span></button>`.s);
      host.insertAdjacentHTML("beforeend", html`<div class="tabpanel" role="tabpanel" id="adtabs-p-jobs" data-panel="jobs" aria-labelledby="adtabs-t-jobs" hidden></div>`.s);
    }).catch(() => { /* no tab */ });
  }
}
