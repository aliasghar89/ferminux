/* Reads ValidatorHub + ValidatorHubLens over the existing chain RPC client (rpc.ts): eth_call for every
   view below, batched the same way every other page batches (several calls made in the same microtask tick
   leave as one JSON-RPC request — rpc.ts). This is a LAZY module: it pulls in ethers' ABI coder, so pages
   that own it import it directly (they need it to render at all) but block.ts's badge hook reaches it only
   through a dynamic import, so a block page never pays for it while the feature is off (vite.config.ts
   keeps ethers in its own chunk; see recover.ts for the same pattern).
   No eth_getLogs here: every read this lane needs (seats, checkpoints, one seat's attestation history) has
   a view function on one of the two contracts (abi.ts), which is cheaper and simpler to keep in sync than
   an event's topic0. */
import type { Interface } from "ethers";
import { rpc, RpcError, RPC_DOWN } from "../rpc";
import { hub, lens, SEAT_RAW_STATUS } from "./abi";
import { HUB_ADDRESS, LENS_ADDRESS, CHECKPOINT_INTERVAL, MIN_ELIGIBLE_FOR_CERTIFIED, MIN_COUNT_FLOOR, MAX_PARTICIPATION_WINDOW } from "./config";

export { VALIDATORS_ENABLED, CHECKPOINT_INTERVAL, HUB_ADDRESS, LENS_ADDRESS, isCheckpointHeight } from "./config";

/** A read the hub/lens doesn't answer (wrong/old selector, or this height/id doesn't exist): every call
 *  site dashes this independently rather than failing the whole page (§0.2 "never a guess"). */
export class HubReadError extends Error {
  constructor(message: string, public down: boolean) { super(message); this.name = "HubReadError"; }
}
/** The title for a field the contract wouldn't answer: distinguishes "the chain didn't answer" from "this
 *  ABI fragment is stale" so a reader has somewhere to look (abi.ts's own sync note). */
export const hubDownTitle = (e: unknown) => (e instanceof HubReadError && !e.down ? "ValidatorHub didn't recognise this call: the explorer's ABI (src/validators/abi.ts) may be out of sync with the deployed contract" : RPC_DOWN);

async function read<T>(iface: Interface, to: string | null, fn: string, args: unknown[], signal?: AbortSignal): Promise<T> {
  if (!to) throw new HubReadError("Not configured", false);
  const data = iface.encodeFunctionData(fn, args);
  let raw: string;
  try {
    raw = await rpc.ethCall(to, data, signal);
  } catch (e) {
    if (e instanceof DOMException) throw e; // AbortError: let the caller's `if (signal.aborted) return` see it
    throw new HubReadError(e instanceof Error ? e.message : String(e), !(e instanceof RpcError) || e.kind !== "rpc");
  }
  try {
    const out = iface.decodeFunctionResult(fn, raw);
    return (out.length === 1 ? out[0] : out) as unknown as T;
  } catch (e) {
    throw new HubReadError(e instanceof Error ? e.message : String(e), false);
  }
}
const readHub = <T,>(fn: string, args: unknown[], signal?: AbortSignal) => read<T>(hub, HUB_ADDRESS, fn, args, signal);
const readLens = <T,>(fn: string, args: unknown[], signal?: AbortSignal) => read<T>(lens, LENS_ADDRESS, fn, args, signal);

/* ---------------------------------------------------------------- checkpoints (ValidatorHub.checkpoint) */

export interface CheckpointRead { height: number; count: number; eligible: number; total: number; certified: boolean }

/** ValidatorHub.sol certifies(), l.707: eligible ≥ 30 and count ≥ max(20, ⌈2/3 × eligible⌉). checkpoint()
 *  already carries this as a stored `certified` bool (set once, on-chain, by attest()/attestBatch()) — this
 *  is a client-side copy of the same pure rule, used only as a cross-check should the two ever disagree. */
export const isCertifiedRule = (count: number, eligible: number): boolean =>
  eligible >= MIN_ELIGIBLE_FOR_CERTIFIED && count >= Math.max(MIN_COUNT_FLOOR, Math.ceil((2 * eligible) / 3));

export async function readCheckpoint(height: number, signal?: AbortSignal): Promise<CheckpointRead> {
  const cp = await readHub<{ blockHash: string; count: bigint; eligible: bigint; total: bigint; snapshotBlock: bigint; certified: boolean }>("checkpoint", [height], signal);
  return { height, count: Number(cp.count), eligible: Number(cp.eligible), total: Number(cp.total), certified: cp.certified };
}

/** The most recent `n` checkpoint heights at or below `head` (multiples of 200; ValidatorHub.sol
 *  CHECKPOINT_INTERVAL). Genesis is not a checkpoint (isCheckpointHeight says so too). */
export function recentCheckpointHeights(head: number, n: number): number[] {
  const last = Math.floor(head / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
  const out: number[] = [];
  for (let h = last; h > 0 && out.length < n; h -= CHECKPOINT_INTERVAL) out.push(h);
  return out;
}
/** Started together (same tick → one eth_call batch); a height that fails is left out, not thrown for the
 *  whole list, so one bad height never blanks the table. */
export async function readCheckpoints(heights: number[], signal?: AbortSignal): Promise<CheckpointRead[]> {
  const settled = await Promise.allSettled(heights.map((h) => readCheckpoint(h, signal)));
  settled.forEach((r) => { if (r.status === "rejected" && r.reason instanceof DOMException) throw r.reason; });
  return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

export const seatCount = (signal?: AbortSignal) => readHub<bigint>("seatCount", [], signal);
export const eligibleCount = (signal?: AbortSignal) => readHub<bigint>("eligibleCount", [], signal);

/* ---------------------------------------------------------------- seats (ValidatorHubLens.seat) */

export interface SeatRead {
  id: number; owner: string; attester: string; pendingAttester: string; attesterRotateBlock: number; rewardTo: string; signingKey: string;
  deposit: bigint; claimable: bigint; rawStatus: (typeof SEAT_RAW_STATUS)[number]; jailed: boolean;
  activationBlock: number; unjailBlock: number; unbondEndBlock: number; lastAttestedCp: number;
}
export async function readSeat(id: number, signal?: AbortSignal): Promise<SeatRead> {
  const s = await readLens<{
    claimable: bigint; lastAttestedCp: bigint; dutyStartCp: bigint; activationBlock: bigint; countedSince: bigint;
    status: bigint; jailed: boolean; owner: string; unjailBlock: bigint; unbondEndBlock: bigint; slashState: bigint;
    qualified: boolean; attester: string; deposit: bigint; pendingAttester: string; attesterRotateBlock: bigint;
    signingKey: string; rewardTo: string;
  }>("seat", [id], signal);
  return {
    id, owner: s.owner, attester: s.attester, pendingAttester: s.pendingAttester, attesterRotateBlock: Number(s.attesterRotateBlock),
    rewardTo: s.rewardTo, signingKey: s.signingKey, deposit: s.deposit, claimable: s.claimable,
    rawStatus: SEAT_RAW_STATUS[Number(s.status)] ?? "None", jailed: s.jailed,
    activationBlock: Number(s.activationBlock), unjailBlock: Number(s.unjailBlock), unbondEndBlock: Number(s.unbondEndBlock),
    lastAttestedCp: Number(s.lastAttestedCp),
  };
}

export type SeatTone = "ok" | "warn" | "info" | "";
/** A seat's status is Seat.status (None/Bonded/Exiting/Withdrawn) crossed with the `jailed` flag and
 *  whether `head` has reached `activationBlock` yet — none of these alone is "the" status a reader wants. */
export function seatLabel(s: SeatRead, head: number | null): { label: string; tone: SeatTone } {
  if (s.rawStatus === "Withdrawn") return { label: "Withdrawn", tone: "" };
  if (s.rawStatus === "Exiting") return { label: "Unbonding", tone: "info" };
  if (s.rawStatus === "None") return { label: "No such seat", tone: "" };
  if (s.jailed) return { label: "Jailed", tone: "warn" };
  if (head !== null && head < s.activationBlock) return { label: "Pending activation", tone: "info" };
  return { label: "Active", tone: "ok" };
}

/** ValidatorHub.sol attested(seatId, height): the attestation strip, one call per height (batched). */
export async function readAttested(id: number, heights: number[], signal?: AbortSignal): Promise<Map<number, boolean>> {
  const settled = await Promise.allSettled(heights.map(async (h) => [h, await readHub<boolean>("attested", [id, h], signal)] as const));
  settled.forEach((r) => { if (r.status === "rejected" && r.reason instanceof DOMException) throw r.reason; });
  return new Map(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
}
/** ValidatorHub.sol participation(seatId, n): checkpoints attested among the last n closed ones (n ≤ 511). */
export const readParticipationCount = (id: number, n: number, signal?: AbortSignal) =>
  readHub<bigint>("participation", [id, Math.min(n, MAX_PARTICIPATION_WINDOW)], signal);
