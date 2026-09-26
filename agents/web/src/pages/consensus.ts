// /consensus.html — the consensus record. The static text states only the rule (more than half of the
// authorised signers must be confirming); every number is read live: how many signers are authorised, how
// many confirmed a block in the last 64, how many are needed, the margin that leaves, and whether the head is
// still moving. A signer may not confirm again within floor(N/2) blocks of its last one, so with N authorised,
// production needs floor(N/2)+1 of them live — a figure that changes if the signer set is ever voted bigger or
// smaller, which is why the page never hard-codes it.
//
// Source: the node itself (clique_getSigners + clique_status + the head block). If the node's clique namespace
// cannot be read, the gateway's /api/status (services.chain.signers, computed from the same calls) is used and
// the page says so. If neither answers, every figure stays an em-dash: never a reassuring number it did not read.
import { initChrome, $, $$ } from "../ui";
import { esc, int } from "../format";
import { config, explorerAddr } from "../config";
import { rpc } from "../chainread";

initChrome();

interface CliqueStatus { inturnPercent?: number; sealerActivity?: Record<string, number>; numBlocks?: number }
interface SignerRead {
  total: number;
  confirming: number;
  /** the authorised signers in the order the chain lists them, each with its blocks in the window (null: the
   *  source only says it is confirming, not how many) — empty when the source gave counts alone */
  rows: Array<{ address: string; blocks: number | null }>;
  window: number;
  head: number | null;
  /** seconds since the head block, when known */
  headAgeS: number | null;
  source: "node" | "gateway";
}

/** Production needs a majority of the authorised set; the margin is how many more may stop. */
export function tolerance(total: number, confirming: number): { needed: number; spare: number } {
  const needed = Math.floor(total / 2) + 1;
  return { needed, spare: confirming - needed };
}

async function fromNode(): Promise<SignerRead> {
  const [signers, status, head] = await Promise.all([
    rpc<string[]>("clique_getSigners"),
    rpc<CliqueStatus>("clique_status"),
    rpc<{ number: string; timestamp: string }>("eth_getBlockByNumber", ["latest", false]),
  ]);
  const act: Record<string, number> = {};
  for (const [k, v] of Object.entries(status.sealerActivity ?? {})) act[k.toLowerCase()] = Number(v) || 0;
  const rows = signers.map((address) => ({ address, blocks: act[address.toLowerCase()] ?? 0 }));
  return {
    total: signers.length,
    confirming: rows.filter((r) => (r.blocks ?? 0) > 0).length,
    rows,
    window: Number(status.numBlocks) || 64,
    head: parseInt(head.number, 16),
    headAgeS: Math.max(0, Math.floor(Date.now() / 1000) - parseInt(head.timestamp, 16)),
    source: "node",
  };
}

async function fromGateway(): Promise<SignerRead> {
  const r = await fetch(`${config.gateway}/status`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`status ${r.status}`);
  const s = (await r.json()) as { head?: number; services?: { chain?: { headAgeS?: number; signers?: { total?: number; active?: number; silent?: string[]; window?: number } } } };
  const sg = s.services?.chain?.signers;
  if (!sg || !Number.isInteger(sg.total) || !Number.isInteger(sg.active)) throw new Error("no signer state");
  const silent = new Set((sg.silent ?? []).map((a) => a.toLowerCase()));
  // /api/status names only the silent signers; the node's plain signer list, if it answers, fills in the rest
  const listed = await rpc<string[]>("clique_getSigners").catch(() => null);
  return {
    total: sg.total!,
    confirming: sg.active!,
    rows: (listed ?? []).map((address) => ({ address, blocks: silent.has(address.toLowerCase()) ? 0 : null })),
    window: sg.window ?? 64,
    head: s.head ?? null,
    headAgeS: typeof s.services?.chain?.headAgeS === "number" ? s.services.chain.headAgeS : null,
    source: "gateway",
  };
}

/** The node read's head age is measured with this device's clock. Before the page says production has stopped,
 *  the gateway's own measurement (server clock, /api/status) replaces it, so a device clock running a minute
 *  fast cannot announce a halt. If the gateway does not answer, the device's figure stands. */
async function confirmHeadAge(read: SignerRead): Promise<void> {
  if (read.source !== "node" || read.headAgeS === null || read.headAgeS <= 60) return;
  const r = await fetch(`${config.gateway}/status`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  const s = r && r.ok ? ((await r.json().catch(() => null)) as { services?: { chain?: { headAgeS?: number } } } | null) : null;
  const g = s?.services?.chain?.headAgeS;
  if (typeof g === "number") read.headAgeS = g;
}

async function load() {
  const live = $("#cs-live"), head = $("#cs-head"), verdict = $("#cs-verdict"), body = $("#cs-signers"), src = $("#cs-source");
  if (!live || !verdict || !body) return;
  const read = await fromNode().catch(() => fromGateway()).catch(() => null);
  if (!read) {
    for (const id of ["#cs-live", "#cs-head", "#cs-needed", "#cs-spare"]) { const el = $(id); if (el) el.textContent = "—"; }
    verdict.textContent = "Could not read the signer set from rpc.ferminux.net or the gateway just now. Run the calls in section 7 yourself.";
    return;
  }
  await confirmHeadAge(read);
  const { total, confirming, window: span } = read;
  const { needed, spare } = tolerance(total, confirming);
  const idleMin = read.headAgeS !== null && read.headAgeS > 60 ? Math.round(read.headAgeS / 60) : 0;
  const s = (n: number) => (n === 1 ? "" : "s");

  live.textContent = `${int(confirming)} of ${int(total)}`;
  if (head) head.textContent = read.head === null ? "—" : int(read.head);
  const neededEl = $("#cs-needed"); if (neededEl) neededEl.textContent = int(needed);
  const spareEl = $("#cs-spare"); if (spareEl) spareEl.textContent = int(Math.max(spare, 0));
  $$(`[data-cs="total"]`).forEach((el) => { el.textContent = int(total); });
  $$(`[data-cs="needed"]`).forEach((el) => { el.textContent = int(needed); });
  if (src) src.textContent = read.source === "node"
    ? `Read from rpc.ferminux.net as you loaded the page: clique_getSigners, clique_status (the blocks each signer confirmed over the last ${int(span)}) and the head block. Run the same calls yourself: section 7.`
    : `The node's clique_status could not be read just now, so these figures come from the gateway's /api/status, which computes them from the same calls over the last ${int(span)} blocks.`;

  verdict.innerHTML = idleMin
    ? `<b class="bad">No block for ${int(idleMin)} minute${s(idleMin)}: production has stopped.</b> ${int(confirming)} of ${int(total)} signers confirmed a block in the last ${int(span)}; at least ${int(needed)} must be confirming for blocks to continue.`
    : spare > 0
      ? `<b class="ok">${int(confirming)} of ${int(total)} signers confirming.</b> Production stops if fewer than ${int(needed)} confirm, so ${int(spare)} more signer${s(spare)} can stop and blocks continue; one more than that halts the chain.`
      : spare === 0
        ? `<b class="bad">${int(confirming)} of ${int(total)} signers confirming — no margin.</b> Production stops if fewer than ${int(needed)} confirm, so one more signer stopping would halt the chain until a signer returns.`
        : `<b class="bad">${int(confirming)} of ${int(total)} signers confirming.</b> That is below the ${int(needed)} needed; blocks will not be produced until more signers return.`;

  // The table: rebuilt from the live set, so an added or removed signer shows here without a page edit.
  body.innerHTML = read.rows.length
    ? read.rows.map((r, i) => {
        const cell = r.blocks === 0 ? `<span class="warn-text">0 · not confirming</span>` : r.blocks === null ? "confirming" : `${int(r.blocks)} of ${int(span)}`;
        return `<tr data-a="${esc(r.address.toLowerCase())}"><td class="num">${i + 1}</td><td class="addr"><a class="link-inline" href="${explorerAddr(r.address)}" rel="noopener">${esc(r.address)}</a></td><td>Ferminux foundation</td><td class="r sg-live">${cell}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="faint">${int(total)} authorised signers; their addresses could not be listed just now.</td></tr>`;
}

void load();
window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
