/* LAZY chunk: client-side decoding with the repo's own ABIs (surfaces/explorer.md §6.4; API.md #3, §6.1).
   The index has no verified contracts, so `method` is a bare selector and every log is undecoded. This module
   picks the ABI for an address (the public book, then agent wallets and agent tokens from the gateway, then the
   generic FRC-20 / FRC-721 / WFMX / DEX-pair set) and decodes call data, events and custom-error reverts.
   Import it with `await import("../enrich/decode")` AFTER first paint; a failed import leaves the raw data in place.
   (A candidate for src/enrich/decode.ts once the address and token pages need it too.) */
import { ABIS, type AbiName, type AbiFrag, type AbiTable } from "./abi.data";
import { decodeCall, decodeEvent, signature, type Arg, type V } from "./abidec";
import { knownContract } from "../known";
import { gw, walletOf } from "../gateway";
import { lc } from "../util";
import type { Log, Tx } from "../types";

export type { Arg, V } from "./abidec";
export type { AbiName } from "./abi.data";

/* ---------------------------------------------------------------- which ABI for an address */

/** Book entries without an `abi` key, by their book name. */
const BY_NAME: Record<string, AbiName> = {
  "DEX Router": "DexRouter", "DEX Factory": "DexFactory", "LiquidityLocker": "LiquidityLocker", "FMX-LP": "DexPair",
  "Bridge": "Bridge", "Faucet": "Faucet", "FMXVesting": "FMXVesting", "Governance multisig": "Multisig",
  "TokenFactory (v1)": "TokenFactory", "AZNT": "AZNT", "USDF": "USDF",
};
const agentTokens = new Map<string, string>(); // token address → symbol (GW /tokens)

/** Warm the gateway lists the ABI choice depends on (agent wallets, agent tokens). Never throws. */
export async function ready(signal?: AbortSignal) {
  const [toks] = await Promise.all([gw.tokens(signal).catch(() => []), gw.accounts(signal).catch(() => [])]);
  toks.forEach((t) => agentTokens.set(lc(t.token), t.symbol));
}
export const agentTokenSymbol = (a: string | null | undefined) => (a ? agentTokens.get(lc(a)) ?? null : null);

export function abiFor(addr: string | null | undefined): AbiName | null {
  if (!addr) return null;
  const c = knownContract(addr);
  if (c) return (c.abi as AbiName | undefined) ?? BY_NAME[c.name] ?? null;
  if (walletOf(addr)) return "AgentAccount";
  if (agentTokens.has(lc(addr))) return "AgentToken";
  return null;
}
const table = (n: AbiName | null): AbiTable | null => (n ? ABIS[n] ?? null : null);

/* ---------------------------------------------------------------- results */

export interface DCall { abi: AbiName; generic: boolean; name: string; sig: string; args: Arg[] }
export interface DLog { log: Log; abi: AbiName | null; generic: boolean; name: string | null; sig: string | null; args: Arg[] | null }
export interface DRevert { name: string; args: Arg[]; text: string }

/** The decoded function name for a list cell, or null (selector stays). Cheap: no argument decoding. */
export function methodName(to: string | null | undefined, input: string | null | undefined): string | null {
  if (!input || input.length < 10) return null;
  const sel = input.slice(0, 10).toLowerCase();
  const own = abiFor(to);
  return table(own)?.f[sel]?.n ?? ABIS.Generic.f[sel]?.n ?? null;
}

/** Decode a transaction's input with the `to` contract's ABI (or the generic token set). */
export function decodeInput(tx: Pick<Tx, "to" | "raw_input">): DCall | null {
  const input = tx.raw_input;
  if (!input || input.length < 10) return null;
  const sel = input.slice(0, 10).toLowerCase();
  const own = abiFor(tx.to?.hash);
  const tries: [AbiName, boolean][] = own ? [[own, false], ["Generic", true]] : [["Generic", true]];
  for (const [n, generic] of tries) {
    const f = ABIS[n].f[sel];
    if (!f) continue;
    try { return { abi: n, generic, name: f.n, sig: signature(f), args: decodeCall(f, input) }; } catch { /* next */ }
  }
  return null;
}

/** Decode one log with the emitter's ABI, falling back to the generic set. */
export function decodeLog(log: Log): DLog {
  const topics = log.topics.filter((t): t is string => !!t);
  const none: DLog = { log, abi: null, generic: false, name: null, sig: null, args: null };
  if (!topics.length) return none;
  const t0 = topics[0].toLowerCase();
  const own = abiFor(log.address?.hash);
  const tries: [AbiName, boolean][] = own ? [[own, false], ["Generic", true]] : [["Generic", true]];
  for (const [n, generic] of tries) {
    for (const f of ABIS[n].e[t0] ?? []) {
      try { return { log, abi: n, generic, name: f.n, sig: signature(f), args: decodeEvent(f, topics, log.data) }; } catch { /* next candidate */ }
    }
  }
  return none;
}

const PANIC: Record<string, string> = { "1": "assertion failed", "17": "arithmetic overflow", "18": "division by zero", "33": "invalid enum value", "34": "bad storage data", "49": "pop on empty array", "50": "array index out of bounds", "65": "out of memory", "81": "call to an uninitialised function" };

/** A revert reason from the index (`revert_reason`: {raw} | string | null) decoded with the `to` ABI. */
export function decodeRevert(tx: Pick<Tx, "to" | "revert_reason">): DRevert | null {
  const r = tx.revert_reason as { raw?: string } | string | null;
  const raw = typeof r === "string" ? (/^0x[0-9a-f]*$/i.test(r) ? r : null) : r?.raw ?? null;
  if (!raw || raw.length < 10) return null;
  const sel = raw.slice(0, 10).toLowerCase();
  const own = table(abiFor(tx.to?.hash));
  const f: AbiFrag | undefined = own?.x[sel] ?? ABIS.Generic.x[sel];
  if (!f) return null;
  try {
    const args = decodeCall(f, raw);
    if (f.n === "Error" && args[0]?.v.k === "str") return { name: f.n, args, text: args[0].v.v };
    if (f.n === "Panic" && args[0]?.v.k === "int") { const c = args[0].v.v.toString(); return { name: f.n, args, text: `Panic: ${PANIC[c] ?? `code ${c}`}` }; }
    return { name: f.n, args, text: args.length ? `${f.n}(${args.map((a) => showPlain(a.v)).join(", ")})` : f.n };
  } catch { return null; }
}

/* ---------------------------------------------------------------- small readers for the sentence catalogue */

export const argOf = (args: Arg[] | null | undefined, name: string): V | undefined => args?.find((a) => a.n === name)?.v;
export const bigOf = (args: Arg[] | null | undefined, name: string): bigint | null => { const v = argOf(args, name); return v?.k === "int" ? v.v : null; };
export const addrOf = (args: Arg[] | null | undefined, name: string): string | null => { const v = argOf(args, name); return v?.k === "addr" ? v.v : null; };
export const strOf = (args: Arg[] | null | undefined, name: string): string | null => { const v = argOf(args, name); return v?.k === "str" ? v.v : null; };
export const boolOf = (args: Arg[] | null | undefined, name: string): boolean | null => { const v = argOf(args, name); return v?.k === "bool" ? v.v : null; };

/** Plain text of a value (revert text, titles). */
export function showPlain(v: V): string {
  switch (v.k) {
    case "int": return v.v.toString();
    case "addr": case "bytes": case "str": case "hashed": return v.v;
    case "bool": return String(v.v);
    case "arr": return `[${v.v.map(showPlain).join(", ")}]`;
    case "tuple": return `(${v.v.map((a) => showPlain(a.v)).join(", ")})`;
  }
}
