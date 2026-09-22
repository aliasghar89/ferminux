// Shared plumbing for the Addendum v3 modules (x402, webhooks, memory,
// compute, A2A, ERC-8004, pay-in, relay, audit): config + contract handles,
// the "deployed?" gate every feature degrades through, and the signing keys.
import type { FastifyReply, FastifyRequest } from "fastify";
import { Contract, JsonRpcProvider, Wallet, type Interface } from "ethers";
import type { Db } from "../db.js";
import type { GatewayConfig, V3ContractKey, V3Contracts } from "../config.js";
import { loadV3Abi, v3Interface } from "../abi-v3.js";
import type { CommonsContext } from "../commons/context.js";
import { HttpError } from "../commons/context.js";
import type { ActivityBus } from "../commons/activity.js";
import type { WebhookBus } from "./webhooks.js";

export const DISABLED_NOT_DEPLOYED = { disabled: true, reason: "not deployed" } as const;

export interface V3Context {
  db: Db;
  cfg: GatewayConfig;
  provider: JsonRpcProvider;
  commons: CommonsContext;
  activity: ActivityBus;
  webhooks: WebhookBus;
  now: () => number;
  nowS: () => number;
  contracts: V3Contracts;
  /** true when deployments.3961.json (or env) carries the address */
  deployed: (key: V3ContractKey) => boolean;
  address: (key: V3ContractKey) => string | undefined;
  /** read-only contract handle, or undefined when not deployed */
  contract: (key: V3ContractKey) => Contract | undefined;
  iface: (key: V3ContractKey) => Interface;
  /** x402 facilitator settlement wallet (FACILITATOR_KEY) */
  facilitator?: Wallet;
  /** gas-sponsorship relayer wallet (RELAYER_KEY) */
  relayer?: Wallet;
  /** USDC pay-in FMX hot wallet (PAYIN_HOT_KEY) */
  payinHot?: Wallet;
  /** audit-export signer (GATEWAY_SIGNING_KEY, or ephemeral) */
  signer: Wallet;
  signerEphemeral: boolean;
  fetchImpl: typeof fetch;
  /** the address that receives gateway fees (memory over-quota etc.) */
  feeRecipient: string;
  /** replies {disabled:true, reason:"not deployed"} with 503 when the contract is missing; returns false in that case */
  requireDeployed: (reply: FastifyReply, ...keys: V3ContractKey[]) => boolean;
}

export interface V3ContextOptions {
  db: Db;
  cfg: GatewayConfig;
  provider: JsonRpcProvider;
  commons: CommonsContext;
  activity: ActivityBus;
  webhooks: WebhookBus;
  fetchImpl?: typeof fetch;
  feeRecipient: string;
}

export function createV3Context(opts: V3ContextOptions): V3Context {
  const { db, cfg, provider, commons, activity, webhooks } = opts;
  const contracts: V3Contracts = { ...(cfg.v3 ?? {}) };
  const ifaces = new Map<V3ContractKey, Interface>();
  const handles = new Map<V3ContractKey, Contract>();

  const deployed = (key: V3ContractKey) => typeof contracts[key] === "string";
  const address = (key: V3ContractKey) => contracts[key];
  const iface = (key: V3ContractKey) => {
    let i = ifaces.get(key);
    if (!i) {
      i = v3Interface(key);
      ifaces.set(key, i);
    }
    return i;
  };
  const contract = (key: V3ContractKey) => {
    const addr = contracts[key];
    if (!addr) return undefined;
    let c = handles.get(key);
    if (!c) {
      c = new Contract(addr, loadV3Abi(key).abi, provider);
      handles.set(key, c);
    }
    return c;
  };

  const facilitator = cfg.facilitatorKey ? new Wallet(cfg.facilitatorKey, provider) : undefined;
  const relayer = cfg.relayerKey ? new Wallet(cfg.relayerKey, provider) : undefined;
  const payinHot = cfg.payinHotKey ? new Wallet(cfg.payinHotKey, provider) : undefined;
  const signerEphemeral = !cfg.gatewaySigningKey;
  const signer = new Wallet(cfg.gatewaySigningKey ?? Wallet.createRandom().privateKey);
  if (signerEphemeral) console.warn(`[v3] GATEWAY_SIGNING_KEY unset — audit exports are signed by an ephemeral key ${signer.address} (rotates on restart)`);

  function requireDeployed(reply: FastifyReply, ...keys: V3ContractKey[]): boolean {
    const missing = keys.filter((k) => !deployed(k));
    if (!missing.length) return true;
    void reply.code(503).send({ ...DISABLED_NOT_DEPLOYED, missing });
    return false;
  }

  return {
    db,
    cfg,
    provider,
    commons,
    activity,
    webhooks,
    now: commons.now,
    nowS: commons.nowS,
    contracts,
    deployed,
    address,
    contract,
    iface,
    facilitator,
    relayer,
    payinHot,
    signer,
    signerEphemeral,
    fetchImpl: opts.fetchImpl ?? fetch,
    feeRecipient: opts.feeRecipient,
    requireDeployed,
  };
}

/** Reads the raw request body (the server's catch-all parser hands us a Buffer) as JSON, or throws 400. */
export function bodyJson(req: FastifyRequest): Record<string, unknown> {
  const raw = req.body;
  let text: string;
  if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
  else if (typeof raw === "string") text = raw;
  else if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  else throw new HttpError(400, "JSON body required");
  if (!text.trim()) throw new HttpError(400, "JSON body required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "JSON body must be an object");
  return parsed as Record<string, unknown>;
}

export function b64json(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64");
}
export function unb64json(s: string): unknown {
  return JSON.parse(Buffer.from(s.trim(), "base64").toString("utf8"));
}

/** Day bucket (UTC) for per-day limits. */
export function dayStart(nowS: number): number {
  return nowS - (nowS % 86400);
}
