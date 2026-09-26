// The validator pilot as /validators/ sees it: the ValidatorHub's rules, the seat proof the validator app prints
// (fmx-validator seat-proof), and what a seat's state means. Pure: only ethers, no DOM and no network, so
// test/validatorPilot.test.mjs runs it under plain Node and the page and the tests share one set of rules.
//
// Source of truth: agents/contracts/src/validators/ValidatorHub.sol and ValidatorHubLens.sol. The constants and
// ABI fragments below are checked against that source by the unit test, and every fragment's selector against
// a fresh compile of it by scripts/validators-e2e.mjs.
import { Interface, SigningKey, TypedDataEncoder, computeAddress, getAddress, solidityPackedKeccak256, type Result } from "ethers";

export const CHAIN_ID = 3961;
/** ValidatorHub.SEAT_DEPOSIT: openSeat takes exactly this, no more and no less. */
export const SEAT_DEPOSIT_WEI = 2_000n * 10n ** 18n;
/** The pilot's seat cap (set in the deploy transaction; the live value is read from maxSeats()). */
export const PILOT_MAX_SEATS = 20;
export const BLOCK_SECONDS = 7;
export const ACTIVATION_DELAY = 12_343; // 24 h after the deposit
export const ELIGIBILITY_DELAY = 86_400; // counts for certification 7 days after activation
export const UNBONDING_PERIOD = 172_800; // 14 days
export const UNJAIL_DELAY = 12_343; // 24 h
export const CHECKPOINT_INTERVAL = 200;
export const JAIL_WINDOW = 124; // checkpoints
export const MIN_ELIGIBLE_FOR_CERT = 30;
export const HUB_NAME = "Ferminux Validator Hub";
export const HUB_VERSION = "1";
export const ENODE_TAG = "FMX_VALIDATOR_NODE_V1";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddr = (a: unknown): a is string => typeof a === "string" && ADDR.test(a);
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const HUB_ABI = [
  "function openSeat(address attester, bytes attesterSig, bytes enodePubkey, bytes enodeSig) payable returns (uint256 seatId)",
  "function allowlistOnly() view returns (bool)",
  "function allowlisted(address) view returns (bool)",
  "function denied(address) view returns (bool)",
  "function seatsPaused() view returns (bool)",
  "function maxSeats() view returns (uint256)",
  "function occupiedSeats() view returns (uint256)",
  "function seatCount() view returns (uint256)",
  "function rewardPool() view returns (uint256)",
  "function currentRewardPerAttest() view returns (uint256)",
  "function deployBlock() view returns (uint256)",
  "function owner() view returns (address)",
  "function keyInfo(address key) view returns (tuple(uint64 seatId, uint8 role, bool active))",
  "function participation(uint256 seatId, uint256 n) view returns (uint256)",
  "event SeatOpened(uint256 indexed seatId, address indexed owner, address indexed attester, uint256 activationBlock, uint256 eligibleBlock)",
  "error WrongDeposit()", "error Denied()", "error NotAllowlisted()", "error SeatsFull()", "error Paused()", "error BadKey()",
  "error KeyUsed()", "error BadPossession()", "error BadEnode()", "error Reentrancy()", "error ZeroAddress()", "error BadStatus()",
] as const;

export const LENS_ABI = [
  // ValidatorHub.Seat, in declaration order (ABI tuples are positional)
  "function seat(uint256 seatId) view returns (tuple(uint96 claimable, uint32 lastAttestedCp, uint32 dutyStartCp, uint40 activationBlock, uint40 countedSince, uint8 status, bool jailed, address owner, uint40 unjailBlock, uint40 unbondEndBlock, uint8 slashState, bool qualified, address attester, uint96 deposit, address pendingAttester, uint40 attesterRotateBlock, address signingKey, address rewardTo))",
  // reason: 0 open, 1 new seats paused, 2 on the deny list, 3 not invited (the pilot), 4 every seat taken
  "function seatAccess(address wallet) view returns (tuple(uint8 reason, bool allowlistOnly, bool allowlisted, bool denied, bool seatsPaused, uint256 occupiedSeats, uint256 maxSeats))",
  "function runwayDays() view returns (uint256)",
] as const;

export const hubIface = new Interface(HUB_ABI as unknown as string[]);
export const lensIface = new Interface(LENS_ABI as unknown as string[]);

/* ------------------------------------------------------------------ where the hub is */

export interface PilotHub { hub: string; lens: string; deployBlock: number; source: "env" | "record" }

/**
 * The hub the page talks to: VITE_VALIDATOR_HUB + VITE_VALIDATOR_HUB_LENS (a test or local build), else the
 * record pilot.sh writes (agents/deployments-validators.3961.json, chain 3961 only), else none: the page then
 * says the pilot opens soon. VITE_VALIDATOR_HUB=off forces "none" even when a record exists.
 */
export function pickHub(env: { hub?: string; lens?: string; deployBlock?: string }, record: unknown): PilotHub | null {
  if ((env.hub ?? "").trim().toLowerCase() === "off") return null;
  if (isAddr(env.hub) && isAddr(env.lens)) {
    return { hub: getAddress(env.hub), lens: getAddress(env.lens), deployBlock: Math.max(0, Number(env.deployBlock) || 0), source: "env" };
  }
  const r = record as { chainId?: unknown; validatorHub?: unknown; validatorHubLens?: unknown; deployBlock?: unknown } | null | undefined;
  if (r && Number(r.chainId) === CHAIN_ID && isAddr(r.validatorHub) && isAddr(r.validatorHubLens)) {
    return { hub: getAddress(r.validatorHub), lens: getAddress(r.validatorHubLens), deployBlock: Math.max(0, Number(r.deployBlock) || 0), source: "record" };
  }
  return null;
}

/* ------------------------------------------------------------------ the seat proof */

/** What `fmx-validator seat-proof --owner <wallet>` prints (as text, or as JSON with --json). */
export interface SeatProof {
  attester: string;
  attesterSig: string;
  enodePubkey: string;
  enodeSig: string;
  /** Present when the paste names them (both output formats do). */
  hub: string | null;
  owner: string | null;
  chainId: number | null;
}

/**
 * The first `len` hex digits after `label`. A console can wrap a long line in the middle of a value, and the
 * next label may start with hex letters, so whitespace inside the value is dropped and exactly `len` digits
 * are taken; the signatures are verified afterwards, so a mangled paste cannot slip through.
 */
function hexAfter(text: string, label: string, len: number, quoted = false): string | null {
  const q = quoted ? '"' : '"?';
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${q}${label}${q}\\s*[:=]?\\s*"?0x([0-9a-fA-F][0-9a-fA-F\\s]*)`, "g");
  for (const m of text.matchAll(re)) {
    const hex = m[1].replace(/\s+/g, "");
    if (hex.length >= len) return `0x${hex.slice(0, len).toLowerCase()}`;
  }
  return null;
}

/** The whole seat-proof output, text or JSON, pasted as it is. */
export function parseSeatProof(raw: string): { ok: true; proof: SeatProof } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Paste what seat-proof printed." };
  let attester = hexAfter(text, "attester", 40);
  let attesterSig = hexAfter(text, "attesterSig", 130);
  let enodePubkey = hexAfter(text, "enodePubkey", 128);
  let enodeSig = hexAfter(text, "enodeSig", 130);
  if (!(attester && attesterSig && enodePubkey && enodeSig)) {
    // the ready-made calldata carries all four (openSeat's encoding has a fixed length: 484 bytes)
    const data = hexAfter(text, "calldata", 968) ?? hexAfter(text, "data", 968);
    if (data) {
      try {
        const d = hubIface.decodeFunctionData("openSeat", data);
        attester = String(d[0]).toLowerCase(); attesterSig = String(d[1]); enodePubkey = String(d[2]); enodeSig = String(d[3]);
      } catch { /* not openSeat calldata */ }
    }
  }
  if (!(attester && attesterSig && enodePubkey && enodeSig)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
      return { ok: false, error: "That is only an address. Paste everything seat-proof printed: the page also needs the two signatures that prove the attester key and the node are yours." };
    }
    const missing = [!attester && "attester", !attesterSig && "attesterSig", !enodePubkey && "enodePubkey", !enodeSig && "enodeSig"].filter(Boolean).join(", ");
    return { ok: false, error: `This does not look like the whole seat-proof output (missing: ${missing}). Copy everything it printed, from "Checked on the hub" to the end, or run it with --json and paste that.` };
  }
  // JSON names them "hub" and "owner"; the text says "to 0x… (ValidatorHub, chain 3961)" and "from the owner
  // wallet 0x…". A bare "hub" label is not used: the text's first line is "Checked on the hub: <owner>".
  const hub = hexAfter(text, "hub", 40, true) ?? hexAfter(text, "to", 40);
  const owner = hexAfter(text, "owner", 40, true) ?? hexAfter(text, "owner wallet", 40);
  const cid = /"chainId"\s*:\s*(\d[\d\s]*)/.exec(text) ?? /\(ValidatorHub,\s*chain\s+(\d[\d\s]*)\)/.exec(text);
  return {
    ok: true,
    proof: {
      attester: getAddress(attester), attesterSig, enodePubkey, enodeSig,
      hub: hub ? getAddress(hub) : null,
      owner: owner ? getAddress(owner) : null,
      chainId: cid ? Number(cid[1].replace(/\s+/g, "")) : null,
    },
  };
}

/** ValidatorHub.attesterKeyDigest: typed data AttesterKey(address owner,address attester) in the hub's domain. */
export function attesterKeyDigest(hub: string, owner: string, attester: string, chainId = CHAIN_ID): string {
  return TypedDataEncoder.hash(
    { name: HUB_NAME, version: HUB_VERSION, chainId, verifyingContract: hub },
    { AttesterKey: [{ name: "owner", type: "address" }, { name: "attester", type: "address" }] },
    { owner, attester },
  );
}

/** ValidatorHub.enodeDigest: keccak256(abi.encodePacked("FMX_VALIDATOR_NODE_V1", chainid, hub, owner, attester)). */
export function enodeDigest(hub: string, owner: string, attester: string, chainId = CHAIN_ID): string {
  return solidityPackedKeccak256(["string", "uint256", "address", "address", "address"], [ENODE_TAG, chainId, hub, owner, attester]);
}

export interface CheckedProof { attester: string; nodeAddress: string; enodePubkey: string; attesterSig: string; enodeSig: string }

/**
 * Everything openSeat will check about the proof itself, checked here first so a wrong paste costs nothing:
 * it was made for this contract, this network and this owner wallet, the attester key signed
 * AttesterKey(owner, attester), and the node key behind enodePubkey signed the enode digest.
 */
export function checkSeatProof(p: SeatProof, ctx: { hub: string; owner: string; chainId?: number }): { ok: true; checked: CheckedProof } | { ok: false; error: string } {
  const chainId = ctx.chainId ?? CHAIN_ID;
  if (p.chainId !== null && p.chainId !== chainId) {
    return { ok: false, error: `This proof was made for chain ${p.chainId}, not Ferminux (${chainId}). Run the validator app with --network mainnet.` };
  }
  if (p.hub && !same(p.hub, ctx.hub)) {
    return { ok: false, error: `This proof was made for the contract ${p.hub}, not the pilot's ValidatorHub ${ctx.hub}. Set the hub address in the validator app (fmx-validator init --hub ${ctx.hub}) and run seat-proof again.` };
  }
  if (p.owner && !same(p.owner, ctx.owner)) {
    return { ok: false, error: `This proof was made for the wallet ${p.owner}, but the connected wallet is ${getAddress(ctx.owner)}. Run seat-proof again with --owner ${getAddress(ctx.owner)}, or connect the wallet it names.` };
  }
  if (same(p.attester, ctx.owner)) {
    return { ok: false, error: "The attester key is the same as the wallet that owns the seat. The seat needs a separate hot key on the validator computer: create one there with the validator app." };
  }
  let signedBy: string;
  try { signedBy = SigningKey.recoverPublicKey(attesterKeyDigest(ctx.hub, ctx.owner, p.attester, chainId), p.attesterSig); } catch { signedBy = ""; }
  if (!signedBy || !same(computeAddress(signedBy), p.attester)) {
    return { ok: false, error: `The attester signature does not match this wallet, this contract and this network. Run seat-proof again with --owner ${getAddress(ctx.owner)} and paste its whole output.` };
  }
  let nodeKey: string;
  try { nodeKey = SigningKey.recoverPublicKey(enodeDigest(ctx.hub, ctx.owner, p.attester, chainId), p.enodeSig); } catch { nodeKey = ""; }
  if (!nodeKey || nodeKey.toLowerCase() !== `0x04${p.enodePubkey.slice(2).toLowerCase()}`) {
    return { ok: false, error: "The node signature does not match the node key in the proof. Run seat-proof again on the validator computer and paste its whole output." };
  }
  return { ok: true, checked: { attester: getAddress(p.attester), nodeAddress: computeAddress(nodeKey), enodePubkey: p.enodePubkey, attesterSig: p.attesterSig, enodeSig: p.enodeSig } };
}

/* ------------------------------------------------------------------ who may open a seat */

export const ACCESS_REASONS = ["open", "paused", "denied", "not-invited", "full"] as const;
export type AccessReason = (typeof ACCESS_REASONS)[number];
export interface SeatAccess { reason: AccessReason; allowlistOnly: boolean; allowlisted: boolean; denied: boolean; seatsPaused: boolean; occupied: number; max: number }

export function toSeatAccess(r: Result | readonly unknown[]): SeatAccess {
  const n = Number(r[0]);
  return {
    reason: ACCESS_REASONS[n] ?? "paused",
    allowlistOnly: Boolean(r[1]), allowlisted: Boolean(r[2]), denied: Boolean(r[3]), seatsPaused: Boolean(r[4]),
    occupied: Number(r[5]), max: Number(r[6]),
  };
}

/** A custom error from openSeat (or its simulation), in plain words. */
export const REVERT_TEXT: Record<string, string> = {
  WrongDeposit: "The deposit must be exactly 2,000 FMX.",
  Denied: "This wallet is on the hub's deny list: the genesis premine wallets, the foundation multisig and the reward sink cannot hold a seat.",
  NotAllowlisted: "This wallet is not invited to the pilot.",
  SeatsFull: "Every seat is taken.",
  Paused: "New seats are paused right now.",
  BadKey: "The attester key must be a different key from the wallet that owns the seat.",
  KeyUsed: "This attester key already belongs to a seat, and a key is bound to one seat for ever. Create a new key in the validator app for another seat.",
  BadPossession: "A signature in the seat proof does not match this wallet, this contract or this network. Run seat-proof again with --owner set to this wallet.",
  BadEnode: "The node key in the seat proof is not a 64-byte public key.",
};

/** The name of the hub error in revert data (0x-hex), or null. */
export function revertName(data: unknown): string | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  try { return hubIface.parseError(data)?.name ?? null; } catch { return null; }
}

/* ------------------------------------------------------------------ a seat's state */

export interface SeatView {
  id: number;
  claimable: bigint;
  lastAttestedCp: number;
  activationBlock: number;
  countedSince: number;
  status: number; // 0 none, 1 bonded, 2 exiting, 3 withdrawn
  jailed: boolean;
  owner: string;
  unjailBlock: number;
  unbondEndBlock: number;
  slashState: number; // 0 none, 1 pending, 2 executed
  attester: string;
  deposit: bigint;
}

export function toSeatView(id: number, s: Result | readonly unknown[]): SeatView {
  return {
    id,
    claimable: BigInt(s[0] as bigint), lastAttestedCp: Number(s[1]), activationBlock: Number(s[3]), countedSince: Number(s[4]),
    status: Number(s[5]), jailed: Boolean(s[6]), owner: getAddress(String(s[7])), unjailBlock: Number(s[8]), unbondEndBlock: Number(s[9]),
    slashState: Number(s[10]), attester: getAddress(String(s[12])), deposit: BigInt(s[13] as bigint),
  };
}

/** Blocks → "about 23 h" (7 s a block; the signers never go faster, so this is a lower bound). */
export function aboutBlocks(blocks: number): string {
  const s = Math.max(0, blocks) * BLOCK_SECONDS;
  if (s < 90) return "about a minute";
  if (s < 3600) return `about ${Math.round(s / 60)} minutes`;
  if (s < 2 * 86400) { const h = Math.round(s / 3600); return `about ${h} hour${h === 1 ? "" : "s"}`; }
  return `about ${Math.round(s / 86400)} days`;
}

export type SeatTone = "ok" | "accent" | "warn" | "info" | "";
export interface SeatPhase { key: "starting" | "active" | "silent" | "attesting" | "paused" | "leaving" | "withdrawable" | "closed" | "none"; label: string; tone: SeatTone; detail: string }

const fmtInt = (n: number) => n.toLocaleString("en-US");

/** What a seat is doing at block `head`, in the words the page shows. */
export function seatPhase(s: SeatView, head: number): SeatPhase {
  const slash = s.slashState === 1 ? " A double-signing report against this seat is pending; the deposit cannot be withdrawn until it is settled."
    : s.slashState === 2 ? " 200 FMX of the deposit was taken for double signing." : "";
  if (s.status === 0) return { key: "none", label: "Not found", tone: "", detail: "The hub has no such seat." };
  if (s.status === 3) return { key: "closed", label: "Closed", tone: "", detail: `The deposit was withdrawn.${slash}` };
  if (s.status === 2) {
    if (head >= s.unbondEndBlock && s.slashState !== 1) return { key: "withdrawable", label: "Ready to withdraw", tone: "accent", detail: `The 14-day unbonding is over: the owner wallet can withdraw the deposit now.${slash}` };
    return { key: "leaving", label: "Leaving", tone: "info", detail: `Rewards have stopped. The deposit can be withdrawn from block ${fmtInt(s.unbondEndBlock)}, in ${aboutBlocks(s.unbondEndBlock - head)}.${slash}` };
  }
  if (s.jailed) {
    const when = head >= s.unjailBlock ? "The owner wallet can resume it now (unjail)." : `The owner wallet can resume it from block ${fmtInt(s.unjailBlock)}, in ${aboutBlocks(s.unjailBlock - head)}.`;
    return { key: "paused", label: "Paused", tone: "warn", detail: `Paused for low participation: fewer than half of its last ${JAIL_WINDOW} checkpoints were signed. Downtime never costs the deposit. ${when}${slash}` };
  }
  if (head < s.activationBlock) {
    return { key: "starting", label: "Starting", tone: "info", detail: `Starts at block ${fmtInt(s.activationBlock)}, in ${aboutBlocks(s.activationBlock - head)}. Keep the validator app running so its node is in sync by then.${slash}` };
  }
  const counted = s.countedSince > 0
    ? ` Counted toward certification since block ${fmtInt(s.countedSince)}.`
    : head < s.activationBlock + ELIGIBILITY_DELAY
      ? ` Counts toward certification from block ${fmtInt(s.activationBlock + ELIGIBILITY_DELAY)}, in ${aboutBlocks(s.activationBlock + ELIGIBILITY_DELAY - head)}.`
      : "";
  if (s.lastAttestedCp === 0) {
    // the first checkpoint after activation closes within 200 + 250 blocks; well past that, say so
    if (head - s.activationBlock > 3 * CHECKPOINT_INTERVAL + 250) {
      return { key: "silent", label: "No checkpoints yet", tone: "warn", detail: `Started at block ${fmtInt(s.activationBlock)}, ${aboutBlocks(head - s.activationBlock)} ago, and has not signed a checkpoint. Check that the validator app is running and in sync (fmx-validator status).${counted}${slash}` };
    }
    return { key: "active", label: "Started", tone: "ok", detail: `Started at block ${fmtInt(s.activationBlock)}. Its first checkpoint comes within about 23 minutes (every 200 blocks).${counted}${slash}` };
  }
  const h = s.lastAttestedCp * CHECKPOINT_INTERVAL;
  return { key: "attesting", label: "Attesting", tone: "ok", detail: `Last checkpoint signed: block ${fmtInt(h)}, ${aboutBlocks(head - h)} ago.${counted}${slash}` };
}

/* ------------------------------------------------------------------ the downloads */

export const DOWNLOAD_BASE = "/downloads/validator-pilot/";
export const PACKAGES = [
  { file: "ferminux-validator-windows-amd64.zip", label: "Windows 10 or 11", sub: "64-bit, zip", os: "windows" },
  { file: "ferminux-validator-linux-amd64.tar.gz", label: "Linux, x86-64", sub: "tar.gz", os: "linux" },
  { file: "ferminux-validator-linux-arm64.tar.gz", label: "Linux, ARM64", sub: "tar.gz", os: "linux" },
] as const;

/** SHA256SUMS (sha256sum format: "<64 hex>  <name>", or " *<name>" in binary mode) → name → lowercase hash. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}
