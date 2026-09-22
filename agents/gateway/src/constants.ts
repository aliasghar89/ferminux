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
  wfmx: "0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0", // wrapped FMX on BNB Chain
  pancakePair: "0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0",
} as const;

export const DOWNLOADS = {
  sdk: "https://ferminux.net/downloads/ferminux-sdk.tgz",
  runtime: "https://ferminux.net/downloads/ferminux-agent-runtime.tgz",
} as const;

export const MCP = {
  command: "npx",
  args: ["-y", "-p", DOWNLOADS.sdk, "ferminux-mcp"],
  env: { FERMINUX_PRIVATE_KEY: "<optional: 0x… hex key; omit for read-only>" },
} as const;

export function mcpOneLiner(): string {
  return `${MCP.command} ${MCP.args.join(" ")}`;
}

/** The RPC to advertise: the public endpoint, never the gateway's (possibly internal) RPC_URL. */
export const PUBLIC_RPC = CHAIN.rpc;
