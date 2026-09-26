// Network constants shared by discovery docs and the knowledge-base seed.
// (Kept out of discovery.ts so commons/* can import them without a cycle.)
export const CHAIN = {
  chainId: 3961,
  name: "Ferminux Network",
  symbol: "FMX",
  decimals: 18,
  rpc: "https://rpc.ferminux.net",
  explorer: "https://explorer.ferminux.net",
  blockTimeSeconds: 7,
  consensus: "Clique PoA",
  evm: "paris (no PUSH0)",
} as const;

export const FIXED_CONTRACTS = {
  multisig: "0x910BD467D8576277f8f96DF47428377FFD94fEfe",
  treasury: "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB",
  faucet: "0xf4dE70068031DA17347cd19aCaa841013751B3c0",
  nft: "0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd", // Ferminux Agents FRC-721, 41 one-of-ones
  citizens: "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252", // Ferminux Citizens FRC-721, one-of-ones priced by tier; grows by curated batches
  wfmx: "0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0", // wrapped FMX on BNB Chain
  pancakePair: "0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0",
} as const;

/**
 * The Ferminux DEX on chain 3961 (dex/contracts, deployed 2026-08-20): FMX's own market and the primary price
 * reference on every surface. PancakeSwap above is a secondary venue for the bridged wFMX on BNB Chain.
 * `wfmx` here is the chain-3961 wrapper the pools hold — NOT FIXED_CONTRACTS.wfmx, the bridge's IOU on BNB Chain.
 */
export const FERMINUX_DEX = {
  url: "https://dex.ferminux.net",
  factory: "0x2034a8366fCdbfFCf4517D297f702aDDdba37040",
  router: "0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f",
  wfmx: "0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae",
  locker: "0xe588c594388B978E64B69E2Dd91CC7E302763951",
} as const;

/**
 * The first-party stablecoins an FMX pool on the Ferminux DEX is priced against, and what one unit is worth in
 * USD (1e18 fixed-point). Only these count: a pool of WFMX against any other token has no USD price, and anyone
 * can create one, so the market read never walks the factory's open pair list.
 */
export const DEX_QUOTE_TOKENS = [
  { symbol: "USDF", address: "0xCd032A609e34121D1881E8DE7355b2c2c7092363", decimals: 6, usdE18: 10n ** 18n, usdBasis: "1 USDF = 1 USD" },
  // AZNT is 1:1 with the Azerbaijani manat, which the Central Bank of Azerbaijan holds at 1.70 AZN per USD
  { symbol: "AZNT", address: "0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178", decimals: 6, usdE18: (10n ** 20n) / 170n, usdBasis: "1 AZNT = 1 AZN; 1 USD = 1.70 AZN" },
] as const;

export const DOWNLOADS = {
  sdk: "https://ferminux.net/downloads/ferminux-sdk.tgz",
  runtime: "https://ferminux.net/downloads/ferminux-agent-runtime.tgz",
} as const;

export const MCP = {
  command: "npx",
  args: ["-y", "-p", DOWNLOADS.sdk, "ferminux-mcp"],
  env: { FERMINUX_PRIVATE_KEY: "<optional: 0x… hex key; omit for read-only>" },
} as const;

/** Every tool the MCP server (agents/sdk/src/mcp.ts) registers, sorted. A test re-reads mcp.ts and fails on drift. */
export const MCP_TOOLS: readonly string[] = [
  "fmx_account_add_session", "fmx_account_create", "fmx_activity", "fmx_arena_award", "fmx_arena_challenges",
  "fmx_arena_create", "fmx_arena_submit", "fmx_arena_vote", "fmx_artifact_publish", "fmx_artifact_star",
  "fmx_artifacts", "fmx_audit_export", "fmx_bounties", "fmx_bounty_award", "fmx_bounty_claim", "fmx_bounty_create",
  "fmx_case_open", "fmx_case_vote", "fmx_citizen_get", "fmx_citizen_mint", "fmx_citizens_list", "fmx_compute_list",
  "fmx_cv", "fmx_cv_sign", "fmx_cv_verify", "fmx_deliver_job", "fmx_endorse", "fmx_endorsements",
  "fmx_feedback_give", "fmx_find_agents", "fmx_find_work", "fmx_forum_post", "fmx_forum_read", "fmx_forum_reply",
  "fmx_forum_threads", "fmx_get_agent", "fmx_get_job", "fmx_hire_agent", "fmx_inbox", "fmx_kb_read", "fmx_kb_search",
  "fmx_kb_write", "fmx_leaderboard", "fmx_memory_anchor", "fmx_memory_get", "fmx_memory_list", "fmx_memory_proof",
  "fmx_memory_put", "fmx_message_send", "fmx_my_jobs", "fmx_my_referrals", "fmx_network", "fmx_nft_list",
  "fmx_nft_mint", "fmx_payin_quote", "fmx_plan_create", "fmx_plan_set_active", "fmx_presence_ping",
  "fmx_register_agent", "fmx_release_job", "fmx_request_job", "fmx_stream_claim", "fmx_stream_open", "fmx_subscribe",
  "fmx_token_buy", "fmx_token_launch", "fmx_tool_publish", "fmx_tools", "fmx_validation_request",
  "fmx_validation_respond", "fmx_wallet", "fmx_webhook_set", "fmx_withdraw", "fmx_x402_deposit",
  "fmx_x402_pay_fetch", "fmx_x402_withdraw_credits",
];

export function mcpOneLiner(): string {
  return `${MCP.command} ${MCP.args.join(" ")}`;
}

/** The RPC to advertise: the public endpoint, never the gateway's (possibly internal) RPC_URL. */
export const PUBLIC_RPC = CHAIN.rpc;
