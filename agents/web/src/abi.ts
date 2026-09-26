// Contract ABIs. Every ABI is the compiled artifact from ../contracts/abi/*.json, copied into
// src/abi.generated.ts by scripts/gen-config.mjs at build time — so function/event/error shapes
// (including `indexed` params and custom errors) always match what is deployed. The earlier
// hand-written fragments drifted from the built contracts (StreamPay getters/events, indexed params
// on AgentAccount/TokenFactory events) and could not decode custom-error reverts.
import type { JsonFragment } from "ethers";
import * as G from "./abi.generated";

export type Abi = JsonFragment[];

export const REGISTRY_ABI: Abi = G.AgentRegistryAbi;
export const ESCROW_ABI: Abi = G.ServiceEscrowAbi;
// Ferminux Agents — FRC-721 one-of-ones (FMXA). mint(tokenId) must be sent with msg.value == price().
export const NFT_ABI: Abi = G.FerminuxAgentsAbi;
// Ferminux Citizens — FRC-721 one-of-ones (FMXC). mint(tokenId) must be sent with msg.value == price(tokenId).
export const CITIZENS_ABI: Abi = G.FerminuxCitizensAbi;

export const AgentStatus = { None: 0, Active: 1, Paused: 2, Retired: 3 } as const;
export const AgentStatusName = ["None", "Active", "Paused", "Retired"] as const;
export const JobStatus = { None: 0, Open: 1, Delivered: 2, Completed: 3, Refunded: 4, Disputed: 5, Resolved: 6 } as const;
export const JobStatusName = ["None", "Open", "Delivered", "Completed", "Refunded", "Disputed", "Resolved"] as const;

/* ==================================================================== *
 * Addendum v3 — Agent Economy
 * ==================================================================== */

// C1 — X402Vault: pay-per-request in native FMX via off-chain EIP-712 vouchers.
export const X402_VAULT_ABI: Abi = G.X402VaultAbi;
// EIP-712 typed-data types for a Voucher (domain built per-page from config.x402Vault + chainId).
export const X402_VOUCHER_TYPES: Record<string, { name: string; type: string }[]> = {
  Voucher: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "ref", type: "bytes32" },
  ],
};

// C2 — AgentAccount (EIP-1167 clone) + AgentAccountFactory: policy wallets with session keys.
export const AGENT_ACCOUNT_ABI: Abi = G.AgentAccountAbi;
export const AGENT_ACCOUNT_FACTORY_ABI: Abi = G.AgentAccountFactoryAbi;

// C3 — StreamPay: per-second streams + subscription plans (getStream/getPlan/getSub, not public mappings).
export const STREAM_PAY_ABI: Abi = G.StreamPayAbi;

// C4 — ArbiterPool: disputes for ServiceEscrow.
export const ARBITER_POOL_ABI: Abi = G.ArbiterPoolAbi;

// C5 — ERC-8004 adapters over AgentRegistry (external interop standard; keeps its name).
export const IDENTITY_8004_ABI: Abi = G.IdentityRegistry8004Abi;
export const REPUTATION_8004_ABI: Abi = G.ReputationRegistry8004Abi;
export const VALIDATION_8004_ABI: Abi = G.ValidationRegistry8004Abi;

// C6 — AgentTokenFactory: one bonding-curve FRC-20 per agent; AgentToken is the token itself.
export const TOKEN_FACTORY_ABI: Abi = G.AgentTokenFactoryAbi;
export const AGENT_TOKEN_ABI: Abi = G.AgentTokenAbi;

export const CaseResultName = (bps: number) => bps >= 5000 ? "mostly agent" : "mostly client";

/** Plain-language text for the custom errors the contracts revert with (name → message). */
export const CUSTOM_ERROR_TEXT: Record<string, string | ((args: unknown[]) => string)> = {
  // shared
  ZeroValue: "The amount must be greater than zero.",
  ZeroAddress: "That address is empty (0x0).",
  NotGovernance: "Only governance can do that.",
  NotOwner: "You are not the owner.",
  NothingToWithdraw: "There is nothing to withdraw for this address.",
  NothingToClaim: "Nothing has accrued to claim yet.",
  TransferFailed: "The FMX transfer failed.",
  Reentrancy: "The contract is busy; try again.",
  StringTooLong: "One of the text fields is longer than the contract allows.",
  // registry / escrow
  InsufficientBond: (a) => `The bond is below the minimum (sent ${a[0]}, minimum ${a[1]} wei).`,
  InvalidName: "The name must be 1–64 bytes.",
  UnknownAgent: "No agent with that id.",
  NotAgentOwner: "Only the agent's owner can do that.",
  AgentNotActive: "That agent is not active and cannot take jobs.",
  CannotHireOwnAgent: "You cannot hire your own agent.",
  InsufficientPayment: "The payment is below the agent's price.",
  WrongStatus: "The job is not in the right state for that action.",
  TooEarly: "Too early — the waiting period has not passed yet.",
  TooLate: "Too late — the window for that action has closed.",
  InvalidRating: "The rating must be 1–5.",
  CooldownActive: "The cooldown has not passed yet.",
  NotRetired: "The agent must be retired first.",
  // x402 vault
  Locked: "Request an unlock first, then wait for it to pass.",
  InsufficientBalance: "The vault balance is lower than that amount.",
  VoucherInvalid: (a) => `The voucher is invalid${a[0] ? `: ${a[0]}` : ""}.`,
  // streams
  SelfPayment: "You cannot open a stream or subscription to your own address.",
  ZeroRate: "The rate (or period) must be greater than zero.",
  InsufficientDeposit: "The deposit must cover at least one second at that rate.",
  WrongPayment: "The FMX sent does not match the plan price times the number of periods.",
  PlanInactive: "That plan is paused and is not taking new subscribers.",
  AlreadySubscribed: "This wallet already has an active subscription to that plan — renew it instead.",
  UnknownPlan: "No plan with that id.", UnknownStream: "No stream with that id.", UnknownSub: "No subscription with that id.",
  NotPayee: "Only the payee can claim.", NotPayer: "Only the payer can do that.", NotParty: "Only the payer or the payee can do that.",
  StreamAlreadyCancelled: "That stream is already cancelled.", StreamEnded: "That stream has ended.",
  SubAlreadyCancelled: "That subscription is already cancelled.", ZeroPeriods: "Subscribe for at least one period.",
  // arbiter pool
  BelowMinStake: "Your total stake would be below the pool's minimum.",
  NotArbiter: "Only staked arbiters can vote.", AlreadyVoted: "You already voted on this case.",
  ConflictOfInterest: "You are a party to this case and cannot vote on it.",
  VotingClosed: "Voting on this case has closed.", CaseClosedAlready: "This case is already closed.",
  NotClosable: "The case cannot be closed yet — the voting window is open and quorum+2 have not voted.",
  VotesPending: "You have votes pending on open cases; wait for them to close before leaving.",
  Leaving: "This address is already leaving the pool.", JobNotDisputed: "That job is not disputed.",
  WrongFee: "The case fee sent is wrong.", CaseExists: "That job already has a case.", UnknownCase: "No case with that id.",
  InvalidBps: "The share must be between 0 and 100%.",
  // token factory / token
  AlreadyLaunched: "This agent already has a token.", InvalidSymbol: "The symbol must be 1–11 characters.",
  InvalidCurve: "Base and slope cannot both be zero (and must be below the maximum).",
  Slippage: "The price moved more than the slippage allowance — try again.",
  UnknownToken: "That token was not launched by this factory.",
  InsufficientAllowance: "Token allowance is too low.", NoSupply: "The token has no supply yet.", NotFactory: "Only the factory can do that.",
  // agent account
  AlreadyInitialized: "This account is already initialised.", BadSignature: "The signature is invalid.",
  CallFailed: "The forwarded call reverted.", CapExceeded: "That would exceed the session key's daily cap.",
  Expired: "The deadline has passed.", NotAuthorized: "That key is not authorised on this account.",
  SessionExpired: "The session key has expired.", TargetNotAllowed: "The session key may not call that target.",
  LengthMismatch: "Array lengths do not match.",
  // 8004
  ClientAddressesRequired: "No feedback clients to summarise yet.",
  // Ferminux Agents (FMXA). Its WrongPayment (value != price()) shares the streams text above; /nfts/ re-reads
  // price() after a failed mint and says so when it moved.
  AlreadyMinted: "That token has already been minted. Each id exists exactly once.",
  BadId: "There is no token with that id in this collection, or it has not been minted yet.",
  Minted: "That token has already been minted. Each id exists exactly once.",
  Paused: "Minting is paused by the contract right now.",
  WrongPrice: "The FMX sent does not match this token's price. The price may have just changed; reload and try again.",
  NotForSale: "This tier is not for sale through the contract.",
  SalePaused: "Minting is paused by the contract right now.",
  UnsafeRecipient: "The receiving contract does not accept FRC-721 tokens.",
};
