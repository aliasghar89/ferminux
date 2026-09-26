/* The signer seal (§4.2), the explorer's signature: a numbered roundel saying which of the signers
   confirmed a block and whether it was that signer's turn.
     in turn (difficulty 2): filled --accent-soft, 1.5 px --accent ring, --accent digit
     out of turn (difficulty 1): no fill, 1 px --border-strong ring, --muted digit
     unknown signer: "?" in --faint · proof-of-work era (< 160,000): no seal, a POW ERA tag
   The number is the vanity's number (fmx-signer<k>), never a list position. Nothing pulses. */
import { html, type Html, dash } from "./html";
import { signerNo, signerAddr, inTurn } from "../signer";
import { POSA_BLOCK } from "../known";
import { short } from "../format";
import { RPC_DOWN } from "../rpc";

export interface SealOpts {
  height: number;
  /** Lower-case or checksummed signer address; undefined = not read (RPC down); null = none (PoW era). */
  signer: string | null | undefined;
  difficulty?: string | number | null;
  /** Show "Signer 1" after the roundel (default true). */
  name?: boolean;
  /** Show the short address after the name (detail pages only). */
  addr?: boolean;
  /** Link the name to the signer's address page. */
  link?: boolean;
}

export function seal(o: SealOpts): Html {
  if (o.height < POSA_BLOCK) return html`<span class="pow-tag" title="Produced before block 160,000, in the proof-of-work era">PoW era</span>`;
  if (o.signer === undefined || o.signer === null) return dash(RPC_DOWN);
  const k = signerNo(o.signer);
  const a = signerAddr(o.signer);
  const turn = o.difficulty === undefined || o.difficulty === null ? null : inTurn(o.difficulty);
  const cls = k === null ? "unk" : turn === false ? "out" : turn === true ? "in" : "out";
  const nm = k ? `Signer ${k}` : "Unknown signer";
  const aria = `Confirmed by ${nm}, ${short(a, 4)}${turn === null ? "" : turn ? ", in turn" : ", out of turn"}`;
  const ring = html`<span class="seal ${cls}" aria-hidden="true">${k ?? "?"}</span>`;
  const tail = o.addr ? html`<span class="hc-h" aria-hidden="true">${short(a, 4)}</span>` : "";
  // The text equivalent is one string ("Confirmed by Signer 1, 0x3322…187d, in turn"); a link carries it as its name.
  if (o.link && o.name !== false) return html`<span class="signer" title="${aria}">${ring}<a class="nm" href="/address/${a}" aria-label="${aria}">${nm}</a>${tail}</span>`;
  return html`<span class="signer" title="${aria}"><span class="vh">${aria}</span>${ring}${o.name === false ? "" : html`<span class="nm" aria-hidden="true">${nm}</span>`}${tail}</span>`;
}

/** Mini seals for the vitals cell (§5.1): numbered, filled = confirmed ≥ 1 of the last 64, hollow = idle. */
export function seals(set: string[], activity: Record<string, number>): Html {
  const rows = set.map((a) => ({ a, k: signerNo(a) ?? 0, n: activity[a.toLowerCase()] ?? 0 })).sort((x, y) => x.k - y.k);
  return html`<span class="signer"><span class="vh">${rows.filter((r) => r.n > 0).length} of ${rows.length} signers confirmed blocks in the last 64</span>${rows.map((r) =>
    html`<span class="seal seal-sm ${r.n > 0 ? "in" : "out"}" aria-hidden="true">${r.k || "?"}</span>`)}</span>`;
}
