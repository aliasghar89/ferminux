/* Config for the validators lane (Step 1, checkpoint attestation — no consensus change; source of truth
   scratchpad/validators/PLAN.md, read-only there). Every surface this lane owns (the nav link, /validators,
   the block-page certified badge, seat pages) is driven off two values: HUB_ADDRESS and LENS_ADDRESS. Until
   the contracts and deploy lanes set both, this whole feature is dark and the app is byte-for-byte what it
   was before. VITE_VALIDATOR_HUB / VITE_VALIDATOR_HUB_LENS let a local build or the Playwright smoke turn
   it on against a mocked pair without ever touching the checked-in address book (the same pattern as
   VITE_RPC in rpc.ts).
   Two addresses, not one: ValidatorHub.sol holds the deposits, checkpoints and the Step 2 consensus-read
   slots, but keeps `_seats` internal to stay under the 24 KB code-size limit — a seat's own detail (owner,
   attester, bond, jail state, rewards) is read through the separate, immutable ValidatorHubLens.sol, which
   decodes the hub's storage via its `extsload()`. Confirmed against agents/contracts/src/validators/
   {ValidatorHub,ValidatorHubLens}.sol as they stood on 2026-09-25 — see abi.ts's own sync note. */
import book from "../data/contracts.3961.json";

const typedBook = book as { validatorHub?: string | null; validatorHubLens?: string | null };
export const HUB_ADDRESS: string | null = (import.meta.env.VITE_VALIDATOR_HUB as string | undefined) || (typedBook.validatorHub ?? null);
export const LENS_ADDRESS: string | null = (import.meta.env.VITE_VALIDATOR_HUB_LENS as string | undefined) || (typedBook.validatorHubLens ?? null);
export const VALIDATORS_ENABLED = HUB_ADDRESS !== null && LENS_ADDRESS !== null;

/** ValidatorHub.sol CHECKPOINT_INTERVAL: "Every 200 blocks the node's attester key signs …". */
export const CHECKPOINT_INTERVAL = 200;
/** ValidatorHub.sol SEAT_DEPOSIT = 2_000 ether. */
export const SEAT_DEPOSIT_FMX = 2000;
/** ValidatorHub.sol INCLUSION_DELAY / INCLUSION_END: block.number ∈ [h+64, h+250]. */
export const INCLUSION_WINDOW = { from: 64, to: 250 };
/** ValidatorHub.sol INITIAL_REWARD_PER_ATTEST, halving at block 4,500,000 or at V (currentRewardPerAttest()). */
export const REWARD_PER_ATTEST_FMX = 0.025;
export const HALVING_BLOCK = 4_500_000;
/** ValidatorHub.sol MIN_ELIGIBLE_FOR_CERT / MIN_CERT_ATTESTATIONS (certifies(), line ~707). */
export const MIN_ELIGIBLE_FOR_CERTIFIED = 30;
export const MIN_COUNT_FLOOR = 20;
/** ValidatorHub.sol MAX_PARTICIPATION_WINDOW: participation(seatId, n) accepts n <= 511. */
export const MAX_PARTICIPATION_WINDOW = 511;

/** A checkpoint height, or false when the feature is off (cheap: no ethers, safe to import statically from
 *  a hot page like block.ts). The read itself (validators/client.ts) is a dynamic import from there. */
export const isCheckpointHeight = (n: number): boolean => VALIDATORS_ENABLED && n > 0 && n % CHECKPOINT_INTERVAL === 0;
