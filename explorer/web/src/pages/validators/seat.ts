/* Validator seat `/validators/:id` (Step 1: checkpoint attestation, no consensus change — scratchpad/
   validators/PLAN.md §3.1 seat keys, §3.3 participation/jail/exit). Dark until VALIDATORS_ENABLED
   (validators/config.ts), same as validators.ts.
   Reads ValidatorHubLens.seat(id) for the detail rows (the hub keeps `_seats` internal; only the lens can
   decode it — see validators/config.ts), then ValidatorHub.attested(id, h) for the last PARTICIPATION
   checkpoint heights in one eth_call batch (client.ts's readAttested), rendered as a strip of hit/miss
   cells — the same idea as the signer lanes on /stats, at seat scale — plus ValidatorHub.participation(id,
   n)'s own rolled-up count as a one-line summary. */
import "../misc/pages.css";
import "./validators.css";
import { html, mount } from "../../ui/html";
import { addrChip, blockLink } from "../../ui/hash";
import { kv, type Group } from "../../ui/kv";
import { kvSkeleton } from "../../ui/skeleton";
import { pill, amtExact } from "../../ui/marks";
import { showError } from "../../ui/state";
import { shell, panel, slot } from "../_shell";
import { notFound } from "../notFound";
import { setMeta, type Params } from "../../router";
import { firstHead } from "../../head";
import { int } from "../../format";
import { isAbort, ZERO } from "../../util";
import { VALIDATORS_ENABLED } from "../../validators/config";
import { readSeat, readAttested, readParticipationCount, recentCheckpointHeights, seatLabel, hubDownTitle, type SeatRead } from "../../validators/client";

const PARTICIPATION = 32;

export function render(p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  if (!VALIDATORS_ENABLED) { notFound(root, { h1: "This page isn't on the explorer", body: "Search chain 3961 for a block, a transaction, an address, a token or an agent." }); return; }
  if (!/^\d+$/.test(p.id) || Number(p.id) <= 0) { notFound(root, { h1: "That isn't a validator seat ID", body: "A seat ID is a positive whole number.", query: p.id }); return; }
  const id = Number(p.id);

  setMeta({ title: `Validator seat #${int(id)}`, description: `Seat #${int(id)} on Ferminux's Step 1 checkpoint validators (chain 3961): owner, deposit, jail state, checkpoint attestations and rewards.` });
  shell(root, {
    crumbs: [{ href: "/validators", label: "Validators" }, { label: `#${int(id)}` }],
    h1: `Validator seat #${int(id)}`,
    body: html`<div data-slot="main">${kvSkeleton(["Owner", "Attester", "Reward payee", "Deposit", "Status", "Jailed until"])}</div>
${panel("part", "Attestation record", html`<span class="sk" style="width:280px"></span>`)}`,
  });

  void load();

  async function load() {
    const main = slot(root, "main");
    const headP = firstHead(signal).catch(() => null);
    let s: SeatRead;
    try {
      s = await readSeat(id, signal);
      if (signal.aborted) return;
    } catch (e) {
      if (isAbort(e)) return;
      showError(main, e, () => void load());
      return;
    }
    if (s.owner.toLowerCase() === ZERO) {
      notFound(root, { h1: `Seat #${int(id)} hasn't been opened`, body: "Seat IDs are assigned in order as deposits arrive; this one doesn't exist yet.", links: false });
      return;
    }
    const head = await headP;
    if (signal.aborted) return;
    paint(s, head?.n ?? null);
    void loadAttestationRecord(head?.n ?? null);
  }

  function paint(s: SeatRead, head: number | null) {
    const main = slot(root, "main");
    const st = seatLabel(s, head);
    const groups: Group[] = [
      { title: "Keys", rows: [
        { label: "Owner", value: addrChip(s.owner, { full: true }), hint: "Cold. The only key that can claim, exit, withdraw or rotate keys." },
        { label: "Attester", value: addrChip(s.attester, { full: true }), hint: "Hot, on the node. Can only attest." },
        ...(s.pendingAttester.toLowerCase() !== ZERO ? [{ label: "Pending attester", value: html`${addrChip(s.pendingAttester, { full: true })} <span class="faint">from ${blockLink(s.attesterRotateBlock)}</span>`, hint: "A queued rotateAttester(): the current attester keeps attesting until this block." }] : []),
        { label: "Reward payee", value: addrChip(s.rewardTo, { full: true }) },
      ] },
      { title: "Seat", rows: [
        { label: "Deposit", value: amtExact(s.deposit), hint: "2,000 FMX, or 1,800 after a slash (10% for double attestation)." },
        { label: "Status", value: pill(st.label, st.tone) },
        { label: "Active from", value: blockLink(s.activationBlock), hint: "24 h after the deposit." },
        { label: "Jailed until", hint: "Permissionless below 50% participation over the last 124 checkpoints (about 48 h); unjail after 24 h; downtime never costs the deposit.", value: s.jailed ? blockLink(s.unjailBlock) : html`<span class="faint">Not jailed</span>` },
        ...(s.rawStatus === "Exiting" ? [{ label: "Unbonds at", value: blockLink(s.unbondEndBlock), hint: "14 days after requestExit(); withdraw() is allowed from this block." }] : []),
      ] },
      { title: "Rewards", rows: [
        { label: "Claimable", value: amtExact(s.claimable), hint: "Allocated, unclaimed rewards: 0.025 FMX per accepted attestation (halving at block 4,500,000), paid only while the reward pool covers it." },
      ] },
    ];
    mount(main, kv(groups));
  }

  async function loadAttestationRecord(head: number | null) {
    const host = slot(root, "part");
    try {
      const heights = recentCheckpointHeights(head ?? 0, PARTICIPATION);
      if (!heights.length) { mount(host, html`<span class="faint">No checkpoints yet.</span>`); return; }
      const [hits, count] = await Promise.all([
        readAttested(id, heights, signal),
        readParticipationCount(id, heights.length, signal).catch((e) => { if (isAbort(e)) throw e; return null; }),
      ]);
      if (signal.aborted) return;
      const ordered = [...heights].reverse(); // oldest first, left to right
      const summary = count === null ? "" : html`<p class="vd-part-sum">Attested <span class="num-mono">${int(count)}</span> of the last <span class="num-mono">${int(heights.length)}</span> closed checkpoints.</p>`;
      mount(host, html`${summary}<ol class="vd-part" aria-label="Attested (green) or missed (amber) at each of the last ${int(ordered.length)} checkpoints, oldest first">${ordered.map((h) => {
        const hit = hits.get(h);
        const cls = hit === true ? "hit" : hit === false ? "miss" : "";
        const title = `Checkpoint ${int(h)}: ${hit === true ? "attested" : hit === false ? "missed" : hubDownTitle(undefined)}`;
        return html`<li class="${cls}" title="${title}"></li>`;
      })}</ol><p class="vd-part-key"><span><i class="hit"></i>Attested</span><span><i class="miss"></i>Missed</span></p>`);
    } catch (e) {
      if (isAbort(e)) return;
      showError(host, e, () => void loadAttestationRecord(head));
    }
  }
}
