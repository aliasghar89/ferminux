// /fork.html — the record of the switch to authority consensus. The switch block is a constant of the node's
// chain configuration; everything the page says about it is read back from the chain as you load it: block
// 160,000's own timestamp (the "took effect" date), its hash, the signer that confirmed it and its Clique
// difficulty, against block 159,999's proof-of-work difficulty and producer. The static text is only the
// no-JavaScript fallback for the same facts; nothing here counts down or promises a future event.
import { initChrome, $ } from "../ui";
import { esc, int, short } from "../format";
import { explorerAddr } from "../config";
import { rpc } from "../chainread";

initChrome();

const SWITCH_BLOCK = 160_000;
interface Header { number: string; hash: string; timestamp: string; difficulty: string; miner: string }

const hex = (n: number) => "0x" + n.toString(16);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "5 Sep 2026, 12:11 UTC" — UTC, so the record reads the same everywhere. */
function utcDate(unixS: number): string {
  const d = new Date(unixS * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

async function load() {
  const proof = $("#fk-proof");
  if (!proof) return;
  try {
    const [first, last, signer] = await Promise.all([
      rpc<Header>("eth_getBlockByNumber", [hex(SWITCH_BLOCK), false]),
      rpc<Header>("eth_getBlockByNumber", [hex(SWITCH_BLOCK - 1), false]),
      rpc<string>("clique_getSigner", [hex(SWITCH_BLOCK)]),
    ]);
    const at = parseInt(first.timestamp, 16);
    const time = $("#fk-time");
    if (time) time.textContent = utcDate(at);
    const block = $("#fk-block");
    if (block) block.textContent = int(parseInt(first.number, 16));
    // Clique writes difficulty 2 (in turn) or 1 (out of turn); proof-of-work difficulty is orders larger.
    const cliqueDiff = parseInt(first.difficulty, 16);
    const powDiff = parseInt(last.difficulty, 16);
    proof.innerHTML = `Read from rpc.ferminux.net as you loaded this page: block ${int(SWITCH_BLOCK)} (<span class="mono">${esc(short(first.hash, 6))}</span>) carries the timestamp ${esc(utcDate(at))} and Clique difficulty ${int(cliqueDiff)}, confirmed by signer <a class="link-inline mono" href="${explorerAddr(signer)}" rel="noopener" style="white-space:nowrap">${esc(short(signer, 6))}</a>. Block ${int(SWITCH_BLOCK - 1)}, the last proof-of-work block, carries difficulty ${int(powDiff)} and was produced by <a class="link-inline mono" href="${explorerAddr(last.miner)}" rel="noopener" style="white-space:nowrap">${esc(short(last.miner, 6))}</a>.`;
  } catch {
    proof.textContent = "The chain could not be read just now; the figures above are the recorded values. Check them yourself with eth_getBlockByNumber for block 160,000 (0x27100) on rpc.ferminux.net.";
  }
}

void load();
