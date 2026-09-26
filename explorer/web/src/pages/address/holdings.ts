/* Address tab: Tokens (§5.6). `.seg` FRC-20 · FRC-721. FRC-20: Token · Balance · Holders (no value column;
   the explorer shows no prices). FRC-721: a tile grid of the instances this address owns, image 1:1 on black. */
import { html, mount, type Html } from "../../ui/html";
import { table, tableSkeleton, rowLink, type Col } from "../../ui/table";
import { pagerHtml, bindPager } from "../../ui/pager";
import { slowWatch, sk } from "../../ui/skeleton";
import { empty, showError } from "../../ui/state";
import { amt, tag } from "../../ui/marks";
import { safeHref, int, short, amountCell } from "../../format";
import { api } from "../../api";
import type { TokenBalance, TokenInstance } from "../../types";
import { segButtons, bindSeg, cursorFor, setQuery, phu, type Ctx } from "./common";

const balanceCell = (b: TokenBalance): Html => {
  const d = b.token.decimals;
  if (d === null || d === undefined || d === "") return html`<span class="num-mono">${amountCell(b.value, 0)}</span> ${tag("raw units")}`;
  return html`${amt(b.value, Number(d))}${phu(b.token.symbol ?? "")}`;
};
const COLS: Col<TokenBalance>[] = [
  { label: "Token", cell: (b) => html`${rowLink(`/token/${b.token.address_hash}`, html`<span class="ad-tok-n">${b.token.name ?? short(b.token.address_hash, 4)}</span>`, `${b.token.name ?? "Token"} ${b.token.address_hash}`)}${b.token.symbol ? html` <span class="faint mono">${b.token.symbol}</span>` : ""} <span class="kind">${b.token.type}</span>` },
  { label: "Balance", cell: balanceCell, align: "r", line: 2 },
  { label: "Holders", cell: (b) => int(b.token.holders_count), align: "r", line: 2, end: true, l: "holders" },
];

function frc20(ctx: Ctx, host: HTMLElement) {
  mount(host, tableSkeleton({ caption: "FRC-20 tokens held", captionHidden: true, cols: COLS }, 3));
  const done = slowWatch(host, () => frc20(ctx, host), ctx.signal);
  api.addressTokenBalances(ctx.a, { signal: ctx.signal }).then((all) => {
    done();
    if (ctx.signal.aborted) return;
    const rows = all.filter((b) => b.token.type === "FRC-20").sort((x, y) => (x.token.symbol ?? "").localeCompare(y.token.symbol ?? ""));
    mount(host, rows.length ? table({ caption: "FRC-20 tokens held", captionHidden: true, cols: COLS, rows }) : empty("This address holds no FRC-20 tokens."));
  }, (e) => { done(); showError(host, e, () => frc20(ctx, host)); });
}

const tile = (n: TokenInstance): Html => {
  const img = n.image_url ?? (typeof n.metadata?.image === "string" ? n.metadata.image : null);
  const name = n.metadata?.name ?? `${n.token?.name ?? "Token"} #${n.id}`;
  const addr = n.token?.address_hash ?? "";
  return html`<li class="ad-nft"><a href="/token/${addr}/instance/${n.id}" aria-label="${name}, ${n.token?.symbol ?? ""} #${n.id}">
    <span class="ad-nft-img">${img && safeHref(img) !== "#" ? html`<img src="${img}" alt="" loading="lazy" decoding="async" width="200" height="200">` : html`<span class="ad-nft-none">No image</span>`}</span>
    <span class="ad-nft-n">${name}</span><span class="ad-nft-id">${n.token?.symbol ?? ""} #${n.id}</span></a></li>`;
};

function frc721(ctx: Ctx, host: HTMLElement, first: boolean) {
  const c = first ? { page: 1, params: null, expired: false } : cursorFor(ctx, "tokens");
  mount(host, html`<ul class="ad-nfts skel" aria-busy="true">${Array.from({ length: 4 }, () => html`<li class="ad-nft"><span class="ad-nft-img"></span>${sk("70%")}</li>`)}</ul>`);
  const done = slowWatch(host, () => frc721(ctx, host, first), ctx.signal);
  api.addressNft(ctx.a, c.params, { signal: ctx.signal }).then((p) => {
    done();
    if (ctx.signal.aborted) return;
    const items = p.items.filter((n) => (n.token?.type ?? "FRC-721") === "FRC-721" || n.token?.type === "FRC-1155" || n.token?.type === "FRC-404");
    if (!items.length && c.page === 1) { mount(host, empty("This address holds no FRC-721 tokens.")); return; }
    const pager = c.page > 1 || p.next_page_params ? pagerHtml({ page: c.page, next: p.next_page_params, order: "rank" }) : "";
    mount(host, html`<ul class="ad-nfts" aria-label="FRC-721 tokens held">${items.map(tile)}</ul>${pager}`);
    if (pager) bindPager(host, { page: c.page, next: p.next_page_params, current: c.params });
  }, (e) => { done(); showError(host, e, () => frc721(ctx, host, first)); });
}

/** `sub` is the router's FRC split from ?tab=tokens_erc20 / tokens_nfts; ?std= keeps the choice. */
export function tokensTab(ctx: Ctx, panel: HTMLElement, sub?: string) {
  const q = ctx.query.get("std");
  const asked = sub === "FRC-721" || q === "FRC-721" ? "FRC-721" : sub === "FRC-20" || q === "FRC-20" ? "FRC-20" : null;
  let std = asked ?? "FRC-20";
  panel.innerHTML = html`<div class="seg-row">${segButtons("Token standard", [{ key: "FRC-20", label: "FRC-20" }, { key: "FRC-721", label: "FRC-721" }], std)}</div><div data-list></div>`.s;
  const host = panel.querySelector<HTMLElement>("[data-list]")!;
  const load = (first: boolean) => (std === "FRC-721" ? frc721(ctx, host, first) : frc20(ctx, host));
  let picked = false; // a tap on the switch before the probe below answers wins over the probe
  bindSeg(panel, (k) => { picked = true; std = k; setQuery("std", k === "FRC-721" ? k : null); load(true); });
  if (asked) { load(false); return; }
  mount(host, tableSkeleton({ caption: "Tokens held", captionHidden: true, cols: COLS }, 3));
  // No standard in the URL: open on the one the address holds. An address with only an NFT (Toolbox holds
  // FMXA #10, the treasury #41) used to land on "This address holds no FRC-20 tokens." The list is the one
  // the stat line above already fetched (cached).
  api.addressTokenBalances(ctx.a, { signal: ctx.signal }).then((all) => {
    if (ctx.signal.aborted || picked) return;
    if (!all.some((b) => b.token.type === "FRC-20") && all.some((b) => b.token.type !== "FRC-20")) {
      std = "FRC-721";
      panel.querySelectorAll<HTMLButtonElement>("[data-seg]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.seg === std)));
    }
    load(false);
  }, () => { if (!ctx.signal.aborted && !picked) load(false); });
}
