/* ValidatorHub / ValidatorHubLens ABI, the read-only slice this lane needs (Step 1: checkpoint attestation,
   no consensus change). Confirmed against the source in agents/contracts/src/validators/ as it stood on
   2026-09-25:
     ValidatorHub.sol      seatCount, eligibleCount, checkpoint(), isCertified(), certifies(), attested(),
                            participation() — all public/external view or pure, all read directly.
     ValidatorHubLens.sol  seat() — the hub keeps `_seats` internal (24 KB code-size limit) and exposes it
                            only through this separate, immutable, storage-only reader.
   AGENTS.md's "What NOT to touch" (deployed contract addresses, wire identifiers) is about the live,
   deployed contracts once they exist; nothing here is that — it is this lane's own read of their source.

   Kept in sync by scripts/validators-abi.test.mjs (npm run test:validators-abi, after `forge build` in
   agents/contracts): every fragment below is compared with the compiled contracts by selector, mutability,
   output types and tuple field names (ABI struct encoding is positional, so a reordered field would otherwise
   decode silently wrong), and config.ts's constants with ValidatorHub.sol's. Every caller in client.ts also
   dashes a selector mismatch on its own (see `read()`), so a stale fragment fails safe. */
import { Interface } from "ethers";

export const VALIDATOR_HUB_ABI = [
  "function seatCount() view returns (uint256)",
  "function eligibleCount() view returns (uint256)",
  // Checkpoint (ValidatorHub.sol ~l.93): blockHash, count (eligible-at-snapshot attestations), eligible
  // (snapshotted at the first accepted attestation), total (all attestations, including not-yet-eligible
  // seats), snapshotBlock, certified (set on-chain by certifies(count, eligible), never recomputed here).
  "function checkpoint(uint256 height) view returns (tuple(bytes32 blockHash, uint32 count, uint32 eligible, uint32 total, uint40 snapshotBlock, bool certified))",
  "function isCertified(uint256 height, bytes32 blockHash) view returns (bool)",
  // certifies() is `pure`: eligible >= 30 and count >= max(20, ceil(2/3 x eligible)). Exposed for a
  // client-side cross-check; checkpoint().certified is the primary source (§ "recent checkpoints").
  "function certifies(uint256 count, uint256 eligible) pure returns (bool)",
  "function attested(uint256 seatId, uint256 height) view returns (bool)",
  "function participation(uint256 seatId, uint256 n) view returns (uint256)",
  // The invite-only pilot (owner decision 2026-09-26): maxSeats is 20 from the deploy, and allowlistOnly is
  // cleared once, for good, through the 48 h timelock. A hub built before the pilot has neither
  // allowlistOnly() nor allowlisted(): client.ts reads that as open, never as an error.
  "function maxSeats() view returns (uint256)",
  "function occupiedSeats() view returns (uint256)",
  "function allowlistOnly() view returns (bool)",
  "function allowlisted(address wallet) view returns (bool)",
] as const;

export const VALIDATOR_HUB_LENS_ABI = [
  // Seat (ValidatorHub.sol ~l.61), tuple order = declaration order (ABI struct encoding is positional):
  // claimable, lastAttestedCp, dutyStartCp, activationBlock, countedSince, status (NONE/BONDED/EXITING/
  // WITHDRAWN — jailed is a separate flag, not a status value), jailed, owner, unjailBlock, unbondEndBlock,
  // slashState, qualified (Step 2), attester, deposit (2,000 FMX, or 1,800 after a slash), pendingAttester,
  // attesterRotateBlock, signingKey (Step 2), rewardTo (Step 2).
  "function seat(uint256 seatId) view returns (tuple(uint96 claimable, uint32 lastAttestedCp, uint32 dutyStartCp, uint40 activationBlock, uint40 countedSince, uint8 status, bool jailed, address owner, uint40 unjailBlock, uint40 unbondEndBlock, uint8 slashState, bool qualified, address attester, uint96 deposit, address pendingAttester, uint40 attesterRotateBlock, address signingKey, address rewardTo))",
  "function runwayDays() view returns (uint256)",
  // SeatAccess (ValidatorHubLens.sol): can `wallet` open a seat now, in openSeat's own order. reason: 0 open,
  // 1 new seats paused, 2 on the deny list, 3 not invited (the pilot), 4 every seat taken.
  "function seatAccess(address wallet) view returns (tuple(uint8 reason, bool allowlistOnly, bool allowlisted, bool denied, bool seatsPaused, uint256 occupiedSeats, uint256 maxSeats))",
] as const;

export const hub = new Interface(VALIDATOR_HUB_ABI);
export const lens = new Interface(VALIDATOR_HUB_LENS_ABI);

/** Seat.status (ValidatorHub.sol NONE/BONDED/EXITING/WITHDRAWN = 0..3). `jailed` and "pending activation"
 *  (before Seat.activationBlock) are read from the other fields, not this enum — see client.ts's seatLabel. */
export const SEAT_RAW_STATUS = ["None", "Bonded", "Exiting", "Withdrawn"] as const;
