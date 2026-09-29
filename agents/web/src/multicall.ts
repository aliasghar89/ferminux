// Multicall3 at its canonical address, deployed on chain 3961: many view reads in one eth_call. Every read goes in
// with allowFailure, so one that reverts (ownerOf for an unminted id) comes back as null instead of failing the
// batch. The helpers throw when the multicall itself fails (no Multicall3 at the address, an RPC error, a return
// that does not decode): each caller then falls back to its old one-call-per-read path.
// Imports nothing but ethers (and types), so the tests run it under plain Node.
import { Interface, type Result } from "ethers";
import type { NftStatus } from "./nft";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];
const MC = new Interface(MULTICALL3_ABI);

/** One view call: `fn(...args)` on `target`, encoded and decoded with `iface`. */
export interface Read { target: string; iface: Interface; fn: string; args?: readonly unknown[] }
/** Anything that can make an eth_call (an ethers provider). */
export interface Caller { call(tx: { to: string; data: string }): Promise<string> }

/** Reads per aggregate3. A gallery page sends 82 (41 ids × minted and ownerOf); bigger lists split into parallel calls. */
export const CHUNK = 250;

/** Every read's decoded outputs, in order; null for a read that reverted or whose return did not decode. */
export async function multicall(caller: Caller, reads: readonly Read[], chunk = CHUNK): Promise<(Result | null)[]> {
  const parts: Read[][] = [];
  for (let i = 0; i < reads.length; i += chunk) parts.push(reads.slice(i, i + chunk));
  const got = await Promise.all(parts.map(async (part) => {
    const data = MC.encodeFunctionData("aggregate3", [part.map((r) => ({ target: r.target, allowFailure: true, callData: r.iface.encodeFunctionData(r.fn, [...(r.args ?? [])]) }))]);
    const raw = await caller.call({ to: MULTICALL3, data });
    const res = MC.decodeFunctionResult("aggregate3", raw)[0] as Result;
    if (res.length !== part.length) throw new Error(`Multicall3 answered ${res.length} results for ${part.length} reads`);
    return part.map((r, i): Result | null => {
      const [success, bytes] = res[i] as unknown as [boolean, string];
      if (!success) return null;
      try { return r.iface.decodeFunctionResult(r.fn, bytes); } catch { return null; }
    });
  }));
  return got.flat();
}

/** The first output of every read. Throws when any read failed: the caller's cue to read them one by one. */
export async function multicallValues(caller: Caller, reads: readonly Read[]): Promise<unknown[]> {
  const out = await multicall(caller, reads);
  return out.map((o, i) => {
    if (!o) throw new Error(`${reads[i].fn}() failed inside Multicall3`);
    return o[0];
  });
}

/** Ferminux Agents: minted(id) and ownerOf(id) for every id in one read (ownerOf reverts for an unminted id, which
 *  allowFailure absorbs). Same shape as the per-id path: owner is null when the id is free or ownerOf failed. */
export async function mintStatuses(caller: Caller, target: string, iface: Interface, ids: readonly number[]): Promise<NftStatus[]> {
  const out = await multicall(caller, ids.flatMap((id) => [{ target, iface, fn: "minted", args: [id] }, { target, iface, fn: "ownerOf", args: [id] }]));
  return ids.map((id, i) => {
    const m = out[2 * i], o = out[2 * i + 1];
    if (!m) throw new Error(`minted(${id}) failed inside Multicall3`);
    const minted = Boolean(m[0]);
    return { id, minted, owner: minted && o ? String(o[0]) : null };
  });
}
