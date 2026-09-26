/* The block page's one hook into this lane (src/pages/block.ts): a certified / attested badge on checkpoint
   heights. Reached only through `await import("../validators/blockBadge")`, so a block page never loads
   ethers (client.ts) unless it is actually a checkpoint height with the hub configured — see config.ts's
   isCheckpointHeight(), which block.ts checks first, with no import cost, before bothering with this file. */
import { html, mount, type Html } from "../ui/html";
import { pill } from "../ui/marks";
import { int } from "../format";
import { readCheckpoint } from "./client";

/** Paint into `host` once the checkpoint's attestation count is known. This is a bonus mark on the block
 *  page, never a reason to block or error it: any failure (RPC down, a stale ABI guess) just leaves the
 *  slot empty, silently, the same way a forked block's missing signer degrades quietly elsewhere. */
export async function paintCertifiedBadge(host: HTMLElement, height: number, signal: AbortSignal): Promise<void> {
  try {
    const cp = await readCheckpoint(height, signal);
    if (signal.aborted) return;
    mount(host, badge(cp.count, cp.eligible, cp.certified));
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
    // stay silent rather than guess — dash() would claim more certainty than "we couldn't read this" needs
  }
}

function badge(count: number, eligible: number, certified: boolean): Html {
  const title = `Checkpoint attestations: ${int(count)} of ${int(eligible)} eligible validator seats`;
  if (certified) return html` <a href="/validators" title="${title} · meets the certification threshold">${pill("Certified", "ok")}</a>`;
  if (eligible > 0) return html` <a href="/validators" title="${title} · below the certification threshold">${pill(`Attested by ${int(count)}`, "info")}</a>`;
  return html``;
}
