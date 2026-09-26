/* Validators overview `/validators` (Step 1: checkpoint attestation, no consensus change — scratchpad/
   validators/PLAN.md §3, §12.1 "Ferminux validator nodes"). Dark until VALIDATORS_ENABLED
   (validators/config.ts): a direct hit with no hub configured renders the same not-found page as any other
   unmapped route. deploy/proxy/default.conf routes /validators and /validators/:id to validators.html, which
   only a build with the hub configured contains (vite.config.ts), so without it nginx answers a real 404.
   Reads ValidatorHub only (validators/client.ts, eth_call, never the index or the gateway): seatCount() and
   eligibleCount() for the headline stats, then the most recent CHECKPOINTS heights (multiples of 200) in
   one eth_call batch. Certified is checkpoint().certified, the on-chain bool ValidatorHub.sol's
   attest()/attestBatch() set with its own certifies() pure function — never recomputed or second-guessed
   here (client.ts's isCertifiedRule is kept only as a documented cross-check, unused on this page). */
import "./misc/pages.css";
import "./validators/validators.css";
import { html, mount, dash } from "../ui/html";
import { xpanel, put, stat } from "../ui/kit";
import { table, tableSkeleton, rowLink, type Col } from "../ui/table";
import { pill, prov } from "../ui/marks";
import { note, showError } from "../ui/state";
import { shell } from "./_shell";
import { notFound } from "./notFound";
import { setMeta, navigate, type Params } from "../router";
import { firstHead } from "../head";
import { int } from "../format";
import { isAbort } from "../util";
import { VALIDATORS_ENABLED } from "../validators/config";
import { seatCount, eligibleCount, readCheckpoints, recentCheckpointHeights, hubDownTitle, type CheckpointRead } from "../validators/client";

const CHECKPOINTS = 15;
const NOT_ON_EXPLORER = "This page isn't on the explorer";

export function render(_p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  if (!VALIDATORS_ENABLED) { notFound(root, { h1: NOT_ON_EXPLORER, body: "Search chain 3961 for a block, a transaction, an address, a token or an agent." }); return; }

  setMeta({
    title: "Validators",
    description: "Chain 3961's checkpoint validator seats: deposit 2,000 FMX to run a Ferminux validator node that checks the chain and signs a statement at every checkpoint. Blocks are confirmed by the foundation's authorised signers under proof-of-authority consensus; this is not proof of stake.",
  });
  shell(root, {
    h1: "Validators",
    ident: "Step 1 · checkpoint attestation, no consensus change",
    body: html`
${note(html`Ferminux confirms blocks every 7 seconds with authorised signers — proof-of-authority consensus, not proof of stake. Validator seats are a separate, additional check: anyone can deposit 2,000 FMX to run a <a class="link-inline" href="https://ferminux.net/install.sh" rel="noopener">Ferminux validator node</a>, which keeps its own copy of the chain and, about every 23 minutes, signs a statement naming the block it sees at a checkpoint height. When enough eligible seats agree, this page marks that checkpoint <strong>certified</strong>. Validator seats do not produce or order blocks, and they cannot stop the signers.`)}
${xpanel("vseats", "Seats", html`<div class="statgrid">${[
  stat("seats", "Total seats"), stat("elig", "Eligible now"), stat("interval", "Checkpoint interval"), stat("thresh", "Certification threshold"),
]}</div>`, prov("chain"))}
${xpanel("vcps", "Recent checkpoints", html`<div class="xp-table" data-slot="cps">${tableSkeleton({ caption: "Recent checkpoints", captionHidden: true, cols: CP_COLS }, 8)}</div>`, "")}
<section class="panel vd-lookup" aria-labelledby="vlook-h">
  <div class="panel-head"><h2 id="vlook-h">Look up a seat</h2></div>
  <div class="xp-body"><form class="vd-lookup-f" data-lookup><label class="vh" for="vlook-id">Seat ID</label><input id="vlook-id" name="id" type="number" min="1" step="1" inputmode="numeric" placeholder="Seat ID, e.g. 1" required><button type="submit" class="btn btn-secondary btn-sm">Open</button></form></div>
</section>`,
  });

  root.querySelector<HTMLFormElement>("[data-lookup]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = new FormData(e.target as HTMLFormElement).get("id")?.toString().trim() ?? "";
    if (/^\d+$/.test(v) && Number(v) > 0) navigate(`/validators/${v}`);
  });

  put(root, "interval", "200 blocks");
  put(root, "interval-s", "about 23 min");
  put(root, "thresh", "≥ 20 of ≥ 30 eligible");
  put(root, "thresh-s", "or ⌈⅔ × eligible⌉ if higher");

  const cpHost = root.querySelector<HTMLElement>('[data-slot="cps"]');
  let landed = false;
  window.setTimeout(() => {
    if (signal.aborted || landed) return;
    put(root, "seats", dash(hubDownTitle(undefined)));
    put(root, "elig", dash(hubDownTitle(undefined)));
    showError(cpHost, new Error("The chain didn't answer"), () => void load());
  }, 10_000);

  void load();

  async function load() {
    // independent panels, all started in this tick (the eth_call batch covers seatCount + eligibleCount
    // together; the checkpoint reads need the head first, so they leave in a second batch)
    seatCount(signal).then(
      (n) => { landed = true; put(root, "seats", int(n)); },
      (e) => { if (isAbort(e)) return; landed = true; put(root, "seats", dash(hubDownTitle(e))); },
    );
    eligibleCount(signal).then(
      (n) => { landed = true; put(root, "elig", int(n)); },
      (e) => { if (isAbort(e)) return; landed = true; put(root, "elig", dash(hubDownTitle(e))); },
    );
    const head = await firstHead(signal).catch(() => null);
    if (signal.aborted) return;
    const heights = recentCheckpointHeights(head?.n ?? 0, CHECKPOINTS);
    try {
      const rows = await readCheckpoints(heights, signal);
      if (signal.aborted) return;
      landed = true;
      if (!rows.length) { mount(cpHost, note("No checkpoints have been read from the chain yet.")); return; }
      mount(cpHost, table({ caption: "Recent checkpoints", captionHidden: true, cols: CP_COLS, rows }));
    } catch (e) {
      if (isAbort(e)) return;
      landed = true;
      showError(cpHost, e, () => void load());
    }
  }
}

const CP_COLS: Col<CheckpointRead>[] = [
  { label: "Height", cell: (r) => rowLink(`/block/${r.height}`, html`<span class="num-mono">${int(r.height)}</span>`, `Block ${int(r.height)}`) },
  { label: "Attestations", cell: (r) => html`<span class="num-mono">${int(r.count)}</span> <span class="faint">of ${int(r.eligible)} eligible</span>`, line: 2 },
  { label: "Status", cell: (r) => (r.certified ? pill("Certified", "ok") : r.eligible > 0 ? pill(`Attested by ${int(r.count)}`, "info") : pill("Below minimum", "")), align: "r", end: true },
];
