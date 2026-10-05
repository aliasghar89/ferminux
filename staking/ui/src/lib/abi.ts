// Human-readable ABI fragments for the exact contracts in ../../contracts/src
// (FMXStaking.sol, NodeRegistry.sol). Only what this app calls is listed — an
// ABI entry that is never used is an entry that can silently rot.
// tests/abi.test.mjs checks every fragment against the compiled
// ../../contracts/abi/*.json, and the e2e checks those files against a fresh
// `forge build`, so none of the three copies can drift.
// No browser globals: this module is imported by the Node test suites.

/** FMXStaking — src/FMXStaking.sol. `tier` is the contract's Tier enum (uint8). */
export const FMX_STAKING_ABI = [
  // --- constants (fixed in bytecode; read once per vault, see lib/staking.ts)
  'function COOLDOWN() view returns (uint256)',
  'function LOCK_90() view returns (uint256)',
  'function LOCK_180() view returns (uint256)',
  'function VALIDATOR_LOCK_BLOCK() view returns (uint256)',
  'function MIN_VALIDATOR_STAKE() view returns (uint256)',
  'function EARLY_EXIT_PENALTY_BPS() view returns (uint256)',
  'function tierWeight(uint8 tier, bool boosted) pure returns (uint256)',
  // --- vault state
  'function paused() view returns (bool)',
  'function dripPerYear() view returns (uint256)',
  'function rewardPool() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function totalUnits() view returns (uint256)',
  'function lastAccrual() view returns (uint256)',
  'function positionCount() view returns (uint256)',
  'function denied(address account) view returns (bool)',
  // --- positions
  'function positionsOf(address account) view returns (uint256[])',
  'function getPosition(uint256 positionId) view returns (tuple(address owner, uint8 tier, uint8 state, bool boosted, uint64 startTime, uint64 lockEnd, uint64 cooldownEnd, uint128 amount, uint128 units, uint256 rewardDebt, uint256 banked))',
  'function pendingRewards(uint256 positionId) view returns (uint256)',
  // --- actions
  'function stake(uint8 tier) payable returns (uint256 positionId)',
  'function requestUnstake(uint256 positionId)',
  'function withdraw(uint256 positionId)',
  'function claim(uint256 positionId) returns (uint256 amount)',
  'function emergencyExit(uint256 positionId)',
] as const;

/** NodeRegistry — src/NodeRegistry.sol */
export const NODE_REGISTRY_ABI = [
  'function minBond() view returns (uint256)',
  'function BOOST_THRESHOLD_BPS() view returns (uint256)',
  'function DISPUTE_WINDOW() view returns (uint256)',
  'function listActiveNodes() view returns (tuple(uint256 nodeId, address operator, address consensusAddr, address nodeAddress, uint256 stake, bool boosted, uint64 lastSeen, uint16 lastUptimeBps)[])',
  'function nodeIdByPosition(uint256 positionId) view returns (uint256)',
  'function getNode(uint256 nodeId) view returns (tuple(address operator, address consensusAddr, address nodeAddress, uint64 registeredAt, uint64 lastSeen, uint16 lastUptimeBps, bool active, uint256 positionId))',
  'function registerNode(bytes pubkey, address consensusAddr, uint256 positionId, uint8 v, bytes32 r, bytes32 s) returns (uint256 nodeId)',
  'function deregisterNode(uint256 nodeId)',
] as const;
