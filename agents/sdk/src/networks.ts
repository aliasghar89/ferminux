// Network defaults for the Ferminux SDK.
//
// REGISTRY/ESCROW addresses are baked in at *build time* from
// agents/deployments.3961.json (or agents/deployments.json as a fallback —
// see agents/SPEC.md, which names the file without the chain-id suffix) via
// scripts/gen-networks.mjs → src/networks.generated.ts. If neither file
// exists at build time the generated addresses are the zero address, and
// MUST be overridden at runtime via the Ferminux constructor
// ({registry, escrow}) or the FERMINUX_REGISTRY / FERMINUX_ESCROW env vars.
import {
  GENERATED_REGISTRY,
  GENERATED_ESCROW,
  GENERATED_NFT,
  GENERATED_DEPLOY_BLOCK,
  GENERATED_FOUND,
  GENERATED_X402VAULT,
  GENERATED_ACCOUNTFACTORY,
  GENERATED_ACCOUNTIMPL,
  GENERATED_STREAMPAY,
  GENERATED_ARBITERPOOL,
  GENERATED_IDENTITY8004,
  GENERATED_REPUTATION8004,
  GENERATED_VALIDATION8004,
  GENERATED_TOKENFACTORY,
  GENERATED_MEMORYANCHOR,
  GENERATED_ENDORSEMENTS,
} from "./networks.generated.js";

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpc: string;
  registry: string;
  escrow: string;
  nft: string;
  deployBlock: number;
  gateway: string;
  // Addendum v3 — Agent Economy (SPEC.md "## S."). "" = not deployed yet; the
  // v3 SDK modules (fmx.x402, fmx.account, fmx.streams, fmx.disputes,
  // fmx.reputation/validation, fmx.tokens) throw NotDeployed when empty.
  x402Vault: string;
  accountFactory: string;
  accountImpl: string;
  streamPay: string;
  arbiterPool: string;
  identity8004: string;
  reputation8004: string;
  validation8004: string;
  tokenFactory: string;
  /** The record layer — AI-CV / AI-LinkedIn (FRC-100 memory anchoring, weighted endorsements). */
  memoryAnchor: string;
  endorsements: string;
  /**
   * Keys allowed to INDEX-SIGN an AI-CV.
   *
   * A CV is either self-issued (signed by the key AgentRegistry says owns the
   * agent) or index-issued (assembled and signed by a gateway). An index key
   * speaks only for authorship and completeness of the off-chain half; no claim
   * depends on it. It is pinned HERE, in the package a verifier installs, and
   * never learned from the document or from an endpoint the issuer controls —
   * otherwise a self-signed impostor document is indistinguishable from the
   * real issuer's, and the signature attests nothing at all.
   */
  cvIssuers: string[];
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const DEFAULT_CHAIN_ID = 3961;

function envAddr(name: string, fallback: string): string {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.length > 0 ? v : fallback;
}

export const NETWORKS: Record<number, NetworkConfig> = {
  3961: {
    chainId: 3961,
    name: "Ferminux Network",
    rpc: "https://rpc.ferminux.net",
    registry: envAddr("FERMINUX_REGISTRY", GENERATED_REGISTRY),
    escrow: envAddr("FERMINUX_ESCROW", GENERATED_ESCROW),
    nft: envAddr("FERMINUX_NFT", GENERATED_NFT),
    deployBlock: GENERATED_DEPLOY_BLOCK,
    gateway: "https://ferminux.net/api",
    x402Vault: envAddr("FERMINUX_X402_VAULT", GENERATED_X402VAULT),
    accountFactory: envAddr("FERMINUX_ACCOUNT_FACTORY", GENERATED_ACCOUNTFACTORY),
    accountImpl: envAddr("FERMINUX_ACCOUNT_IMPL", GENERATED_ACCOUNTIMPL),
    streamPay: envAddr("FERMINUX_STREAM_PAY", GENERATED_STREAMPAY),
    arbiterPool: envAddr("FERMINUX_ARBITER_POOL", GENERATED_ARBITERPOOL),
    identity8004: envAddr("FERMINUX_IDENTITY_8004", GENERATED_IDENTITY8004),
    reputation8004: envAddr("FERMINUX_REPUTATION_8004", GENERATED_REPUTATION8004),
    validation8004: envAddr("FERMINUX_VALIDATION_8004", GENERATED_VALIDATION8004),
    tokenFactory: envAddr("FERMINUX_TOKEN_FACTORY", GENERATED_TOKENFACTORY),
    cvIssuers: (envAddr("FERMINUX_CV_ISSUERS", "0x2368066B1A6C5D3f3C92a632a1378dd992cC05A3") || "").split(",").map((a) => a.trim()).filter(Boolean),
    memoryAnchor: envAddr("FERMINUX_MEMORY_ANCHOR", GENERATED_MEMORYANCHOR),
    endorsements: envAddr("FERMINUX_ENDORSEMENTS", GENERATED_ENDORSEMENTS),
  },
};

export const DEPLOYMENTS_FOUND_AT_BUILD = GENERATED_FOUND;
