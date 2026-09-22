// Addendum v3 — C1 X402Vault: pay-per-request in native FMX (SPEC.md "## C1", "## G.", "## S.").
//
// Client side: `fmx.x402.pay(fetchLike)` wraps any fetch-like function with the
// 402 handshake (sign a Voucher, retry with a `PAYMENT` header); `fmx.fetch` is
// `fmx.x402.pay(globalThis.fetch)` bound for convenience.
// Server side: `fmx.x402.requirePayment(price)` returns a Fastify preHandler /
// Express middleware that calls the gateway facilitator (`/api/x402/verify` +
// `/api/x402/settle`) — it never touches the chain directly.
import { getAddress, keccak256, randomBytes, toUtf8Bytes, ZeroHash } from "ethers";
import { X402_VAULT_ABI } from "../abi.js";
import { hashVoucher, signVoucher, type Voucher } from "../sign.js";
import { lazyContract, requireAddress, toWei, type AmountLike, type GatewayClient } from "./shared.js";

export type { Voucher } from "../sign.js";

export interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: { vault?: string; nonceHint?: string | number };
}
export interface X402Requirement {
  x402Version: number;
  accepts: X402Accept[];
}
export interface X402PaymentResponse {
  success: boolean;
  txHash?: string;
  nonce?: string;
}

/** Default spend cap per 402-paid request (1 FMX); raise it with `new Ferminux({ x402MaxPerRequest })` or `fmx.x402.pay(fetch, { maxAmount })`. */
export const X402_DEFAULT_MAX_PER_REQUEST = 10n ** 18n;
/** Vouchers are never signed with a lifetime outside [90 s, 1 h] whatever the server suggests (the gateway refuses < 90 s; long-lived vouchers are dormant liabilities). */
export const X402_MIN_VOUCHER_S = 90;
export const X402_MAX_VOUCHER_S = 3600;

export interface PayOptions {
  /** most this wrapper will sign for on a single request (wei, or a number of FMX); default X402_DEFAULT_MAX_PER_REQUEST / the client's x402MaxPerRequest */
  maxAmount?: AmountLike;
}

function base64Encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
function base64Decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

function serializeVoucher(v: Voucher): Record<string, string> {
  return { payer: v.payer, payee: v.payee, amount: v.amount.toString(), nonce: v.nonce.toString(), expiry: v.expiry.toString(), ref: v.ref };
}
function deserializeVoucher(v: Record<string, unknown>): Voucher {
  return {
    payer: String(v.payer),
    payee: String(v.payee),
    amount: BigInt(v.amount as string),
    nonce: BigInt(v.nonce as string),
    expiry: BigInt(v.expiry as string),
    ref: String(v.ref),
  };
}

/** The request URL of a fetch input (string, URL or Request); "" when it cannot be read. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const r = input as { url?: unknown };
  return typeof r?.url === "string" ? r.url : "";
}
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function randomNonce(): bigint {
  const bytes = randomBytes(32);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

async function parse402(res: Response): Promise<X402Requirement> {
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      return JSON.parse(base64Decode(header)) as X402Requirement;
    } catch {
      // fall through to the body
    }
  }
  return (await res.json()) as X402Requirement;
}

export interface RequirePaymentOptions {
  /** Payee address for the 402 challenge; defaults to the configured signer's address. */
  payTo?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /** Vault address advertised in the challenge; defaults to the network's x402Vault. */
  vault?: string;
}

interface VerifyOutcome {
  ok: boolean;
  status: number;
  body: unknown;
  responseHeader?: string;
}

/** Fastify preHandler / Express middleware, framework-detected by call shape (3rd arg `next` ⇒ Express). */
export interface X402Middleware {
  (a: unknown, b: unknown, next?: (err?: unknown) => void): Promise<void>;
  fastify(request: FastifyLike, reply: FastifyReplyLike): Promise<void>;
  express(req: ExpressReqLike, res: ExpressResLike, next: (err?: unknown) => void): Promise<void>;
  challenge(): X402Requirement;
}
interface FastifyLike {
  headers?: Record<string, unknown>;
}
interface FastifyReplyLike {
  code(status: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(body?: unknown): unknown;
}
interface ExpressReqLike {
  headers?: Record<string, unknown>;
}
interface ExpressResLike {
  status(code: number): ExpressResLike;
  set(name: string, value: string): ExpressResLike;
  json(body?: unknown): unknown;
}

export class X402API {
  private readonly vault: () => import("ethers").Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.vault = lazyContract("x402Vault", () => this.fmx.v3.x402Vault, X402_VAULT_ABI, this.fmx.runner);
  }

  // --- vault contract calls (direct, no gateway involved) ---

  async deposit(amount: AmountLike): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.vault().deposit({ value: toWei(amount) });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async depositFor(payer: string, amount: AmountLike): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.vault().depositFor(payer, { value: toWei(amount) });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Starts the 1 h unlock window before `withdraw()` is allowed. */
  async requestUnlock(): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.vault().requestUnlock();
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async withdraw(amount: AmountLike): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.vault().withdraw(toWei(amount));
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async withdrawCredits(): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.vault().withdrawCredits();
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Deposited (locked/unlocking) FMX balance for `address` (default: the signer). */
  async balance(address?: string): Promise<bigint> {
    const addr = address ?? this.fmx.requireSigner().address;
    return this.vault().balance(addr);
  }

  /** Unix seconds the deposit unlocks at (0 = still locked / never requested). */
  async unlockAt(address?: string): Promise<bigint> {
    const addr = address ?? this.fmx.requireSigner().address;
    return this.vault().unlockAt(addr);
  }

  /** Pull-payment credits accrued as a payee (from settled vouchers). */
  async credits(address?: string): Promise<bigint> {
    const addr = address ?? this.fmx.requireSigner()?.address ?? this.fmx.address;
    if (!addr) throw new Error("Ferminux: no address given and no signer configured");
    return this.vault().credits(addr);
  }

  /** Vault's own verify() view — pre-check without the gateway facilitator. */
  async verifyOnChain(voucher: Voucher, sig: string): Promise<{ ok: boolean; reason: string }> {
    const [ok, reason]: [boolean, string] = await this.vault().verify(voucher, sig);
    return { ok, reason };
  }

  /** Gateway view of a payer's vault balance + pending vouchers (GET /api/x402/payer/:addr). */
  async payerInfo(address?: string): Promise<unknown> {
    const addr = address ?? this.fmx.address;
    if (!addr) throw new Error("Ferminux: no address given and no signer configured");
    return this.fmx.gatewayGet(`/x402/payer/${addr}`);
  }

  /** GET /api/x402/supported — the facilitator's accepted schemes/network. */
  async supported(): Promise<unknown> {
    return this.fmx.gatewayGet("/x402/supported");
  }

  // --- client: 402-aware fetch ---

  /**
   * Wraps a fetch-like function with the x402 handshake: on a 402, signs a
   * Voucher for the first `ferminux-voucher` accept and retries once with the
   * `PAYMENT` header. Non-402 responses (including a second 402 — e.g. price
   * increased between requests) are returned as-is without a second retry.
   *
   * Guard rails (the 402 comes from an arbitrary server): the amount must be
   * within `maxAmount` (default 1 FMX), the advertised vault must be the
   * configured X402Vault (a foreign verifying contract is never signed for),
   * the network must be this chain, and the voucher lifetime is clamped to
   * [90 s, 1 h]. The voucher only ever goes back to the origin that answered
   * 402: a 402 reached through a cross-origin redirect is refused, and the
   * paid retry runs with `redirect: "manual"` so the PAYMENT header is never
   * replayed onto a redirect target.
   */
  pay(fetchLike: typeof fetch = fetch, opts: PayOptions = {}): typeof fetch {
    const cap = opts.maxAmount !== undefined ? toWei(opts.maxAmount) : this.fmx.x402MaxPerRequest ?? X402_DEFAULT_MAX_PER_REQUEST;
    const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const first = await fetchLike(input, init);
      if (first.status !== 402) return first;
      // Which origin actually answered 402? `Response.url` is the post-redirect URL,
      // so a 402 reached across a redirect is refused before anything is signed.
      const isRequestInput = typeof Request !== "undefined" && input instanceof Request;
      const requestedUrl = urlOf(input);
      const issuedUrl = typeof first.url === "string" && first.url ? first.url : requestedUrl;
      const requestedOrigin = originOf(requestedUrl);
      const issuerOrigin = originOf(issuedUrl);
      if (requestedOrigin && issuerOrigin && requestedOrigin !== issuerOrigin) {
        throw new Error(
          `Ferminux: the 402 came from ${issuerOrigin} after a redirect from ${requestedOrigin} — refusing to sign a voucher for an origin other than the one that was called`,
        );
      }
      const requirement = await parse402(first);
      const accept = requirement.accepts?.find((a) => a.scheme === "ferminux-voucher") ?? requirement.accepts?.[0];
      if (!accept) throw new Error("Ferminux: 402 response had no ferminux-voucher payment option");
      if (accept.scheme !== "ferminux-voucher") throw new Error(`Ferminux: unsupported x402 scheme "${accept.scheme}"`);
      if (accept.network && accept.network !== `ferminux:${this.fmx.chainId}`) throw new Error(`Ferminux: 402 asks for network "${accept.network}", this client is on ferminux:${this.fmx.chainId}`);
      const configured = this.fmx.v3.x402Vault;
      const advertised = accept.extra?.vault || "";
      if (configured && advertised && advertised.toLowerCase() !== configured.toLowerCase()) {
        throw new Error(`Ferminux: 402 names vault ${advertised} but this client's X402Vault is ${configured} — refusing to sign for a foreign contract`);
      }
      const vaultAddr = configured || advertised;
      if (!vaultAddr) throw new Error("Ferminux: 402 response is missing extra.vault (and no local x402Vault configured)");
      let amount: bigint;
      try {
        amount = BigInt(accept.maxAmountRequired);
      } catch {
        throw new Error(`Ferminux: 402 maxAmountRequired is not a wei amount: ${String(accept.maxAmountRequired)}`);
      }
      if (amount <= 0n) throw new Error("Ferminux: 402 asks for a zero amount");
      if (amount > cap) throw new Error(`Ferminux: 402 asks for ${amount} wei, above this client's per-request cap of ${cap} wei (raise x402MaxPerRequest / pay(fetch, { maxAmount }))`);
      let payee: string;
      try {
        payee = getAddress(String(accept.payTo));
      } catch {
        throw new Error("Ferminux: 402 payTo is not an address");
      }
      const signer = this.fmx.requireSigner();
      const nonce = accept.extra?.nonceHint != null ? BigInt(accept.extra.nonceHint) : randomNonce();
      const ttl = Math.min(X402_MAX_VOUCHER_S, Math.max(X402_MIN_VOUCHER_S, Number(accept.maxTimeoutSeconds) || X402_MIN_VOUCHER_S));
      const expiry = BigInt(Math.floor(Date.now() / 1000) + ttl);
      const ref = accept.resource ? keccak256(toUtf8Bytes(accept.resource)) : ZeroHash;
      const voucher: Voucher = {
        payer: signer.address,
        payee,
        amount,
        nonce,
        expiry,
        ref,
      };
      const signature = await signVoucher(signer, this.fmx.chainId, vaultAddr, voucher);
      const paymentHeader = base64Encode(
        JSON.stringify({ scheme: accept.scheme, network: accept.network, payload: { voucher: serializeVoucher(voucher), signature } }),
      );
      // The voucher is a bearer credential: it may only go back to the origin that
      // issued the 402. `redirect: "manual"` stops the retry at a redirect instead of
      // replaying the PAYMENT header onto whatever Location names (undici follows
      // redirects and forwards headers by default).
      const retryTarget = !isRequestInput && issuedUrl ? issuedUrl : input;
      const retryInit: RequestInit = { ...init, redirect: "manual", headers: { ...(init?.headers as Record<string, string> | undefined), PAYMENT: paymentHeader } };
      const paid = await fetchLike(retryTarget, retryInit);
      const redirected = (paid as { type?: string }).type === "opaqueredirect" || (paid.status >= 300 && paid.status < 400);
      if (redirected) {
        const location = paid.headers?.get?.("location") ?? "";
        throw new Error(
          `Ferminux: ${issuerOrigin || "the server"} redirected the paid retry${location ? ` to ${location}` : ""} — refusing to follow it while carrying a PAYMENT voucher. The voucher was not re-sent; call the final URL directly.`,
        );
      }
      return paid;
    };
    return wrapped as typeof fetch;
  }

  // --- server: requirePayment() facilitator middleware (no chain access — calls the gateway) ---

  private buildChallenge(priceWei: bigint, opts: RequirePaymentOptions): X402Requirement {
    const vault = opts.vault ?? this.fmx.v3.x402Vault;
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "ferminux-voucher",
          network: `ferminux:${this.fmx.chainId}`,
          asset: "FMX",
          payTo: opts.payTo ?? this.fmx.address ?? "",
          maxAmountRequired: priceWei.toString(),
          resource: opts.resource ?? "",
          description: opts.description ?? "",
          mimeType: opts.mimeType ?? "application/json",
          maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 300, // the gateway facilitator refuses vouchers that expire in < 90 s
          extra: { vault, nonceHint: Date.now() },
        },
      ],
    };
  }

  private async verifyHeader(paymentHeader: string, challenge: X402Requirement): Promise<VerifyOutcome> {
    let parsed: { payload?: { voucher?: Record<string, unknown>; signature?: string } };
    try {
      parsed = JSON.parse(base64Decode(paymentHeader)) as typeof parsed;
    } catch {
      return { ok: false, status: 400, body: { error: "invalid PAYMENT header (not base64 JSON)" } };
    }
    const voucherRaw = parsed.payload?.voucher;
    const signature = parsed.payload?.signature;
    if (!voucherRaw || !signature) {
      return { ok: false, status: 400, body: { error: "PAYMENT header missing payload.voucher/payload.signature" } };
    }
    // The facilitator checks the voucher against OUR requirement (payee + amount), otherwise any valid
    // voucher — 1 wei, to the payer itself — would open the door.
    const accept = challenge.accepts[0]!;
    const paymentRequirements = { payTo: accept.payTo, maxAmountRequired: accept.maxAmountRequired, resource: accept.resource };
    try {
      const verifyRes = await this.fmx.gatewayPost<{ ok: boolean; reason?: string }>("/x402/verify", { voucher: voucherRaw, signature, paymentRequirements });
      if (!verifyRes.ok) return { ok: false, status: 402, body: { ...challenge, error: verifyRes.reason ?? "payment rejected" }, responseHeader: base64Encode(JSON.stringify(challenge)) };
      // settle = verify again + queue for settleBatch; only a queued voucher is a payment
      const settleRes = await this.fmx.gatewayPost<X402PaymentResponse & { errorReason?: string }>("/x402/settle", { voucher: voucherRaw, signature, paymentRequirements });
      if (settleRes.success === false) return { ok: false, status: 402, body: { ...challenge, error: settleRes.errorReason ?? "payment rejected" }, responseHeader: base64Encode(JSON.stringify(challenge)) };
      const responsePayload: X402PaymentResponse = { success: true, txHash: settleRes.txHash, nonce: String(voucherRaw.nonce) };
      return { ok: true, status: 200, body: responsePayload, responseHeader: base64Encode(JSON.stringify(responsePayload)) };
    } catch (err) {
      return { ok: false, status: 502, body: { error: `Ferminux: x402 facilitator unreachable: ${(err as Error).message}` } };
    }
  }

  /**
   * Server helper for Fastify/Express: `app.post("/invoke", fmx.x402.requirePayment(price), handler)`
   * or `app.post("/invoke", { preHandler: fmx.x402.requirePayment(price) }, handler)` for Fastify.
   * Calls the gateway facilitator (`/api/x402/verify` + `/api/x402/settle`) — never the chain directly.
   */
  requirePayment(price: AmountLike, opts: RequirePaymentOptions = {}): X402Middleware {
    const priceWei = toWei(price);
    const challenge = () => this.buildChallenge(priceWei, opts);

    const fastify = async (request: FastifyLike, reply: FastifyReplyLike): Promise<void> => {
      const header = (request.headers?.payment ?? request.headers?.PAYMENT) as string | undefined;
      if (!header) {
        const body = challenge();
        reply.code(402).header("PAYMENT-REQUIRED", base64Encode(JSON.stringify(body))).send(body);
        return;
      }
      const result = await this.verifyHeader(header, challenge());
      if (result.responseHeader) reply.header(result.ok ? "PAYMENT-RESPONSE" : "PAYMENT-REQUIRED", result.responseHeader);
      if (!result.ok) reply.code(result.status).send(result.body);
      // ok: fall through to the route handler without sending a response.
    };

    const express = async (req: ExpressReqLike, res: ExpressResLike, next: (err?: unknown) => void): Promise<void> => {
      const header = (req.headers?.payment ?? req.headers?.PAYMENT) as string | undefined;
      if (!header) {
        const body = challenge();
        res.status(402).set("PAYMENT-REQUIRED", base64Encode(JSON.stringify(body))).json(body);
        return;
      }
      const result = await this.verifyHeader(header, challenge());
      if (result.responseHeader) res.set(result.ok ? "PAYMENT-RESPONSE" : "PAYMENT-REQUIRED", result.responseHeader);
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      next();
    };

    const middleware = (async (a: unknown, b: unknown, next?: (err?: unknown) => void) => {
      if (typeof next === "function") return express(a as ExpressReqLike, b as ExpressResLike, next);
      return fastify(a as FastifyLike, b as FastifyReplyLike);
    }) as X402Middleware;
    middleware.fastify = fastify;
    middleware.express = express;
    middleware.challenge = challenge;
    return middleware;
  }
}

export { deserializeVoucher, serializeVoucher, hashVoucher, requireAddress };
