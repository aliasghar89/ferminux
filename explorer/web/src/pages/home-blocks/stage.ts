/* The home stage: the block conveyor (surfaces/explorer.md §7.5; motion.md §2, §11.4).
   Transactions and agent work ride the left tube into the live head; confirmed blocks leave on the right.
   Markup: agents/web/index.html lines 34–96 (figure.beams, the beam art, .flow, .lane, .chip), scoped
   `.beams.xstage` (stage.css). Tokens are static markup: this file never creates, removes or reorders a .tk.
   The conveyor carries no data. The only data-driven motion is the block event on a real new head:
   ring flash · face flush · a band out of both tubes · digit roll · the confirming pip pops · the caption
   settles from accent to ink. Never on the first read, never while calm, off-screen or hidden. */
import { html, raw, type Html } from "../../ui/html";
import { calm, liveText, playing, resetText, observeLoop } from "../../motion";
import { onHeadState, headState, type Head } from "../../head";
import { signerNo, inTurn } from "../../signer";
import { int, relTime, short } from "../../format";
import { every, lc } from "../../util";
import { BEAM_ART } from "./beam-art";

const EASE_OUT = "cubic-bezier(.16,1,.3,1)", EASE_STD = "cubic-bezier(.4,0,.2,1)";
const SUMMARY = "Block conveyor: transactions and agent work enter the latest block; confirmed blocks leave.";

const tk = (k: number, cls: string, glyph?: string) =>
  html`<span class="tk" style="--k:${k}"><b class="${cls}">${glyph ? raw(`<svg><use href="#${glyph}"/></svg>`) : ""}</b></span>`;

/** The figure and its caption. Paints with "—" in the chip: the head store fills it. */
export function stageHtml(): Html {
  return html`<figure class="beams xstage" data-loop data-s="fig" aria-label="${SUMMARY}">
  ${raw(BEAM_ART)}
  <div class="flow l" aria-hidden="true"><i></i><b></b></div>
  <div class="flow r" aria-hidden="true"><i></i><b></b></div>
  <div class="lane l" aria-hidden="true">${tk(0, "tk-a", "i-tx")}${tk(1, "tk-b")}${tk(2, "tk-a", "i-bot")}${tk(3, "tk-b")}${tk(4, "tk-a", "i-tx")}${tk(5, "tk-b")}</div>
  <div class="lane r" aria-hidden="true">${tk(0, "tk-a", "i-box")}${tk(1, "tk-b")}${tk(2, "tk-c", "i-check")}${tk(3, "tk-b")}${tk(4, "tk-a", "i-box")}${tk(5, "tk-b")}</div>
  <div class="chip" role="group" aria-label="Latest block">
    <span class="chip-ring" aria-hidden="true"></span>
    <span class="chip-glow" aria-hidden="true"></span>
    <span class="chip-port l" aria-hidden="true"></span><span class="chip-port r" aria-hidden="true"></span>
    <div class="chip-face">
      <i class="chip-lit" aria-hidden="true"></i>
      <span class="chip-live" data-s="live" aria-hidden="true"></span>
      <span class="chip-lbl" aria-hidden="true">Block</span>
      <span class="chip-height" data-s="height">—</span>
      <span class="chip-age" data-s="age" aria-hidden="true"></span>
      <span class="chip-pips" data-s="pips" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
    </div>
    <a class="chip-a" data-s="link" href="/blocks" aria-label="Latest block"></a>
  </div>
</figure>
<p class="hero-cap xcap"><a data-s="cap" href="/blocks"><span data-s="cap-t">Reading the chain head…</span><svg aria-hidden="true"><use href="#i-arrow"/></svg></a></p>`;
}

/** A seal roundel for the caption sentence (same classes as ui/seal.ts; the sentence carries the words). */
const ring = (k: number | null, turn: boolean | null) =>
  html`<span class="seal ${k === null ? "unk" : turn ? "in" : "out"}" aria-hidden="true">${k ?? "?"}</span>`;

export interface Stage {
  /** A head from the store; `prev` null = the first read (no event). */
  head(h: Head, prev: Head | null): void;
  /** The authorised set and its activity over the last 64 blocks (pips). */
  signers(set: string[], activity: Record<string, number>): void;
}

export function bindStage(host: ParentNode, signal: AbortSignal): Stage {
  const $ = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(`[data-s="${s}"]`);
  const fig = $("fig")!, height = $("height"), age = $("age"), pips = $("pips"), live = $("live");
  const link = $<HTMLAnchorElement>("link"), cap = $<HTMLAnchorElement>("cap"), capT = $("cap-t");
  let cur: Head | null = null;
  let set: string[] = [], act: Record<string, number> = {};

  // Loops play only within 200 px of the viewport (motion.md §3.4), through the shared observer.
  // [data-play="off"] pauses every CSS animation inside it.
  fig.dataset.play = "on";
  observeLoop(fig, signal);

  const ageText = (ts: number) => { const s = Math.max(0, Math.round(Date.now() / 1000 - ts)); return s < 2 ? "just now" : s < 90 ? `${s} s ago` : relTime(ts); };
  const paintAge = () => {
    if (!cur) return;
    const t = ageText(cur.ts);
    if (age && age.textContent !== t) age.textContent = t;
    const ca = capT?.querySelector<HTMLElement>("[data-s=cap-age]");
    if (ca && ca.textContent !== t) ca.textContent = t;
  };
  every(1000, () => { if (fig.dataset.play !== "off") paintAge(); }, signal);

  const paintPips = () => {
    if (!pips) return;
    const rows = set.map((a) => ({ a: lc(a), k: signerNo(a) ?? 99 })).sort((x, y) => x.k - y.k);
    if (pips.children.length !== rows.length) pips.innerHTML = rows.map(() => "<i></i>").join("");
    rows.forEach((r, i) => {
      const el = pips.children[i] as HTMLElement;
      el.dataset.a = r.a;
      el.className = cur?.signer && lc(cur.signer) === r.a ? "head" : (act[r.a] ?? 0) > 0 ? "on" : "";
    });
  };

  const paintCaption = (h: Head) => {
    if (!capT || !cap) return;
    const k = signerNo(h.signer);
    const who = h.signer
      ? html` confirmed by ${ring(k, inTurn(h.difficulty))} <b>${k ? `Signer ${k}` : short(h.signer, 4)}</b>`
      : html` confirmed`;
    capT.innerHTML = html`Block <b class="mono">${int(h.n)}</b>${who} · <span data-s="cap-age">${ageText(h.ts)}</span>`.s;
    cap.href = `/block/${h.n}`;
  };

  const down = () => {
    cur = null;
    resetText(height, "—");
    if (age) age.textContent = "";
    if (capT) capT.textContent = "Chain head unreadable right now.";
    if (cap) cap.href = "/blocks";
    if (live) live.className = "chip-live bad";
  };
  onHeadState((s) => {
    if (s === "down") down();
    else if (live) live.className = `chip-live ${s === "ok" ? "ok" : ""}`;
  }, signal);
  if (headState() === "down") down();

  /** A real new block (§7.5): the page's one loud moment, ~1.2 s. */
  function event(h: Head) {
    if (!playing(fig) || calm()) return;
    fig.querySelector(".chip-glow")?.animate([{ opacity: 0, easing: "linear" }, { opacity: 1, offset: 0.1, easing: EASE_OUT }, { opacity: 0 }], { duration: 900 });
    fig.querySelector(".chip-lit")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: EASE_OUT });
    const wave = (sel: string, from: string, to: string) => fig.querySelector(sel)?.animate(
      [{ transform: `translateX(${from})`, opacity: 1 }, { opacity: 1, offset: 0.6 }, { transform: `translateX(${to})`, opacity: 0 }],
      { duration: 1000, delay: 80, easing: "cubic-bezier(.3,.6,.35,1)" });
    wave(".flow.l b", "222%", "-100%"); // the band is 45% of the tube: 100/45 = 222% starts it just inside the chip
    wave(".flow.r b", "-100%", "222%");
    if (h.signer) pips?.querySelector(`[data-a="${lc(h.signer)}"]`)?.animate([{ transform: "scale(1.8)" }, { transform: "scale(1)" }], { duration: 420, easing: EASE_OUT });
    // fresh facts arrive in the accent and settle back to ink (the one allowed colour animation)
    capT?.querySelectorAll("b").forEach((b) => b.animate([{ color: "#05ee93" }, { color: "#05ee93", offset: 0.25 }], { duration: 1200, easing: EASE_STD }));
  }

  return {
    head(h, prev) {
      cur = h;
      liveText(height, int(h.n), true);
      if (link) { link.href = `/block/${h.n}`; link.setAttribute("aria-label", `Latest block ${int(h.n)}`); }
      fig.setAttribute("aria-label", `${SUMMARY} Latest block ${int(h.n)}.`);
      if (live) live.className = "chip-live ok";
      paintAge();
      paintCaption(h);
      paintPips();
      if (prev) event(h);
    },
    signers(s, a) { set = s; act = a; paintPips(); },
  };
}
