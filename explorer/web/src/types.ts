/* Normalised shapes of the index (Blockscout REST v2, 9.0.2) as the explorer sees them AFTER src/api.ts.
   Pages never see a backend word: token standards are FRC-*, `miner` is `signer` (≥ 160,000) or
   `producer` (< 160,000), `is_miner` is `isSigner`, `validations_count` is `blocksConfirmed`, capped tab
   counters are {n, capped}. Wei amounts and big counts stay decimal strings: parse with big() at format time.
   Shapes measured in API.md §3 and fixtures/. Fields we don't use are left out on purpose. */

export type Wei = string;           // decimal string, e.g. "174382001220674"
export type Iso = string;           // ISO-8601 UTC, e.g. "2026-09-24T17:06:44.000000Z"
export type Hex = string;
export type Std = "FRC-20" | "FRC-721" | "FRC-1155" | "FRC-404" | string;

/** Opaque cursor. Pass it back verbatim (keys differ per endpoint). */
export type PageParams = Record<string, string | number | null>;
export interface Paged<T> { items: T[]; next_page_params: PageParams | null }

export interface AddressParam {
  hash: string;
  name: string | null;
  is_contract: boolean;
  is_verified: boolean | null;
  implementations?: { address_hash?: string; address?: string; name: string | null }[];
  proxy_type?: string | null;
  public_tags?: unknown[];
  metadata?: unknown | null;
  ens_domain_name?: string | null;
}

export type Era = "authority" | "pow";
export interface Reward { type: "signer" | "producer" | "sink" | "treasury" | "uncle" | string; reward: Wei }
export interface Block {
  height: number;
  hash: Hex;
  parent_hash: Hex;
  timestamp: Iso;
  era: Era;
  /** Confirming signer from the index; null when the index reports 0x0 (page-1 cache, API.md #1): fill from signer.ts. */
  signer: AddressParam | null;
  /** Proof-of-work era producer (< 160,000). */
  producer: AddressParam | null;
  transactions_count: number;
  gas_used: string;
  gas_limit: string;
  gas_used_percentage: number | null;
  base_fee_per_gas: Wei | null;
  burnt_fees: Wei | null;
  priority_fee: Wei | null;
  transaction_fees: Wei | null;
  /** [] on the page-1 cache: compute the split with scheduleReward() and tag it PER SCHEDULE. */
  rewards: Reward[];
  difficulty: string;          // "2" = in turn, "1" = out of turn (authority era)
  size: number;
  nonce: Hex;
  total_difficulty: string | null;
  /** Objects on the index's block endpoints ([{hash}]); tolerate plain strings too. */
  uncles_hashes: (Hex | { hash: Hex })[];
  type: "block" | "reorg" | "uncle" | string;
}
export interface BlockCountdown { countdown_block_number: string; current_block_number: string; remaining_blocks_count: string; estimated_time_in_seconds: string }

export interface TokenInfo {
  address_hash: string;
  name: string | null;
  symbol: string | null;
  type: Std;
  decimals: string | null;
  total_supply: string | null;
  holders_count: string | null;
  icon_url: string | null;
}
export interface TokenTotal { decimals?: string | null; value?: string | null; token_id?: string | null; token_instance?: TokenInstance | null }
export interface TokenTransfer {
  transaction_hash: Hex;
  log_index: number;
  block_number: number;
  block_hash: Hex;
  timestamp: Iso | null;           // null inside /transactions/:h/token-transfers: use the tx timestamp
  type: "token_transfer" | "token_minting" | "token_burning" | string;
  from: AddressParam;
  to: AddressParam;
  token: TokenInfo;
  total: TokenTotal;
  method: string | null;
}
export interface TokenInstance {
  id: string;
  image_url: string | null;
  animation_url?: string | null;
  external_app_url: string | null;
  metadata: { name?: string; description?: string; image?: string; attributes?: { trait_type?: string; value?: unknown }[]; [k: string]: unknown } | null;
  owner: AddressParam | null;
  token?: TokenInfo;
}
export interface TokenCounters { token_holders_count: string; transfers_count: string }
export interface TokenHolder { address: AddressParam; value: string; token_id: string | null }

export interface Tx {
  hash: Hex;
  status: "ok" | "error" | null;   // null = pending
  result: string;
  block_number: number | null;
  timestamp: Iso | null;
  confirmations: number;
  confirmation_duration: [number, number] | number[];
  from: AddressParam;
  to: AddressParam | null;
  created_contract: AddressParam | null;
  value: Wei;
  fee: { type: string; value: Wei };
  gas_used: string | null;
  gas_limit: string;
  gas_price: Wei | null;
  base_fee_per_gas: Wei | null;
  max_fee_per_gas: Wei | null;
  max_priority_fee_per_gas: Wei | null;
  priority_fee: Wei | null;
  transaction_burnt_fee: Wei | null;
  nonce: number;
  position: number | null;
  type: number | null;
  method: string | null;           // a 4-byte selector: the index verifies nothing (API.md #3)
  raw_input: Hex;
  decoded_input: unknown | null;
  revert_reason: unknown | null;
  transaction_types: string[];
  token_transfers: TokenTransfer[] | null;
  token_transfers_overflow: boolean | null;
}

export interface Log {
  index: number;
  address: AddressParam;
  topics: (Hex | null)[];          // null-padded to 4: drop the nulls before decoding
  data: Hex;
  decoded: unknown | null;
  block_number: number;
  block_hash: Hex;
  transaction_hash: Hex;
}

export interface StateChange {
  type: "coin" | "token";
  address: AddressParam;
  isSigner: boolean;               // was is_miner
  balance_before: string | null;
  balance_after: string | null;
  change: string | unknown[];
  token: TokenInfo | null;
  token_id: string | null;
}

export interface Address {
  hash: string;
  name: string | null;
  is_contract: boolean;
  is_verified: boolean | null;
  coin_balance: Wei | null;        // null + every flag false = an unused address (200, not 404)
  block_number_balance_updated_at: number | null;
  creator_address_hash: string | null;
  creation_transaction_hash: Hex | null;
  has_logs: boolean;
  has_tokens: boolean;
  has_token_transfers: boolean;
  has_validated_blocks: boolean;
  implementations: AddressParam["implementations"];
  proxy_type: string | null;
  token: TokenInfo | null;
}
export interface AddressCounters { transactions_count: string; token_transfers_count: string; gas_usage_count: string; blocksConfirmed: string }
export interface Capped { n: number; capped: boolean }
export interface TabsCounters {
  transactions_count: Capped; token_transfers_count: Capped; blocksConfirmed: Capped;
  logs_count: Capped; token_balances_count: Capped; internal_transactions_count: Capped; withdrawals_count: Capped;
}
export interface TokenBalance { token: TokenInfo; token_id: string | null; token_instance: TokenInstance | null; value: string }
export interface CoinBalance { block_number: number; block_timestamp: Iso; delta: string; transaction_hash: Hex | null; value: Wei }
export interface CoinBalanceDay { date: string; value: Wei }
export interface Account { hash: string; coin_balance: Wei | null; transactions_count: string; is_contract: boolean; name: string | null }

export interface Stats {
  average_block_time: number | null;      // ms
  total_addresses: string | null;
  total_transactions: string | null;
  transactions_today: string | null;
  gas_used_today: string | null;
  /* never read: total_blocks (stale), gas_prices (wrong), market_cap/coin_price/tvl (no price on this explorer) */
}
export interface TxChartPoint { date: string; transactions_count: number }
export interface TxStats { pending_transactions_count: string; transaction_fees_sum_24h: Wei; transaction_fees_avg_24h: Wei; transactions_count_24h: string }
export interface IndexingStatus { finished_indexing: boolean; finished_indexing_blocks: boolean; indexed_blocks_ratio: string | null; indexed_internal_transactions_ratio: string | null }

export interface SmartContract {
  creation_bytecode: Hex | null;
  deployed_bytecode: Hex | null;
  creation_status?: string | null;
  proxy_type: string | null;
  implementations: { address_hash?: string; address?: string; name: string | null }[];
  is_verified?: boolean;
  abi?: unknown[];
  source_code?: string;
  compiler_version?: string;
}
export interface SmartContractsCounters { smart_contracts: string; new_smart_contracts_24h: string; verified_smart_contracts: string; new_verified_smart_contracts_24h: string }
export interface VerificationConfig { solidity_compiler_versions: string[]; vyper_compiler_versions: string[]; verification_options: string[] }

export interface SearchItem {
  type: "token" | "address" | "contract" | "block" | "transaction" | string;
  name?: string | null;
  symbol?: string | null;
  address_hash?: string;
  token_type?: Std;
  total_supply?: string | null;
  block_number?: number;
  block_hash?: Hex;
  transaction_hash?: Hex;
  timestamp?: Iso | null;
  url?: string;
  is_smart_contract_verified?: boolean;
}
export interface Redirect { redirect: boolean; type?: "block" | "transaction" | "address" | string; parameter?: string }
