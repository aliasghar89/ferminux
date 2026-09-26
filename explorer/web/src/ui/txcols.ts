/* The transaction table (surfaces/explorer.md §5.4), shared by /txs, the block Transactions tab and the address
   Transactions tab. Desktop: Tx · Kind / method · Block · From → To · Value (FMX) · Fee (FMX).
   Phone card: "● 0x5c47…3bc3 · register · 3 h ago" / "from → to" / "0 FMX · fee 0.000213".
   The index only knows 4-byte selectors (API.md #3): `hydrateMethods()` loads the decode chunk after first
   paint and swaps each selector chip for the decoded name in place (silent when the chunk fails, §8.3).
   Styles: explorer.css (`.txc`, `.tx-km`, `.tt-pp`, `.ph-unit`), so every page that lists transactions gets them. */
import { html, type Html } from "./html";
import { addrChip, blockLink } from "./hash";
import { txDot, txKind, amt, fee, ago } from "./marks";
import { rowLink, sub, type Col } from "./table";
import { short } from "../format";
import { isLoadTestTx, ltChip, ltSender, ltSenderPending } from "../loadtest";
import type { AddressParam, Tx } from "../types";

type Party = AddressParam | string | null | undefined;
export interface TxColOpts {
  /** Show the Block column (lists that mix blocks). Default true. */
  block?: boolean;
  /** A direction cell (IN / OUT / SELF) after Tx, for an address's own list. */
  dir?: (t: Tx) => Html;
  /** How a party renders (the address page shows its own address unlinked). */
  party?: (p: Party) => Html;
}

/** Method chip, then the kind word: ONE order everywhere (home feed, lists, block rail). A decoded method
 *  already says "contract call", so that word hides once the chip is named (CSS `.mchip:not(.sel)+.k-call`);
 *  it stays for an undecoded selector and for every other kind. The selector chip carries what the decoder
 *  needs to name it later. */
export function kindMethod(tx: Tx): Html {
  // Wizrd's load test (src/loadtest.ts): the FXLT marker from one of its wallets, not a method; the chip says what
  // it is. A marker whose sender is not known yet paints as any other call and `hydrateMethods` asks about it.
  if (isLoadTestTx(tx)) return ltKind;
  const k = txKind(tx);
  const plain = !tx.raw_input || tx.raw_input === "0x";
  const m = !plain && tx.method
    ? html`<span class="mchip${/^0x[0-9a-f]{8}$/i.test(tx.method) ? " sel" : ""}" title="${tx.method}" data-sel="${tx.raw_input.slice(0, 10)}" data-to="${tx.to?.hash ?? ""}">${tx.method}</span>`
    : "";
  return html`<span class="tx-km"${ltSenderPending(tx) ? html` data-lt-from="${tx.from.hash}"` : ""}>${m}<span class="kword${k === "Contract call" ? " k-call" : ""}">${k}</span></span>`;
}
const ltKind = html`<span class="tx-km">${ltChip()}<span class="kword lt-kw">FMX transfer</span></span>`;

function parties(tx: Tx, party: (p: Party) => Html): Html {
  const to = tx.created_contract
    ? html`<span class="faint">new</span> ${party(tx.created_contract)}`
    : tx.to ? party(tx.to) : html`<span class="faint">—</span>`;
  return html`<span class="tt-pp">${party(tx.from)}<span class="arrow" aria-hidden="true">→</span><span class="vh"> to </span>${to}</span>`;
}

const plainParty = (p: Party) => addrChip(p, { copy: false });

/** The §5.4 column set. */
export function txCols(o: TxColOpts = {}): Col<Tx>[] {
  const party = o.party ?? plainParty;
  const cols: Col<Tx>[] = [
    { label: "Tx", cell: (t) => html`<span class="txc">${txDot(t.status)}${rowLink(`/tx/${t.hash}`, html`<span class="mono">${short(t.hash, 4)}</span>`, `Transaction ${t.hash}`)}</span>${sub(t.timestamp ? ago(t.timestamp) : html`<span class="faint">pending</span>`)}`, w: "150px" },
  ];
  if (o.dir) cols.push({ label: "Dir", cell: o.dir, w: "56px", cls: "tx-c-dir" });
  cols.push({ label: "Kind / method", cell: kindMethod });
  if (o.block !== false) cols.push({ label: "Block", cell: (t) => (t.block_number === null ? html`<span class="faint">—</span>` : blockLink(t.block_number)), hidePhone: true });
  cols.push(
    { label: "From → To", cell: (t) => parties(t, party), line: 2 },
    { label: "Value (FMX)", cell: (t) => html`${amt(t.value)}<span class="ph-unit">FMX</span>`, align: "r", line: 3 },
    { label: "Fee (FMX)", cell: (t) => (t.fee ? fee(t.fee.value) : html`<span class="faint">—</span>`), align: "r", line: 3, end: true, l: "fee" },
  );
  return cols;
}

/** Row attributes: the hash, for "new rows" diffs and in-place updates. */
export const txRowAttrs = (t: Tx) => html`data-h="${t.hash}"`;

/**
 * After first paint: load the decode chunk and replace selector chips inside `root` with decoded names, and label
 * the FXLT-marked rows whose sender turns out to be a load-test wallet (hydrateLoadTest).
 * Silent on failure (the selector stays, §8.3). Safe to call again after a re-render.
 */
export async function hydrateMethods(root: ParentNode, signal?: AbortSignal) {
  void hydrateLoadTest(root, signal);
  if (!root.querySelector(".mchip.sel[data-sel]")) return;
  try {
    const d = await import("../enrich/decode");
    await d.ready(signal);
    if (signal?.aborted) return;
    for (const c of Array.from(root.querySelectorAll<HTMLElement>(".mchip.sel[data-sel]"))) {
      const name = d.methodName(c.dataset.to || null, c.dataset.sel);
      if (!name) continue;
      c.textContent = name;
      c.classList.remove("sel");
      c.title = `${name} (${c.dataset.sel}), decoded with the Ferminux ABI`;
    }
  } catch { /* the chunk failed to load: selectors stay */ }
}

/** Ask the gateway about each marked row's sender (once per address, a few at a time) and swap in the load-test
 *  label for the ones it lists; every other marked row keeps its plain kind. Silent when the gateway is down. */
async function hydrateLoadTest(root: ParentNode, signal?: AbortSignal) {
  const rows = () => Array.from(root.querySelectorAll<HTMLElement>(".tx-km[data-lt-from]"));
  const senders = [...new Set(rows().map((el) => el.dataset.ltFrom!.toLowerCase()))];
  const next = async (): Promise<void> => {
    const a = senders.shift();
    if (a === undefined || signal?.aborted) return;
    const yes = await ltSender(a, signal).catch(() => false);
    if (signal?.aborted) return;
    for (const el of rows()) {
      if (el.dataset.ltFrom!.toLowerCase() !== a) continue;
      if (yes) el.outerHTML = ltKind.s; else delete el.dataset.ltFrom;
    }
    return next();
  };
  await Promise.all(Array.from({ length: Math.min(4, senders.length) }, next));
}
