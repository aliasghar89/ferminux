/* The token-transfer table across tokens: /token-transfers and the address Token transfers tab.
   Desktop: Tx (+ age) · [Dir] · Token + kind · From → To · Amount / ID.
   Phone card: "0x5c47…3bc3 · 3 h ago · WFMX FRC-20 Transfer" / "from → to" / "12.5 WFMX".
   (A single token's own transfers live in pages/tokens/common.ts: that table knows the token already.) */
import { html, type Html } from "./html";
import { addrChip } from "./hash";
import { amt, ago, tag } from "./marks";
import { rowLink, sub, type Col } from "./table";
import { short, amountCell } from "../format";
import type { AddressParam, TokenTransfer } from "../types";

type Party = AddressParam | string | null | undefined;

/** Amount of a token transfer: FRC-20 by its decimals, FRC-721 as #id (a link to the instance). */
export function transferAmount(t: TokenTransfer): Html {
  const id = t.total?.token_id;
  if (id !== null && id !== undefined && id !== "") return html`<a class="num-mono" href="/token/${t.token.address_hash}/instance/${id}">#${id}</a>`;
  const d = t.total?.decimals ?? t.token?.decimals;
  if (d === null || d === undefined || d === "") return html`<span class="num-mono">${amountCell(t.total?.value, 0)}</span> ${tag("raw units")}`;
  return html`${amt(t.total?.value, Number(d))}<span class="ph-unit">${t.token?.symbol ?? ""}</span>`;
}

/** The token as a link (symbol, the name in its title) and its standard. */
export const tokenCell = (t: { address_hash: string; symbol: string | null; name: string | null; type: string }) =>
  html`<a class="xt-tok" href="/token/${t.address_hash}" title="${t.name ?? t.address_hash}">${t.symbol ?? t.name ?? short(t.address_hash, 4)}</a> <span class="kind">${t.type}</span>`;

export const transferKind = (t: TokenTransfer) => (t.type === "token_minting" ? "Mint" : t.type === "token_burning" ? "Burn" : "Transfer");

const plainParty = (p: Party) => addrChip(p, { copy: false });

export function transferCols(o: { dir?: (t: TokenTransfer) => Html; party?: (p: Party) => Html } = {}): Col<TokenTransfer>[] {
  const party = o.party ?? plainParty;
  const cols: Col<TokenTransfer>[] = [
    { label: "Tx", cell: (t) => html`${rowLink(`/tx/${t.transaction_hash}`, html`<span class="mono">${short(t.transaction_hash, 4)}</span>`, `Transaction ${t.transaction_hash}`)}${sub(ago(t.timestamp))}`, w: "150px" },
  ];
  if (o.dir) cols.push({ label: "Dir", cell: o.dir, w: "56px", cls: "tx-c-dir" });
  cols.push(
    { label: "Token", cell: (t) => html`${tokenCell(t.token)} <span class="kword">${transferKind(t)}</span>` },
    { label: "From → To", cell: (t) => html`<span class="tt-pp">${party(t.from)}<span class="arrow" aria-hidden="true">→</span><span class="vh"> to </span>${party(t.to)}</span>`, line: 2 },
    { label: "Amount / ID", cell: (t) => transferAmount(t), align: "r", line: 3, end: true },
  );
  return cols;
}
