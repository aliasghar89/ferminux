/* Address tab: Blocks confirmed (§5.6): Block · Turn (seal) · Txs · Reward · Age. The reward is the index's own
   signer (or producer) row; only a block the index hasn't rewarded yet falls back to the schedule's 40 % plus the
   block's tips, tagged PER SCHEDULE. The list also carries this address's forked and uncle blocks: those link by
   hash (the height belongs to the canonical block), are tagged, and earned nothing. Proof-of-work rows read "Produced". */
import { html, type Html } from "../../ui/html";
import { seal } from "../../ui/seal";
import { ago, amt, prov, pill } from "../../ui/marks";
import { rowLink, sub, type Col } from "../../ui/table";
import { int } from "../../format";
import { api } from "../../api";
import { scheduleReward, inTurn } from "../../signer";
import { POSA_BLOCK } from "../../known";
import type { Block } from "../../types";
import { pagedTable, phu, type Ctx } from "./common";

const canonical = (b: Block) => b.type === "block" || !b.type;
const hrefOf = (b: Block) => (canonical(b) ? `/block/${b.height}` : `/block/${b.hash}`);

function reward(b: Block): Html {
  if (!canonical(b)) return html`<span class="zero" title="${b.type === "uncle" ? "An uncle block" : "A forked block"} is not canonical and earned no reward">none</span>`;
  const own = b.rewards?.find((r) => r.type === "signer" || r.type === "producer");
  if (own) return html`${amt(own.reward)}${phu()}`;
  const s = scheduleReward(b.height);
  if (!s) return html`<span class="dash" title="Not reported by the index">—</span>`;
  let tips = 0n;
  try { tips = BigInt(b.priority_fee ?? "0"); } catch { /* keep 0 */ }
  return html`<span class="est" title="Per schedule: signer share ${s.signer} wei + tips ${tips} wei; the index hasn't recorded this block's rewards yet">${amt(s.signer + tips)}</span>${phu()}`;
}
const turn = (ctx: Ctx, b: Block): Html => {
  if (b.height < POSA_BLOCK) return html`<span class="pow-tag" title="Produced before block 160,000, in the proof-of-work era">Produced</span>`;
  const t = inTurn(b.difficulty);
  return html`${seal({ height: b.height, signer: ctx.a, difficulty: b.difficulty, name: false })} <span class="kword">${t ? "in turn" : "out of turn"}</span>`;
};
const COLS = (ctx: Ctx): Col<Block>[] => [
  {
    label: "Block",
    cell: (b) => html`${rowLink(hrefOf(b), html`<span class="num-mono">${int(b.height)}</span>`, `Block ${b.height}${canonical(b) ? "" : b.type === "uncle" ? ", uncle" : ", forked"}`)}${canonical(b) ? "" : html` ${pill(b.type === "uncle" ? "Uncle" : "Forked", "info")}`}${sub(ago(b.timestamp))}`,
  },
  { label: "Turn", cell: (b) => turn(ctx, b), end: true },
  { label: "Txs", cell: (b) => int(b.transactions_count), align: "r", line: 2, l: "txs" },
  { label: "Reward (FMX)", cell: reward, align: "r", line: 2, end: true, l: "reward" },
];

export function blocksTab(ctx: Ctx, panel: HTMLElement) {
  pagedTable<Block>(panel, {
    ctx, tab: "blocks_validated", sticky: true, dense: true,
    caption: "Blocks confirmed by this address",
    cols: COLS(ctx),
    fetch: (next, signal) => api.addressBlocksConfirmed(ctx.a, next, { signal }),
    empty: "No blocks confirmed by this address.",
    foot: (rows) => html`${rows.some((b) => canonical(b) && b.height >= POSA_BLOCK && !b.rewards?.some((r) => r.type === "signer"))
      ? html`<p class="ad-src">${prov("schedule")} Rewards with a dotted underline are the signer's 40% of the block subsidy (0.1 FMX today) plus the block's tips, computed here: the index hasn't recorded those blocks' rewards yet.</p>` : ""}${rows.some((b) => !canonical(b))
      ? html`<p class="ad-src">Blocks tagged Forked or Uncle were confirmed by this address and then replaced at the same height. They are not canonical, earned nothing, and are not counted in the total above.</p>` : ""}`,
  });
}
