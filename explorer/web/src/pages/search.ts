/* Search results `/search-results?q=` (§5.14).
   1. Redirect first, with replaceState (no history entry):
        a complete address → /address/:a and a block number → /block/:n, locally with no request;
        otherwise the index's check-redirect (a 64-hex block or tx hash, an exact address) → /block, /tx or /address;
        a 64-hex hash the index doesn't know yet but the chain does (tx or block) → /tx/:h or /block/:h.
   2. Otherwise the index's /search?q= (paged, 50) merged with the name book (agents from the gateway, the
      contract book, the signers, the chain accounts), de-duplicated by address, grouped in the omnibox order
      (Agents · Contracts · Signers · Tokens · Addresses · Blocks · Transactions). Each row is one 48 px link
      with glyph + label + secondary + the matched field. The count line is the page's one live region.
   3. Empty: "Nothing on chain 3961 matches …" + three suggestions; the large omnibox stays pre-filled on top.
   Book matches come on page 1 only; deeper pages are the index's. A failed source never blanks the page:
   the other source still shows, with one line saying what is missing. */
import "./misc/pages.css";
import { html, mount, type Html } from "../ui/html";
import { icon, type IconId } from "../ui/icons";
import { skLine } from "../ui/skeleton";
import { kindTag } from "../ui/marks";
import { omniboxHtml, bindOmnibox, TRY } from "../ui/omnibox";
import { pagerHtml, bindPager, pageOf } from "../ui/pager";
import { errorBox } from "../ui/state";
import { shell } from "./_shell";
import { navigate, setMeta, type Params } from "../router";
import { api, searchHref } from "../api";
import { rpc } from "../rpc";
import { gw, GW_DOWN, type Agent } from "../gateway";
import { CONTRACTS, ACCOUNTS, POSA_BLOCK } from "../known";
import { authorisedSigners, signerNo } from "../signer";
import { label as bookLabel } from "../book";
import { short, int, relTime, utc } from "../format";
import { isAddr, isHash, isAbort, lc } from "../util";
import type { Paged, SearchItem } from "../types";

type Group = "Agents" | "Contracts" | "Signers" | "Tokens" | "Addresses" | "Blocks" | "Transactions";
const ORDER: Group[] = ["Agents", "Contracts", "Signers", "Tokens", "Addresses", "Blocks", "Transactions"];
const NOUN: Record<Group, [string, string]> = {
  Agents: ["agent", "agents"], Contracts: ["contract", "contracts"], Signers: ["signer", "signers"], Tokens: ["token", "tokens"],
  Addresses: ["address", "addresses"], Blocks: ["block", "blocks"], Transactions: ["transaction", "transactions"],
};
interface Hit { group: Group; key: string; href: string; glyph: IconId | "seal"; sealNo?: number | null; label: string; id?: string; sub: Html | string; field: string }

const redirect = (to: string) => queueMicrotask(() => navigate(to, { replace: true }));

export function render(_p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const q = (query.get("q") ?? "").trim();

  // 1a · local redirects: no request, nothing painted
  if (isAddr(q)) { redirect(`/address/${q}`); return; }
  if (/^\d{1,3}(,\d{3})+$|^\d+$/.test(q)) { redirect(`/block/${q.replace(/,/g, "")}`); return; }

  const title = q ? `Results for “${q}”` : "Search";
  setMeta({ title, noindex: true, description: "Search Ferminux Network (chain 3961) for blocks, transactions, addresses, tokens and agents." });
  shell(root, {
    h1: title,
    body: html`${omniboxHtml({ large: true, value: q, label: "Search chain 3961" })}
      <p class="sr-count" role="status" aria-live="polite" data-slot="count"></p>
      <div class="stack" data-slot="results">${q ? html`<div class="skel" aria-busy="true">${[80, 64, 72, 56].map((w) => skLine(`${w}%`))}</div>` : ""}</div>`,
  });
  const f = root.querySelector<HTMLFormElement>("[data-omni]");
  if (f) bindOmnibox(f);
  const out = root.querySelector<HTMLElement>('[data-slot="results"]')!;
  const count = root.querySelector<HTMLElement>('[data-slot="count"]')!;

  if (!q) {
    mount(out, html`<p class="sr-hint">Search accepts block numbers, 0x hashes and addresses, token names and symbols, and agent names.</p>
      <p class="try">Try: ${TRY.map((t) => html`<a href="${t.href}">${t.label}</a>`)}</p>`);
    return;
  }
  void run(q, query, signal, out, count);
}

async function run(q: string, query: URLSearchParams, signal: AbortSignal, out: HTMLElement, count: HTMLElement) {
  const cur = pageOf(query);
  const hex64 = isHash(q);

  // Everything starts at once; the redirect check decides whether the rest is ever shown.
  const settled = Promise.allSettled([
    api.search(q, cur.params, { signal }),
    cur.page === 1 ? gw.agents(signal) : Promise.resolve([] as Agent[]),
    cur.page === 1 && /signer|^0x/i.test(q) ? authorisedSigners(signal) : Promise.resolve([] as string[]),
  ]);
  const chain = cur.page === 1 && hex64 ? Promise.allSettled([rpc.tx(q, signal), rpc.blockByHash(q, signal)]) : null;

  // 1b · the index's exact-hit redirect (block or tx hash, address), then the chain for fresh hashes
  if (cur.page === 1) {
    try {
      const r = await api.checkRedirect(q, { signal });
      if (signal.aborted) return;
      if (r.redirect && r.parameter) {
        redirect(r.type === "block" ? `/block/${r.parameter}` : r.type === "transaction" ? `/tx/${r.parameter}` : `/address/${r.parameter}`);
        return;
      }
    } catch (e) { if (isAbort(e)) return; /* fall through to the search */ }
    if (chain) {
      const [tx, blk] = await chain;
      if (signal.aborted) return;
      if (tx.status === "fulfilled" && tx.value) { redirect(`/tx/${q}`); return; }
      if (blk.status === "fulfilled" && blk.value) { redirect(`/block/${q}`); return; }
    }
  }

  // 2 · the index's search + the name book; each may fail on its own
  const [idx, agents, signers] = await settled;
  if (signal.aborted) return;

  const hits: Hit[] = [];
  const seen = new Set<string>();
  const add = (h: Hit) => { if (seen.has(h.key)) return; seen.add(h.key); hits.push(h); };
  const t = q.toLowerCase();
  const hexPrefix = /^0x[0-9a-f]{3,39}$/i.test(q) ? t : null;
  const addrMatch = (a: string) => hexPrefix !== null && lc(a).startsWith(hexPrefix);

  if (cur.page === 1) {
    // agents: name contains, "#12" / "agent 12", or the owner address prefix
    const idm = q.match(/^(?:agent\s*)?#\s*(\d+)$/i) ?? q.match(/^agent\s+(\d+)$/i);
    const list = agents.status === "fulfilled" ? agents.value : [];
    list.forEach((a) => {
      const byName = t.length >= 2 && a.name.toLowerCase().includes(t);
      const byId = idm && Number(idm[1]) === a.id;
      const byAddr = addrMatch(a.owner);
      if (!byName && !byId && !byAddr) return;
      add({
        group: "Agents", key: `agent:${a.id}`, href: `/address/${a.owner}?tab=jobs`, glyph: "i-bot", label: a.name, id: `#${a.id}`,
        sub: html`${a.status} · ${int(a.jobsCompleted)} ${a.jobsCompleted === 1 ? "job" : "jobs"} completed · owner ${short(a.owner, 4)}`,
        field: byName ? "name" : byId ? "id" : "owner",
      });
      seen.add(lc(a.owner));
    });
    // the contract book (tokens in it are left to the index's token rows, which carry the standard)
    CONTRACTS.forEach((c) => {
      const names = [c.name, c.long ?? "", c.short ?? ""].map((s) => s.toLowerCase());
      const byName = t.length >= 2 && names.some((s) => s && s.includes(t));
      if (!byName && !addrMatch(c.address)) return;
      if (c.kind === "token" && idx.status === "fulfilled" && idx.value.items.some((i) => lc(i.address_hash) === lc(c.address))) return;
      add({
        group: c.kind === "token" ? "Tokens" : "Contracts", key: lc(c.address), href: c.kind === "token" ? `/token/${c.address}` : `/address/${c.address}`,
        glyph: c.kind === "token" ? "i-coins" : "i-file-code", label: c.long ?? c.name,
        sub: html`${c.kind === "impl" ? "Implementation" : c.kind === "token" ? "Token contract" : "Contract"} · ${short(c.address, 4)}`, field: byName ? "name" : "address",
      });
    });
    // signers: "signer", "signer 2", or an address prefix
    const sm = t.match(/^signers?\s*(\d)?$/);
    (signers.status === "fulfilled" ? [...signers.value] : []).sort((x, y) => (signerNo(x) ?? 99) - (signerNo(y) ?? 99)).forEach((a) => {
      const k = signerNo(a);
      if (!(sm && (!sm[1] || Number(sm[1]) === k)) && !addrMatch(a)) return;
      add({ group: "Signers", key: lc(a), href: `/address/${a}`, glyph: "seal", sealNo: k, label: k ? `Signer ${k}` : "Signer", sub: html`Authorised signer · ${short(a, 4)}`, field: sm ? "name" : "address" });
    });
    // chain accounts (Treasury, Reward sink)
    ACCOUNTS.forEach((a) => {
      const byName = t.length >= 3 && a.name.toLowerCase().includes(t);
      if (!byName && !addrMatch(a.address)) return;
      add({ group: "Addresses", key: lc(a.address), href: `/address/${a.address}`, glyph: "i-landmark", label: a.name, sub: html`Chain account · ${short(a.address, 4)}`, field: byName ? "name" : "address" });
    });
  }

  // the index's rows
  const items: SearchItem[] = idx.status === "fulfilled" ? idx.value.items : [];
  items.forEach((it) => {
    if (it.type === "token" && it.address_hash) {
      const nm = it.name ?? it.symbol ?? "Token";
      const field = (it.symbol ?? "").toLowerCase().includes(t) ? "symbol" : (it.name ?? "").toLowerCase().includes(t) ? "name" : "address";
      add({ group: "Tokens", key: lc(it.address_hash), href: searchHref(it), glyph: "i-coins", label: it.symbol && it.symbol !== nm ? `${nm} (${it.symbol})` : nm, sub: html`${it.token_type ?? "Token"} · ${short(it.address_hash, 4)}`, field });
    } else if (it.type === "block" && it.block_number !== undefined) {
      add({ group: "Blocks", key: `block:${it.block_number}`, href: `/block/${it.block_number}`, glyph: "i-box", label: `Block ${int(it.block_number)}`, sub: html`${it.timestamp ? html`<time datetime="${it.timestamp}" title="${utc(it.timestamp)}">${relTime(it.timestamp)}</time> · ` : ""}${it.block_number < POSA_BLOCK ? "proof-of-work era" : "confirmed"}${it.block_hash ? html` · ${short(it.block_hash, 4)}` : ""}`, field: "number" });
    } else if (it.type === "transaction" && it.transaction_hash) {
      add({ group: "Transactions", key: `tx:${lc(it.transaction_hash)}`, href: `/tx/${it.transaction_hash}`, glyph: "i-tx", label: short(it.transaction_hash, 8), sub: it.timestamp ? html`<time datetime="${it.timestamp}" title="${utc(it.timestamp)}">${relTime(it.timestamp)}</time>` : "", field: "hash" });
    } else if (it.address_hash) {
      const l = bookLabel(it.address_hash, it.name ?? null);
      const contract = it.type === "contract" || l?.kind === "contract";
      add({
        group: l?.kind === "agent" || l?.kind === "agent-wallet" ? "Agents" : contract ? "Contracts" : "Addresses",
        key: lc(it.address_hash), href: searchHref(it), glyph: contract ? "i-file-code" : l?.kind === "agent" || l?.kind === "agent-wallet" ? "i-bot" : "i-user",
        label: l?.name ?? short(it.address_hash, 6), sub: html`${contract ? "Contract" : "Address"} · ${short(it.address_hash, 4)}`,
        field: (it.name ?? "").toLowerCase().includes(t) ? "name" : "address",
      });
    }
  });

  paint(q, hits, out, count, {
    idxError: idx.status === "rejected" && !isAbort(idx.reason) ? idx.reason : null,
    gwDown: agents.status === "rejected" && !isAbort(agents.reason),
    page: cur.page, next: idx.status === "fulfilled" ? idx.value.next_page_params : null, current: cur.params, expired: cur.expired,
    retry: () => void run(q, query, signal, out, count),
  });
}

/* ------------------------------------------------------------------ rendering */

const markMatch = (text: string, q: string): Html => {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? html`${text}` : html`${text.slice(0, i)}<b>${text.slice(i, i + q.length)}</b>${text.slice(i + q.length)}`;
};

const glyphOf = (h: Hit): Html => h.glyph === "seal"
  ? html`<span class="seal out sr-g" aria-hidden="true">${h.sealNo ?? "?"}</span>`
  : icon(h.glyph, "sr-g", 16);

function row(h: Hit, q: string): Html {
  return html`<li><a class="sr-row" href="${h.href}">${glyphOf(h)}<span class="sr-l">${markMatch(h.label, q)}${h.id ? html`<span class="hc-id">${h.id}</span>` : ""}</span><span class="sr-s">${h.sub}</span><span class="sr-m">${kindTag(h.field)}</span></a></li>`;
}

interface PaintOpts { idxError: unknown; gwDown: boolean; page: number; next: Paged<SearchItem>["next_page_params"]; current: Paged<SearchItem>["next_page_params"]; expired: boolean; retry: () => void }

function paint(q: string, hits: Hit[], out: HTMLElement, count: HTMLElement, o: PaintOpts) {
  const by = new Map<Group, Hit[]>();
  hits.forEach((h) => { const l = by.get(h.group) ?? []; l.push(h); by.set(h.group, l); });
  const groups = ORDER.filter((g) => by.has(g));
  const n = hits.length;

  count.innerHTML = n
    ? html`<strong>${int(n)}</strong> ${n === 1 ? "result" : "results"}${o.next ? " on this page" : ""}${groups.map((g) => { const k = by.get(g)!.length; return html` · ${int(k)} ${NOUN[g][k === 1 ? 0 : 1]}`; })}`.s
    : "No results";

  const warn: Html[] = [];
  if (o.idxError) warn.push(html`<div data-k="idx-err">${errorBox(o.idxError)}</div>`);
  if (o.gwDown) warn.push(html`<p class="xp-msg">${GW_DOWN} Agent names are missing from these results.</p>`);

  if (!n) {
    const partial = /^0x[0-9a-f]*$/i.test(q) && !isAddr(q) && !isHash(q);
    mount(out, html`${warn}<div class="empty sr-empty">
      <p>Nothing on chain 3961 matches “${q}”.</p>
      <ul>
        ${partial ? html`<li><span class="mono">${short(q, 10)}</span> has ${q.length - 2} hexadecimal characters: an address has 40 and a hash 64.</li>` : ""}
        ${isHash(q) ? html`<li>Neither the explorer's index nor the chain knows a transaction or block with this hash. If it was sent just now, it appears once a signer confirms the next block (about 7 s).</li>` : ""}
        <li>Search accepts block numbers, 0x hashes and addresses, token names and symbols, and agent names.</li>
        ${partial || isHash(q) ? "" : html`<li>Addresses and hashes must be complete (0x + 40 or 64 hex characters).</li>`}
        <li>Try: ${TRY.filter((x) => x.label !== "AgentRegistry").map((x, i) => html`${i ? " · " : ""}<a class="link-inline" href="${x.href}">${x.label}</a>`)}.</li>
      </ul>
    </div>`);
  } else {
    mount(out, html`${warn}${groups.map((g) => html`<section class="sr-group" aria-labelledby="sr-${g}"><h2 id="sr-${g}">${g}<span>${by.get(g)!.length}</span></h2><ul class="sr-list">${by.get(g)!.map((h) => row(h, q))}</ul></section>`)}
      ${o.page > 1 || o.next ? pagerHtml({ page: o.page, next: o.next, expired: o.expired, order: "rank" }) : ""}`);
    bindPager(out, { page: o.page, next: o.next, current: o.current });
  }
  out.querySelector("[data-retry]")?.addEventListener("click", o.retry, { once: true });
}
