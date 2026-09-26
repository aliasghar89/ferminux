/* The name book (surfaces/explorer.md §4.1): address → the name a person would use. All client-side, no
   request per address. Resolution order (first match wins):
     1 system contract (contracts.3961.json)   2 signer (vanity number)   3 chain account (Treasury, Reward sink)
     4 agent wallet (GW /accounts)              5 agent owner (GW /agents) 6 token contract (index /tokens)
     7 the index's own AddressParam.name        8 none: the short hash alone
   startBook() warms the GW lists and the tokens list at boot and refreshes them every 60 s while visible;
   each refresh dispatches "fx:book" on document so a page can re-label chips it already painted. */
import { knownContract, knownAccount } from "./known";
import { signerNo } from "./signer";
import { gw, agentsOwnedBy, walletOf, agentById } from "./gateway";
import { api, cachedTokens } from "./api";
import { every, lc, ZERO } from "./util";

export type LabelKind = "contract" | "token" | "signer" | "account" | "agent-wallet" | "agent" | "index";
export interface Label { name: string; kind: LabelKind; id?: number; more?: number }

export function label(addr: string | null | undefined, indexName?: string | null): Label | null {
  if (!addr || lc(addr) === ZERO) return null;
  const c = knownContract(addr);
  if (c) return { name: c.short ?? c.name, kind: c.kind === "token" ? "token" : "contract" };
  const k = signerNo(addr);
  if (k) return { name: `Signer ${k}`, kind: "signer", id: k };
  const a = knownAccount(addr);
  if (a) return { name: a.name, kind: "account" };
  const w = walletOf(addr);
  if (w) {
    const ag = agentsOwnedBy(w.owner)[0];
    return ag ? { name: `${ag.name} wallet`, kind: "agent-wallet", id: ag.id } : { name: "Agent wallet", kind: "agent-wallet" };
  }
  const owned = agentsOwnedBy(addr);
  if (owned.length) return { name: owned[0].name, kind: "agent", id: owned[0].id, more: owned.length - 1 };
  const t = cachedTokens().find((x) => lc(x.address_hash) === lc(addr));
  if (t) return { name: t.symbol ? `${t.name ?? t.symbol} (${t.symbol})` : t.name ?? "Token", kind: "token" };
  if (indexName) return { name: indexName, kind: "index" };
  return null;
}

/** The agent behind an address (owner or agent wallet), for cards and hovercards. */
export function agentFor(addr: string) {
  const w = walletOf(addr);
  const owner = w ? w.owner : addr;
  return agentsOwnedBy(owner);
}
export { agentById };

let started = false;
export async function warmBook(signal?: AbortSignal) {
  await Promise.allSettled([gw.agents(signal), gw.accounts(signal), api.tokens(undefined, null, { signal })]);
  document.dispatchEvent(new CustomEvent("fx:book"));
}
export function startBook() {
  if (started) return;
  started = true;
  every(60_000, () => warmBook(), new AbortController().signal, { now: true });
}
