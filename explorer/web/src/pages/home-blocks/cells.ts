/* Cells shared by the home feeds, /blocks and the block page. The transaction columns live in ui/txcols.ts. */
import { html, type Html, dash } from "../../ui/html";
import { addrChip } from "../../ui/hash";
import { amt } from "../../ui/marks";
import { rowLink } from "../../ui/table";
import { seal } from "../../ui/seal";
import { big, int, pct, short, amountCell, units } from "../../format";
import { scheduleReward } from "../../signer";
import type { Block, Tx } from "../../types";

/** The short hash as a row's primary link (mono, --fs-hash). Never wrapped in .hc: that would trap the
 *  stretched ::after inside the chip. */
export const hashLink = (href: string, h: string, label: string) =>
  rowLink(href, html`<span class="hb-hash">${short(h, 4)}</span>`, label);

/** From → To, with contract creation spelled out. */
export function parties(t: Pick<Tx, "from" | "to" | "created_contract">, copy = false): Html {
  const to = t.to ? addrChip(t.to, { copy })
    : t.created_contract ? html`<span class="kword">Contract creation</span> ${addrChip(t.created_contract, { copy })}`
      : dash();
  return html`<span class="pty">${addrChip(t.from, { copy })}<span class="arrow" aria-hidden="true">→</span><span class="vh"> to </span>${to}</span>`;
}

/** "174,382 · 0.17%" + a 4 px bar: dense gas cell. */
export function gasCell(used: unknown, limit: unknown): Html {
  const u = big(used), l = big(limit);
  if (u === null) return dash();
  const p = l && l > 0n ? Number((u * 1_000_000n) / l) / 10_000 : null;
  const n = u === 0n ? html`<span class="zero">0</span>` : html`${u.toLocaleString("en-US")}`;
  return html`<span class="gas-c">${n}${p === null || u === 0n ? "" : html`<span class="gp">${pct(p, p > 0 && p < 1 ? 2 : 1)}</span><span class="bar" aria-hidden="true"><i style="--p:${Math.min(1, p / 100)}"></i></span>`}</span>`;
}

/** Signer cell for a block row: the seal (authority) or "Produced by" + address (proof-of-work era). */
export function signerCell(b: Pick<Block, "height" | "era" | "producer" | "difficulty">, signer: string | null | undefined): Html {
  if (b.era === "pow") return b.producer ? html`<span class="prod"><span class="faint">Produced by</span> ${addrChip(b.producer, { copy: false, label: false })}</span>` : seal({ height: b.height, signer: null });
  return seal({ height: b.height, signer, difficulty: b.difficulty });
}

export interface RewardView { value: Html; schedule: boolean }
/** Reward (FMX) for a table row: the index's signer reward (the subsidy share plus tips), or, when the index
 *  left `rewards` empty, the schedule's signer share plus the index's tips, marked PER SCHEDULE. */
export function rewardCell(b: Pick<Block, "height" | "era" | "rewards" | "priority_fee" | "type">): RewardView {
  if (b.type === "reorg") return { value: html`<span class="zero" title="A forked block is not canonical and earned no reward">none</span>`, schedule: false };
  if (b.type === "uncle") return { value: html`<span class="zero" title="An uncle block is not canonical and earned no block reward">none</span>`, schedule: false };
  const own = b.rewards.find((r) => r.type === "signer" || r.type === "producer");
  if (own) return { value: amt(own.reward), schedule: false };
  if (b.era === "pow") return { value: dash("Not reported by the index"), schedule: false };
  const s = scheduleReward(b.height);
  if (!s) return { value: dash(), schedule: false };
  const tips = big(b.priority_fee) ?? 0n;
  return {
    value: html`<span class="est" title="Per schedule: the signer's 40% share of the block subsidy${tips > 0n ? " plus the index's tips" : ""}, computed here because the index hasn't recorded this block's rewards yet">${amountCell(s.signer + tips)}</span>`,
    schedule: true,
  };
}

/** Burnt fees in a detail row: FMX when it is at least 0.000001, otherwise the wei. */
export function burntExact(v: unknown): Html {
  const x = big(v);
  if (x === null) return dash();
  if (x > 0n && x < 1_000_000_000_000n) return html`<span class="num-mono">${x.toLocaleString("en-US")}</span><span class="unit">wei</span>`;
  return html`<span class="num-mono">${units(x, 18, 18)}</span><span class="unit">FMX</span>`;
}

/** Size: "611 B" in tables. */
export const sizeCell = (n: number | null | undefined) => (n === null || n === undefined ? dash() : html`${int(n)} B`);
