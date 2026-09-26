/* The static public address book (src/data/contracts.3961.json) as lookup maps. No imports besides the
   JSON, so the API boundary, the name book and the router can all use it without cycles. */
import book from "./data/contracts.3961.json";

export const POSA_BLOCK = book.posaBlock;   // 160,000: first block confirmed by signers
export const CHAIN_ID = book.chainId;       // 3961

export type ContractKind = "contract" | "token" | "impl";
/** mintUrl (optional, NFT collections anyone can mint from): the mint page for one id, with "{id}" in it. */
export interface KnownContract { address: string; name: string; short?: string; long?: string; section: string; kind: ContractKind; abi?: string; deployBlock?: number; mintUrl?: string }

export const CONTRACTS = book.contracts as KnownContract[];
export const ACCOUNTS = book.accounts as { address: string; name: string }[];
export const SIGNER_SEED = book.signers as { n: number; address: string }[];
export const SECTIONS = book.sections as Record<string, string>;

const byAddr = new Map<string, KnownContract>(CONTRACTS.map((c) => [c.address.toLowerCase(), c]));
const acctByAddr = new Map(ACCOUNTS.map((a) => [a.address.toLowerCase(), a]));

export const knownContract = (a: string | null | undefined) => (a ? byAddr.get(a.toLowerCase()) : undefined);
export const knownAccount = (a: string | null | undefined) => (a ? acctByAddr.get(a.toLowerCase()) : undefined);
export const REWARD_SINK = ACCOUNTS.find((a) => a.name === "Reward sink")!.address;
export const TREASURY = ACCOUNTS.find((a) => a.name === "Treasury")!.address;
