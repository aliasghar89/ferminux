// Pull-payment credits widget shared by /streams/, /x402/, /disputes/ and /tokens/.
// StreamPay (claims, cancel refunds), X402Vault (payee earnings), ArbiterPool (rewards, returned
// stake) and AgentTokenFactory (sell proceeds) all credit the recipient inside the contract and
// need an explicit withdraw() — before this widget the pages never showed those balances, so a
// payee who claimed a stream or sold tokens saw nothing arrive in their wallet.
import { ARBITER_POOL_ABI, STREAM_PAY_ABI, TOKEN_FACTORY_ABI, X402_VAULT_ABI, type Abi } from "./abi";
import { config } from "./config";
import { economy } from "./economy";
import { esc, fmxUnit } from "./format";
import { setBusy, toast, txHtml } from "./ui";
import { contractWrite, errMessage, sendCall } from "./wallet";

export type CreditsContract = "streamPay" | "x402Vault" | "arbiterPool" | "tokenFactory";
const META: Record<CreditsContract, { addr: () => string; abi: Abi; fn: string; label: string; source: string }> = {
  streamPay: { addr: () => config.streamPay, abi: STREAM_PAY_ABI, fn: "withdraw", label: "StreamPay credits", source: "claimed streams, subscription income and cancel refunds" },
  x402Vault: { addr: () => config.x402Vault, abi: X402_VAULT_ABI, fn: "withdrawCredits", label: "x402 earnings", source: "settled vouchers paid to this address" },
  arbiterPool: { addr: () => config.arbiterPool, abi: ARBITER_POOL_ABI, fn: "withdraw", label: "Arbiter credits", source: "voting rewards and returned stake" },
  tokenFactory: { addr: () => config.tokenFactory, abi: TOKEN_FACTORY_ABI, fn: "withdraw", label: "Token-sale credits", source: "sell proceeds and claimed distributions" },
};

/** Renders "<label>: X FMX [Withdraw]" into `box` for `addr`; re-reads after a withdraw. Silent (empty box) when the read fails. */
export async function mountCredits(box: HTMLElement | null, which: CreditsContract, addr: string, opts: { compact?: boolean } = {}): Promise<bigint> {
  if (!box) return 0n;
  const m = META[which];
  let amount = 0n;
  try { amount = await economy.credits(which, addr); } catch { box.innerHTML = ""; return 0n; }
  const has = amount > 0n;
  box.innerHTML = `<div class="panel${opts.compact ? "" : ""}" data-credits="${which}"><div class="panel-head"><h3>${esc(m.label)}</h3><span class="pill ${has ? "ok" : ""}">${has ? "withdrawable" : "nothing yet"}</span></div>
    <div class="panel-body">
      <div class="price-line"><span>Credited to you</span><strong class="num">${fmxUnit(amount, 4)}</strong></div>
      <p class="small muted">Pull payment: ${esc(m.source)} accrue here inside the contract and move to your wallet only when you withdraw.</p>
      <div id="credits-status-${which}"></div>
      <button class="btn ${has ? "btn-primary" : "btn-secondary"}" type="button" id="credits-wd-${which}" ${has ? "" : "disabled"} style="width:auto">Withdraw ${has ? fmxUnit(amount, 4) : ""}</button>
    </div></div>`;
  const btn = box.querySelector<HTMLButtonElement>(`#credits-wd-${which}`)!; const status = box.querySelector<HTMLElement>(`#credits-status-${which}`)!;
  btn.addEventListener("click", async () => {
    setBusy(btn, true, "Confirm in wallet…");
    try {
      if (config.mock) { await new Promise((r) => setTimeout(r, 600)); toast("Withdrawn"); await mountCredits(box, which, addr, opts); return; }
      const c = await contractWrite(m.addr(), m.abi);
      const r = await sendCall(c, m.fn, [], {}, (ph) => { if (ph === "pending") setBusy(btn, true, "Waiting for a block…"); });
      toast("Withdrawn");
      await mountCredits(box, which, addr, opts);
      const st = box.querySelector<HTMLElement>(`#credits-status-${which}`); if (st) st.innerHTML = `<div class="alert ok">Withdrawn ${fmxUnit(amount, 4)} to your wallet — ${txHtml(r.hash, "transaction")}.</div>`;
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); }
  });
  return amount;
}
