"use strict";
// Reads /api/status every 5 s. The API is read-only; nothing here writes.
const WEI = 1e18;
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en-US");

function fmx(wei, digits = 4) {
  if (wei === null || wei === undefined) return "–";
  const v = Number(wei) / WEI;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits }) + " FMX";
}
function short(h, n = 8) {
  if (!h || /^0x0+$/.test(h)) return "–";
  return h.slice(0, n + 2) + "…" + h.slice(-4);
}
function num(n) { return n || n === 0 ? fmt.format(n) : "–"; }
function text(id, v) { $(id).textContent = v; }
function duration(sec) {
  if (sec < 90) return Math.round(sec) + " s";
  if (sec < 5400) return Math.round(sec / 60) + " min";
  return (sec / 3600).toFixed(1) + " h";
}

// The sidecar works out one state for the banner (status.Snapshot.phase):
// stopped, node down, setup needed, syncing, not ready, no seat, activating,
// paused, unbonding, watching or attesting, with what to do about it.
function banner(s) {
  const p = s.phase || {};
  $("banner-dot").className = "dot " + (p.tone || "wait");
  text("banner-title", p.title || "Waiting");
  text("banner-detail", p.detail || "");
  document.title = (p.title ? p.title + " · " : "") + "Ferminux Validator";
}

function render(s) {
  text("network", (s.network || "?") + " · chain " + (s.chainId || "?"));
  text("attester", short(s.attester, 6));
  $("attester").title = s.attester || "";
  text("hub", short(s.hub, 6));
  $("hub").title = s.hub || "";
  text("version", s.version ? "fmx-validator " + s.version : "");
  banner(s);

  const y = s.sync || {};
  // a node that has not answered yet has no block height or peer count, not zeros
  text("head", y.head ? num(y.head) : "–");
  text("head-age", y.head ? duration(y.headAgeSeconds || 0) : "–");
  text("peers", y.head ? num(y.peers) : "–");
  text("syncing", y.syncing ? (y.syncTarget > y.head ? "syncing, " + Math.floor((y.head * 100) / y.syncTarget) + "% of " + num(y.syncTarget) : "syncing") : (y.head ? "in sync" : "–"));
  const n = s.node || {};
  text("proc", n.supervised ? (n.running ? "running · pid " + n.pid : "stopped") : "external node");
  $("proc").title = n.restarts ? n.restarts + " restart(s)" + (n.lastExit ? "; last exit: " + n.lastExit : "") : "";
  const ul = $("reasons");
  ul.replaceChildren(...(y.reasons || []).map((r) => { const li = document.createElement("li"); li.textContent = r; return li; }));

  const seat = s.seat;
  text("seat-id", seat ? "#" + seat.id : "–");
  text("seat-state", seat ? seat.statusText : "none");
  text("deposit", seat ? fmx(seat.depositWei, 2) : "–");
  text("activation", seat ? num(seat.activationBlock) : "–");
  text("eligible", seat ? (seat.countedSince ? "yes" : "after 7 days active") : "–");
  $("eligible").title = seat && seat.countedSince ? "since block " + num(seat.countedSince) : "";
  text("owner", seat ? short(seat.owner, 4) : "–");
  $("owner").title = seat ? seat.owner : "";
  let note = s.seatError || "";
  if (seat && seat.jailed) note = "Paused for low participation. The owner can resume it from block " + num(seat.unjailBlock) + ". No deposit is lost for downtime.";
  if (seat && seat.statusText === "unbonding") note = "Unbonding: the deposit can be withdrawn from block " + num(seat.unbondEndBlock) + ".";
  text("seat-note", note);

  const r = s.rewards || {};
  text("per-day", r.expectedPerDayWei ? "about " + fmx(r.expectedPerDayWei, 2) : "–");
  text("per-cp", fmx(r.rewardPerAttestWei));
  text("claimable", fmx(r.claimableWei));
  text("pool", fmx(r.rewardPoolWei, 0));
  text("seats", r.maxSeats ? num(r.occupiedSeats) + " / " + num(r.maxSeats) : "–");
  $("seats").title = r.maxSeats ? num(r.eligibleSeats) + " counted for certification" : "";
  const pn = $("pool-note");
  pn.textContent = r.poolEmpty ? "The reward pool is empty: attestations still count toward certification but earn nothing until it is refilled." : "";
  pn.className = "note" + (r.poolEmpty ? " warn" : "");
  const d = s.participation24h || {}, w = s.participation7d || {};
  text("p24", d.window ? num(d.included) + " / " + d.window : "–");
  text("p7", w.window ? num(w.included) + " / " + w.window : "–");

  text("next-cp", s.nextCheckpoint ? num(s.nextCheckpoint) : "–");
  text("next-open", s.nextOpensAt ? num(s.nextOpensAt) : "–");
  text("next-eta", s.nextOpensAt && y.head ? duration(Math.max(0, s.nextOpensAt - y.head) * 7) : "–");
  const g = s.gas || {};
  text("gas", g.balanceWei !== undefined && g.balanceWei !== null ? fmx(g.balanceWei) : "–");
  const gn = $("gas-note");
  gn.textContent = g.low ? "The attester key is low on FMX for transaction fees. Send it a little FMX, or claim rewards to it from the owner wallet." : "";
  gn.className = "note" + (g.low ? " warn" : "");

  const rows = (s.attestations || []).map((a) => {
    const tr = document.createElement("tr");
    const cells = [
      [num(a.height), "num"], [a.state, "state " + a.state], [short(a.blockHash), "mono"],
      [short(a.tx), "mono"], [a.includedIn ? num(a.includedIn) : "–", "num"], [a.reason || "", "detail"],
    ];
    for (const [v, c] of cells) { const td = document.createElement("td"); td.textContent = v; td.className = c; tr.append(td); }
    return tr;
  });
  if (rows.length) $("rows").replaceChildren(...rows);
}

async function tick() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    render(await res.json());
  } catch (e) {
    $("banner-dot").className = "dot bad";
    text("banner-title", "Cannot reach the sidecar");
    text("banner-detail", String(e.message || e));
  }
}
tick();
setInterval(tick, 5000);
