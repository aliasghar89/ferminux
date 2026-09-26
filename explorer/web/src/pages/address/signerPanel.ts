/* The signer panel (§5.6 variant "Signer", §6.1): seal and number, the vanity read from the chain, whether the
   address is in the current signer set, its share of the last 64 blocks (clique_status), the last block it
   confirmed and the first epoch checkpoint that lists it. Every row is the chain's word (FROM THE CHAIN),
   except the last confirmed block, which comes from the index. */
import { html, mount, type Html } from "../../ui/html";
import { blockLink } from "../../ui/hash";
import { prov, ago, pill } from "../../ui/marks";
import { kv } from "../../ui/kv";
import { dash } from "../../ui/html";
import { int } from "../../format";
import { rpc, RPC_DOWN } from "../../rpc";
import { api } from "../../api";
import { authorisedSigners, cliqueStatus, signerNo, vanityOf, checkpointSigners, inTurn } from "../../signer";
import { currentHead } from "../../head";
import { lc } from "../../util";

const FIRST_CHECKPOINT = 180_000, EPOCH = 30_000;

export function signerPanel(host: HTMLElement, a: string, signal: AbortSignal) {
  const k = signerNo(a);
  const title = k ? `Signer ${k}` : "Signer";
  const shell = (body: Html) => html`<section class="panel ad-sg" aria-labelledby="sg-h"><div class="panel-head"><h2 id="sg-h"><span class="seal in" aria-hidden="true">${k ?? "?"}</span> ${title}</h2>${prov("chain")}</div>${body}</section>`;
  mount(host, shell(html`<div class="ad-sg-body skel">${kv([[{ label: "Signer set", value: html`<span class="sk" style="width:120px"></span>` }, { label: "Last 64 blocks", value: html`<span class="sk" style="width:160px"></span>` }]])}</div>`));

  const set = authorisedSigners(signal).catch(() => null);
  const status = cliqueStatus(signal).catch(() => null);
  const last = api.addressBlocksConfirmed(a, null, { signal }).then((p) => p.items[0] ?? null).catch(() => null);
  const header = last.then((b) => (b ? rpc.block(b.height, signal).catch(() => null) : null));
  const head = currentHead()?.n ?? null;
  const cps = (async () => {
    const top = head ?? await rpc.blockNumber(signal).catch(() => 0);
    const hs: number[] = [];
    for (let n = FIRST_CHECKPOINT; n <= top; n += EPOCH) hs.push(n);
    const blocks = await Promise.all(hs.map((n) => rpc.block(n, signal).catch(() => null)));
    const first = hs.find((_, i) => blocks[i] && checkpointSigners(blocks[i]!.extraData).some((s) => lc(s) === lc(a)));
    const read = blocks.some(Boolean);
    return read ? { first: first ?? null, count: hs.length } : null;
  })().catch(() => null);

  Promise.all([set, status, last, header, cps]).then(([s, st, lb, h, cp]) => {
    if (signal.aborted) return;
    const inSet = s ? s.includes(lc(a)) : null;
    const act = st ? st.sealerActivity[lc(a)] ?? 0 : null;
    const vanity = h ? vanityOf(h.extraData) : null;
    const rows = [
      { label: "Signer set", value: inSet === null ? dash(RPC_DOWN) : inSet ? html`${pill("Authorised", "ok")} <span class="faint">in clique_getSigners, ${s!.length} signers</span>` : html`${pill("Not in the current set", "info")}` },
      { label: "Vanity", value: vanity ? html`<span class="mono">${vanity}</span> <span class="faint">in the header of block ${int(lb!.height)}</span>` : dash(lb ? RPC_DOWN : "No confirmed block to read it from"), hint: "The first 32 bytes of extraData: each signer writes fmx-signer<k> into the headers it seals, and that is where the number comes from." },
      { label: "Last 64 blocks", value: act === null ? dash(RPC_DOWN) : html`<span class="num-mono">${act}</span> <span class="faint">of ${st!.numBlocks} confirmed</span> <span class="bar" aria-hidden="true"><i style="--p:${Math.min(1, act / (st!.numBlocks || 64))}"></i></span>` },
      { label: "Last confirmed", value: lb ? html`${blockLink(lb.height)} ${ago(lb.timestamp)} <span class="faint">· ${inTurn(lb.difficulty) ? "in turn" : "out of turn"} · from the index</span>` : html`<span class="faint">none yet</span>` },
      { label: "First listed", value: cp === null ? dash(RPC_DOWN) : cp.first ? html`checkpoint ${blockLink(cp.first)}${cp.first === FIRST_CHECKPOINT ? html` <span class="faint">(the first after the switch to signers at block 160,000)</span>` : ""}` : html`<span class="faint">in none of the ${cp.count} epoch checkpoints</span>`, hint: "Every 30,000 blocks from 180,000 an epoch checkpoint header carries the full signer list. This is the first one that names this address." },
    ];
    mount(host, shell(html`<div class="ad-sg-body">${kv([rows])}</div>`));
  });
}
