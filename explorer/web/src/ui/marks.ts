/* Status and kind marks, amounts, times and provenance tags (§4.3–§4.6, §4.12). Colour never carries
   meaning alone: every mark has its word. */
import { html, type Html, dash } from "./html";
import { amountCell, amountExact, fmxFee, gasPrice, iso, pct, relTime, timeTitle, utc, big } from "../format";
import { knownContract } from "../known";
import type { Tx } from "../types";

export type Tone = "ok" | "accent" | "warn" | "info" | "";
export const pill = (text: string, tone: Tone = "") => html`<span class="pill${tone ? " " + tone : ""}">${text}</span>`;
export const tag = (text: string) => html`<span class="tag">${text}</span>`;
/** Mono uppercase kind tag: ACCOUNT · CONTRACT · TOKEN · SIGNER · AGENT WALLET, FRC-20 · FRC-721. */
export const kindTag = (text: string) => html`<span class="kind">${text}</span>`;

/** Table status: dot + word (dense rule). Pending is the one dot that pulses. */
export function txStatus(status: Tx["status"] | undefined): Html {
  if (status === "ok") return html`<span class="st"><span class="status-dot ok" aria-hidden="true"></span>Success</span>`;
  if (status === "error") return html`<span class="st"><span class="status-dot bad" aria-hidden="true"></span>Failed</span>`;
  return html`<span class="st"><span class="status-dot pending" aria-hidden="true"></span>Pending</span>`;
}
/** A status dot alone, with the word for readers (tight table cells). */
export function txDot(status: Tx["status"] | undefined): Html {
  const [c, w] = status === "ok" ? ["ok", "Success"] : status === "error" ? ["bad", "Failed"] : ["pending", "Pending"];
  return html`<span class="status-dot ${c}" title="${w}"></span><span class="vh">${w}</span>`;
}
/** Detail head status pill. */
export const txPill = (status: Tx["status"] | undefined) =>
  status === "ok" ? pill("Success", "ok") : status === "error" ? pill("Failed", "warn") : pill("Pending", "info");

export const agentStatusPill = (s: string) => s === "Active" ? pill("Active", "ok") : s === "Paused" ? pill("Paused", "info") : html`<span class="pill">${s}</span>`;
export function jobPill(s: string): Html {
  const tone: Record<string, Tone> = { Requested: "info", Delivered: "accent", Completed: "ok", Released: "ok", Claimed: "ok", Refunded: "info", Disputed: "warn", Resolved: "ok" };
  return pill(s, tone[s] ?? "");
}

/* ---- provenance (§4.12): chain green, signed bright neutral, observed muted, declared dashed ---- */
export type Prov = "chain" | "index" | "abi" | "schedule" | "estimate" | "verified" | "matches" | "unverified";
const PROV: Record<Prov, [string, string, string]> = {
  chain: ["chain", "From the chain", "Read from rpc.ferminux.net at view time."],
  index: ["observed", "From the index", "Read from the explorer's index."],
  abi: ["signed", "Decoded · Ferminux ABI", "Decoded in your browser with the ABIs from the Ferminux repository."],
  schedule: ["signed", "Per schedule", "Computed from the block reward schedule; deterministic, but not read from the index."],
  estimate: ["declared", "Estimate", "An estimate: treat it as a guide."],
  verified: ["chain", "Verified", "Source verified on this explorer."],
  matches: ["signed", "Matches build", "The deployed bytecode matches the Ferminux repository build, checked in your browser."],
  unverified: ["declared", "Not verified", "Source not verified. Bytecode only."],
};
export const prov = (p: Prov) => { const [c, t, why] = PROV[p]; return html`<span class="prov ${c}" title="${why}">${t}</span>`; };

/* ---- amounts (§4.5). Tables: the unit is in the column header. Details: the unit follows in --faint. ---- */
/** Table cell amount; zero renders "0" in --faint. */
export function amt(v: unknown, decimals = 18): Html {
  const s = amountCell(v, decimals);
  return s === "—" ? dash() : s === "0" ? html`<span class="zero">0</span>` : html`${s}`;
}
/** Detail amount, exact, with its unit. */
export function amtExact(v: unknown, unit = "FMX", decimals = 18): Html {
  const s = amountExact(v, decimals);
  return s === "—" ? dash() : html`<span class="num-mono">${s}</span><span class="unit">${unit}</span>`;
}
export const fee = (v: unknown) => { const s = fmxFee(v); return s === "—" ? dash() : s === "0" ? html`<span class="zero">0</span>` : html`${s}`; };
export const gas = (wei: unknown) => { const s = gasPrice(wei); return s === "—" ? dash() : html`<span class="num-mono">${s}</span>`; };

/** "174,382 of 100,000,000 (0.17%)" + a 4 px bar. */
export function gasUsed(used: unknown, limit: unknown, withText = true): Html {
  const u = big(used), l = big(limit);
  if (u === null) return dash();
  const p = l && l > 0n ? Number((u * 1_000_000n) / l) / 10_000 : null;
  const bar = html`<span class="bar" aria-hidden="true"><i style="--p:${p === null ? 0 : Math.min(1, p / 100)}"></i></span>`;
  return withText ? html`<span class="num-mono">${u.toLocaleString("en-US")}${l !== null ? html` <span class="faint">of ${l.toLocaleString("en-US")}</span>` : ""}</span> <span class="faint">(${p === null ? "—" : pct(p, p < 1 ? 2 : 1)})</span> ${bar}` : bar;
}

/* ---- time (§4.6) ---- */
/** Relative time in a <time> with the UTC + local title. The shared ticker (ui/time.ts) keeps it fresh. */
export function ago(v: unknown): Html {
  const d = iso(v);
  return d ? html`<time datetime="${d}" title="${timeTitle(v)}" data-rel>${relTime(v)}</time>` : dash("No timestamp");
}
/** Detail rows: "2026-09-24 04:14:38 UTC (12 h ago)". */
export function when(v: unknown): Html {
  const d = iso(v);
  return d ? html`<time datetime="${d}" title="${timeTitle(v)}">${utc(v)}</time> <span class="faint">(<time datetime="${d}" data-rel>${relTime(v)}</time>)</span>` : dash("No timestamp");
}

/* ---- method chip and tx kind (§4.4) ---- */
/** Decoded name, or the 4-byte selector in --faint; no chip for a plain transfer. A selector chip carries
 *  data-sel / data-to, so ui/txcols `hydrateMethods()` can name it later from the Ferminux ABIs. */
export function methodChip(method: string | null | undefined, rawInput?: string | null, to?: string | null): Html {
  if (!method || !rawInput || rawInput === "0x") return html``;
  const sel = /^0x[0-9a-f]{8}$/i.test(method);
  return sel
    ? html`<span class="mchip sel" title="${method}" data-sel="${rawInput.slice(0, 10)}" data-to="${to ?? ""}">${method}</span>`
    : html`<span class="mchip" title="${method}">${method}</span>`;
}
/** The one-word kind from transaction_types, with inference when the index left it [] (API.md #5). */
export function txKind(tx: Pick<Tx, "transaction_types" | "raw_input" | "to" | "created_contract">): string {
  const t = tx.transaction_types ?? [];
  if (t.includes("contract_creation") || tx.created_contract) return "Contract creation";
  if (t.includes("token_minting")) return "Token mint";
  if (t.includes("token_burning")) return "Token burn";
  if (t.includes("token_transfer")) return "Token transfer";
  if (t.includes("coin_transfer") && (!tx.raw_input || tx.raw_input === "0x")) return "FMX transfer";
  if (t.includes("contract_call") || (tx.to && (tx.to.is_contract || knownContract(tx.to.hash)))) return "Contract call";
  if (!tx.raw_input || tx.raw_input === "0x") return "FMX transfer";
  return "Transaction";
}
export const kindWord = (k: string) => html`<span class="kword">${k}</span>`;
