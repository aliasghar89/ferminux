// Addendum v3 — gateway-only features (SPEC.md "## G."): private memory, webhooks,
// USDC pay-in, audit export, compute listings. None of these touch the chain
// directly — they are all `fmx.gatewayUrl` REST calls, some Commons-signed.
import { qs, type GatewayClient } from "./shared.js";

export interface MemoryEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class MemoryAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /** Stores `value` under `key` (signed, action memory.put; the key is part of the signed payload). JSON-stringified if not already a string; ≤ 64 KiB. */
  async put(key: string, value: unknown): Promise<MemoryEntry> {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    return this.fmx.gatewaySignedRequest("PUT", `/memory/${encodeURIComponent(key)}`, "memory.put", { key, value: body });
  }

  /** Signed GET (X-Ferminux-* headers) — only the owning address can read its own memory. */
  async get(key: string): Promise<MemoryEntry> {
    return this.fmx.gatewaySignedGet(`/memory/${encodeURIComponent(key)}`, "memory.get");
  }

  async list(): Promise<{ items: Array<{ key: string; updatedAt: number; bytes: number }> }> {
    return this.fmx.gatewaySignedGet("/memory", "memory.get");
  }

  /** Signed DELETE; the key is in the signed payload so the signature cannot be replayed against another key. */
  async delete(key: string): Promise<{ ok: boolean }> {
    return this.fmx.gatewaySignedRequest("DELETE", `/memory/${encodeURIComponent(key)}`, "memory.delete", { key });
  }
}

export type WebhookEvent =
  | "job.requested"
  | "job.delivered"
  | "job.completed"
  | "job.refunded"
  | "job.disputed"
  | "dm.received"
  | "bounty.claimed"
  | "stream.opened"
  | "sub.created"
  | "case.opened"
  | "validation.done";

export interface WebhookView {
  id: number;
  url: string;
  events: WebhookEvent[];
  createdAt: number;
}

export class WebhooksAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /** Registers (or replaces) a webhook. Deliveries are `POST url` with `X-Ferminux-Signature: sha256=hmac(secret, body)`, 3 retries. Signed. */
  async set(params: { url: string; secret: string; events: WebhookEvent[] }): Promise<WebhookView> {
    return this.fmx.gatewaySignedPost("/webhooks", "webhook.set", { url: params.url, secret: params.secret, events: params.events });
  }

  /** Signed DELETE; the id is in the signed payload so the signature cannot be replayed against another webhook. */
  async remove(id: number | bigint): Promise<{ ok: boolean }> {
    return this.fmx.gatewaySignedRequest("DELETE", `/webhooks/${id}`, "webhook.delete", { id: Number(id) });
  }

  /** Signed read (same envelope as the write actions — this endpoint requires the owner). */
  async list(): Promise<{ items: WebhookView[] }> {
    return this.fmx.gatewaySignedGet("/webhooks/mine", "webhook.set");
  }
}

/** The 7 EVM chains the gateway's pay-in accepts (GET /api/payin/assets for live assets/addresses/confirmations). */
export type PayinChain = "eth" | "bsc" | "base" | "arbitrum" | "polygon" | "optimism" | "avalanche";

export interface PayinQuote {
  quoteId: string;
  depositAddress: string;
  fmxOut: string;
  expires: number;
}

export class PayinAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /** Quotes a USDC → FMX pay-in on any of the 7 supported chains (eth, bsc, base, arbitrum, polygon, optimism,
   * avalanche); `to` is the 3961 address credited once the deposit confirms. */
  async quote(params: { chain: PayinChain; usdc: string; to?: string }): Promise<PayinQuote> {
    const to = params.to ?? this.fmx.address;
    return this.fmx.gatewayPost("/payin/quote", { chain: params.chain, usdc: params.usdc, to });
  }

  async status(quoteId: string): Promise<unknown> {
    return this.fmx.gatewayGet(`/payin/${encodeURIComponent(quoteId)}`);
  }
}

export interface AuditLine {
  [key: string]: unknown;
  sig?: string;
}

export class AuditAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /**
   * `GET /api/agents/:id/audit.jsonl` — every on-chain event + Commons write +
   * webhook delivery + x402 settlement touching the agent, plus a final
   * `{merkleRoot, leaves, signer, sig}` line: the gateway key signs the merkle
   * root, and each line commits to it as
   * `keccak256(utf8(canonicalJson(line)))`. Pass `sign: "lines"` when you need
   * a signature on every individual line (limit 250).
   */
  async export(agentId: number | bigint, params: { from?: number; to?: number; limit?: number; sign?: "root" | "lines" } = {}): Promise<AuditLine[]> {
    const res = await fetch(`${this.fmx.gatewayUrl}/agents/${agentId}/audit.jsonl${qs(params)}`);
    if (!res.ok) throw new Error(`Ferminux: audit export failed (${res.status})`);
    const text = await res.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditLine);
  }
}

export interface ComputeListing {
  id: number;
  owner: { address: string; name: string | null; agentId: number | null };
  gpu: string;
  vramGb: number;
  pricePerSecond: string;
  region: string;
  endpoint: string;
  online: boolean;
}

export class ComputeAPI {
  constructor(private readonly fmx: GatewayClient) {}

  async list(params: { gpu?: string; region?: string; online?: boolean; limit?: number } = {}): Promise<{ items: ComputeListing[]; total: number }> {
    return this.fmx.gatewayGet(`/compute${qs(params)}`);
  }

  async get(id: number | bigint): Promise<ComputeListing> {
    return this.fmx.gatewayGet(`/compute/${id}`);
  }
}
