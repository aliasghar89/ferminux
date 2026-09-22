// x402 facilitator + `priced()` middleware — pay-per-request in native FMX
// through X402Vault vouchers (EIP-712 "FerminuxX402"/"1"/3961/vault).
//
// Wire format (x402 v1-compatible header names):
//   402 ← PAYMENT-REQUIRED: base64(JSON)  + JSON body {x402Version:1, accepts:[Requirement], error?}
//   →   PAYMENT: base64(JSON{scheme, network, payload:{voucher, signature}})
//   200 ← PAYMENT-RESPONSE: base64(JSON{success, txHash?, nonce})
// Settlement: verified vouchers are queued in `x402_vouchers` and pushed
// on-chain with `settleBatch` every 30 s or 50 vouchers by FACILITATOR_KEY.
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { Contract, getAddress, verifyTypedData, zeroPadValue, type TypedDataDomain } from "ethers";
import { X402_DOMAIN_NAME, X402_DOMAIN_VERSION, X402_VOUCHER_TYPES } from "../abi-v3.js";
import { CHAIN } from "../constants.js";
import { HttpError } from "../commons/context.js";
import { b64json, unb64json, DISABLED_NOT_DEPLOYED, type V3Context } from "./context.js";

export const X402_VERSION = 1;
export const X402_SCHEME = "ferminux-voucher";
export const X402_NETWORK = `ferminux:${CHAIN.chainId}`;
export const X402_ASSET = "FMX";
/** suggested voucher lifetime (clients set expiry = now + this) */
export const X402_MAX_TIMEOUT_S = 300;
/**
 * A voucher is accepted only while it stays valid for at least this long: the
 * resource is served immediately but settlement is batched (every 30 s), so a
 * voucher that expires before `settleBatch` lands is skipped by the vault and
 * the payee is never paid. Same horizon guards a payer whose vault deposit is
 * about to unlock (withdraw-before-settle).
 */
export const X402_MIN_EXPIRY_S = 90;
export const X402_BATCH_SIZE = 50;
export const X402_MAX_SETTLE_ATTEMPTS = 3;
/** a `submitted` batch whose receipt never arrived is re-checked / re-queued after this long */
export const X402_SUBMITTED_STALE_S = 600;
/** facilitator balance below this is reported as `lowFunds` on /api/health and /api/x402/supported */
export const X402_FACILITATOR_MIN_WEI = 10n ** 17n; // 0.1 FMX ≈ hundreds of settleBatch calls
const ZERO_REF = "0x" + "0".repeat(64);

export interface Voucher {
  payer: string;
  payee: string;
  /** wei, decimal string */
  amount: string;
  nonce: string;
  /** unix seconds */
  expiry: number;
  /** bytes32 */
  ref: string;
}
export interface PaymentRequirement {
  scheme: typeof X402_SCHEME;
  network: typeof X402_NETWORK;
  asset: typeof X402_ASSET;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { vault: string | null; nonceHint: number; settlement: "facilitator" | "disabled" };
}
export interface Payment {
  scheme: string;
  network: string;
  payload: { voucher: Voucher; signature: string };
}
export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  voucher?: Voucher;
}
export interface PaidInfo {
  free: boolean;
  payer: string | null;
  nonce: string | null;
  amount: string;
  payee: string | null;
}
export interface PricedOptions {
  /** wei to charge; null/0n = free (middleware passes through) */
  amount: (req: FastifyRequest) => bigint | null | Promise<bigint | null>;
  payTo: (req: FastifyRequest) => string | null;
  description?: string | ((req: FastifyRequest) => string);
  mimeType?: string;
  resource?: (req: FastifyRequest) => string;
}
export interface VoucherRow {
  payer: string;
  nonce: string;
  payee: string;
  amount: string;
  ref: string;
  expiry: number;
  sig: string;
  resource: string;
  status: "queued" | "submitted" | "settled" | "skipped" | "failed" | "unsettleable";
  txHash: string | null;
  error: string | null;
  createdAt: number;
  settledAt: number | null;
  /** settleBatch attempts so far (a reverted batch re-queues up to X402_MAX_SETTLE_ATTEMPTS) */
  attempts: number;
}

declare module "fastify" {
  interface FastifyRequest {
    x402?: PaidInfo;
  }
}

function toWei(v: unknown, name: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  throw new HttpError(400, `${name} must be a non-negative integer (decimal string)`);
}

/** Normalises an incoming voucher (checksummed addresses, decimal strings, bytes32 ref) or throws 400. */
export function normalizeVoucher(v: unknown): Voucher {
  if (!v || typeof v !== "object") throw new HttpError(400, "payload.voucher must be an object");
  const o = v as Record<string, unknown>;
  let payer: string;
  let payee: string;
  try {
    payer = getAddress(String(o.payer));
    payee = getAddress(String(o.payee));
  } catch {
    throw new HttpError(400, "voucher payer/payee must be 0x addresses");
  }
  const amount = toWei(o.amount, "voucher.amount").toString();
  const nonce = toWei(o.nonce, "voucher.nonce").toString();
  const expiry = Number(o.expiry);
  if (!Number.isInteger(expiry) || expiry < 0 || expiry > 2 ** 53) throw new HttpError(400, "voucher.expiry must be unix seconds");
  let ref = ZERO_REF;
  if (o.ref !== undefined && o.ref !== null && o.ref !== "") {
    if (typeof o.ref !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(o.ref)) throw new HttpError(400, "voucher.ref must be 0x hex (≤ 32 bytes)");
    ref = zeroPadValue(o.ref.length % 2 ? `0x0${o.ref.slice(2)}` : o.ref, 32).toLowerCase();
  }
  return { payer, payee, amount, nonce, expiry, ref };
}

/** Accepts {scheme, network, payload:{voucher, signature}} (x402 header form) or bare {voucher, signature} (SDK facilitator calls). */
export function parsePayment(raw: unknown): Payment {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "payment must be an object");
  const p = raw as Record<string, unknown>;
  const payload = (p.payload && typeof p.payload === "object" ? p.payload : p.voucher ? p : undefined) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") throw new HttpError(400, "payment.payload must be {voucher, signature}");
  const signature = payload.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < 132) throw new HttpError(400, "payload.signature must be a 0x hex signature");
  return { scheme: String(p.scheme ?? X402_SCHEME), network: String(p.network ?? X402_NETWORK), payload: { voucher: normalizeVoucher(payload.voucher), signature } };
}

/** Decodes the PAYMENT header (base64 JSON; also accepts X-PAYMENT and raw JSON). */
export function paymentFromRequest(req: FastifyRequest): Payment | null {
  const h = req.headers["payment"] ?? req.headers["x-payment"];
  if (typeof h !== "string" || !h.trim()) return null;
  let decoded: unknown;
  try {
    decoded = h.trim().startsWith("{") ? JSON.parse(h) : unb64json(h);
  } catch {
    throw new HttpError(400, "PAYMENT header is not base64 JSON");
  }
  return parsePayment(decoded);
}

export class X402Facilitator {
  readonly vault?: Contract;
  readonly vaultAddress: string | null;
  readonly enabled: boolean;
  private readonly insert;
  private readonly getVoucher;
  private readonly queued;
  private readonly pendingSum;
  private lastFlush = 0;
  private flushing = false;
  private funding: { at: number; balance: bigint | null } = { at: 0, balance: null };

  constructor(private readonly ctx: V3Context) {
    this.vaultAddress = ctx.address("x402Vault") ?? null;
    this.vault = ctx.contract("x402Vault");
    this.enabled = !!(this.vault && ctx.facilitator);
    const db = ctx.db;
    this.insert = db.prepare(
      "INSERT INTO x402_vouchers (payer, nonce, payee, amount, ref, expiry, sig, resource, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.getVoucher = db.prepare("SELECT * FROM x402_vouchers WHERE payer = ? AND nonce = ?");
    this.queued = db.prepare("SELECT * FROM x402_vouchers WHERE status = 'queued' ORDER BY createdAt ASC, rowid ASC LIMIT ?");
    this.pendingSum = db.prepare("SELECT amount FROM x402_vouchers WHERE payer = ? AND status IN ('queued','submitted')");
    this.lastFlush = ctx.now();
  }

  /** Facilitator wallet balance, cached 60 s; null when disabled or the RPC is down. */
  async facilitatorStatus(): Promise<{ address: string | null; balance: string | null; lowFunds: boolean }> {
    if (!this.ctx.facilitator) return { address: null, balance: null, lowFunds: false };
    if (this.ctx.now() - this.funding.at > 60_000) {
      const balance = await this.ctx.provider.getBalance(this.ctx.facilitator.address).catch(() => null);
      this.funding = { at: this.ctx.now(), balance };
    }
    const b = this.funding.balance;
    return { address: this.ctx.facilitator.address, balance: b === null ? null : b.toString(), lowFunds: b !== null && b < X402_FACILITATOR_MIN_WEI };
  }

  get domain(): TypedDataDomain {
    return { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN.chainId, verifyingContract: this.vaultAddress ?? "0x0000000000000000000000000000000000000000" };
  }

  async supported() {
    const funding = await this.facilitatorStatus();
    return {
      x402Version: X402_VERSION,
      kinds: [{ scheme: X402_SCHEME, network: X402_NETWORK, asset: X402_ASSET, vault: this.vaultAddress, settlement: this.enabled ? "facilitator" : "disabled", facilitator: this.ctx.facilitator?.address ?? null }],
      domain: this.domain,
      types: X402_VOUCHER_TYPES,
      batch: { everyMs: this.ctx.cfg.x402BatchMs, size: X402_BATCH_SIZE, queued: this.queuedCount() },
      voucher: { maxTimeoutSeconds: X402_MAX_TIMEOUT_S, minExpirySeconds: X402_MIN_EXPIRY_S },
      facilitatorBalance: funding.balance,
      ...(funding.lowFunds ? { warning: `facilitator ${funding.address} is low on gas (${funding.balance} wei) — settlements will stall until it is topped up` } : {}),
      ...(this.vaultAddress ? {} : DISABLED_NOT_DEPLOYED),
    };
  }

  requirement(opts: { payTo: string; amount: bigint; resource: string; description: string; mimeType?: string }): PaymentRequirement {
    return {
      scheme: X402_SCHEME,
      network: X402_NETWORK,
      asset: X402_ASSET,
      payTo: getAddress(opts.payTo),
      maxAmountRequired: opts.amount.toString(),
      resource: opts.resource,
      description: opts.description,
      mimeType: opts.mimeType ?? "application/json",
      maxTimeoutSeconds: X402_MAX_TIMEOUT_S,
      extra: { vault: this.vaultAddress, nonceHint: this.ctx.now() * 1000 + Math.floor(Math.random() * 1000), settlement: this.enabled ? "facilitator" : "disabled" },
    };
  }

  /**
   * Local checks (scheme/network, expiry, EIP-712 signature by payer, nonce
   * unseen in SQLite, optional requirement match) + on-chain vault.verify and
   * balance ≥ amount + pending when the vault is deployed.
   */
  async verify(payment: Payment, requirement?: Partial<Pick<PaymentRequirement, "payTo" | "maxAmountRequired">>): Promise<VerifyResult> {
    const v = payment.payload.voucher;
    const fail = (invalidReason: string): VerifyResult => ({ isValid: false, invalidReason, payer: v.payer, voucher: v });
    if (payment.scheme !== X402_SCHEME) return fail(`unsupported scheme "${payment.scheme}" (want ${X402_SCHEME})`);
    if (payment.network !== X402_NETWORK) return fail(`unsupported network "${payment.network}" (want ${X402_NETWORK})`);
    const nowS = this.ctx.nowS();
    if (v.expiry <= nowS) return fail("voucher expired");
    if (v.expiry < nowS + X402_MIN_EXPIRY_S) return fail(`voucher expires too soon: expiry must be ≥ now + ${X402_MIN_EXPIRY_S} s (settlement is batched)`);
    if (BigInt(v.amount) <= 0n) return fail("amount must be > 0");
    if (requirement?.payTo && getAddress(requirement.payTo) !== v.payee) return fail(`payee must be ${getAddress(requirement.payTo)}`);
    if (requirement?.maxAmountRequired && BigInt(v.amount) < BigInt(requirement.maxAmountRequired)) return fail(`amount below required ${requirement.maxAmountRequired}`);
    if (this.getVoucher.get(v.payer, v.nonce)) return fail("nonce already used");

    let sigOk = false;
    try {
      sigOk = verifyTypedData(this.domain, X402_VOUCHER_TYPES, { ...v, amount: BigInt(v.amount), nonce: BigInt(v.nonce) }, payment.payload.signature) === v.payer;
    } catch {
      sigOk = false;
    }
    if (this.vault) {
      try {
        const tuple = [v.payer, v.payee, BigInt(v.amount), BigInt(v.nonce), v.expiry, v.ref];
        if (!sigOk) {
          // ERC-1271 (AgentAccount) signatures can only be checked by the vault
          const [ok, reason] = (await this.vault.verify(tuple, payment.payload.signature)) as [boolean, string];
          if (!ok) return fail(reason || "vault.verify rejected the voucher");
          sigOk = true;
        } else {
          const [ok, reason] = (await this.vault.verify(tuple, payment.payload.signature)) as [boolean, string];
          if (!ok) return fail(reason || "vault.verify rejected the voucher");
        }
        const balance = (await this.vault.balance(v.payer)) as bigint;
        let pending = 0n;
        for (const r of this.pendingSum.all(v.payer) as Array<{ amount: string }>) pending += BigInt(r.amount);
        if (balance < pending + BigInt(v.amount)) return fail(`insufficient vault balance: ${balance} < ${pending + BigInt(v.amount)} (incl. ${pending} pending)`);
        // withdraw-before-settle: a deposit that unlocks inside the settlement horizon could be pulled before the batch lands
        const unlockAt = Number((await this.vault.unlockAt(v.payer)) as bigint);
        if (unlockAt !== 0 && unlockAt <= nowS + X402_MIN_EXPIRY_S) return fail(`payer's vault deposit unlocks at ${unlockAt} — re-lock (deposit) or wait for withdrawal before paying`);
      } catch (err) {
        if (err instanceof Error && /insufficient|rejected|expired|used/i.test(err.message)) return fail(err.message);
        return fail(`vault check failed: ${(err as Error).message.slice(0, 120)}`);
      }
    } else if (!sigOk) {
      return fail("invalid signature (EIP-712 FerminuxX402 voucher by payer)");
    }
    return { isValid: true, payer: v.payer, voucher: v };
  }

  /** Verifies and queues the voucher for batched settlement. */
  async settle(payment: Payment, resource: string, requirement?: Partial<Pick<PaymentRequirement, "payTo" | "maxAmountRequired">>): Promise<{ success: boolean; nonce: string; txHash: string | null; queued: boolean; errorReason?: string; payer: string }> {
    const res = await this.verify(payment, requirement);
    const v = payment.payload.voucher;
    if (!res.isValid) return { success: false, nonce: v.nonce, txHash: null, queued: false, errorReason: res.invalidReason, payer: v.payer };
    const status = this.vault ? "queued" : "unsettleable";
    try {
      this.insert.run(v.payer, v.nonce, v.payee, v.amount, v.ref, v.expiry, payment.payload.signature, resource.slice(0, 512), status, this.ctx.nowS());
    } catch {
      return { success: false, nonce: v.nonce, txHash: null, queued: false, errorReason: "nonce already used", payer: v.payer };
    }
    if (this.enabled && this.queuedCount() >= X402_BATCH_SIZE) void this.flush().catch(() => undefined);
    return { success: true, nonce: v.nonce, txHash: null, queued: status === "queued", payer: v.payer };
  }

  queuedCount(): number {
    return (this.ctx.db.prepare("SELECT COUNT(*) AS c FROM x402_vouchers WHERE status = 'queued'").get() as { c: number }).c;
  }

  /**
   * Rows left `submitted` by a crash / RPC hiccup between send and receipt:
   * with a mined receipt they are finalised from its logs, otherwise (after
   * X402_SUBMITTED_STALE_S) they go back to `queued` — re-settling is safe
   * because the vault skips a used nonce.
   */
  async reconcileSubmitted(): Promise<number> {
    if (!this.vault) return 0;
    const db = this.ctx.db;
    const t = this.ctx.nowS();
    const stale = db.prepare("SELECT DISTINCT txHash FROM x402_vouchers WHERE status = 'submitted' AND txHash IS NOT NULL AND settledAt IS NOT NULL AND settledAt < ?").all(t - X402_SUBMITTED_STALE_S) as Array<{ txHash: string }>;
    let fixed = 0;
    for (const { txHash } of stale) {
      const receipt = await this.ctx.provider.getTransactionReceipt(txHash).catch(() => null);
      const rows = db.prepare("SELECT * FROM x402_vouchers WHERE status = 'submitted' AND txHash = ?").all(txHash) as VoucherRow[];
      if (receipt) this.finalize(rows, txHash, receipt.status, receipt.logs);
      else for (const r of rows) db.prepare("UPDATE x402_vouchers SET status = 'queued', txHash = NULL, error = 'batch tx not found — re-queued', settledAt = NULL WHERE payer = ? AND nonce = ?").run(r.payer, r.nonce);
      fixed += rows.length;
    }
    return fixed;
  }

  /** Applies a settleBatch receipt: Skipped logs → skipped, a reverted tx → re-queued (max attempts) — never a silent `failed`. */
  private finalize(rows: VoucherRow[], txHash: string, status: number | null, logs: ReadonlyArray<{ topics: readonly string[]; data: string }>): void {
    const db = this.ctx.db;
    const t = this.ctx.nowS();
    const mark = db.prepare("UPDATE x402_vouchers SET status = ?, txHash = ?, error = ?, settledAt = ?, attempts = attempts + 1 WHERE payer = ? AND nonce = ?");
    const skipped = new Map<string, string>();
    for (const log of logs) {
      try {
        const parsed = this.vault!.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "Skipped") skipped.set(`${getAddress(parsed.args.payer)}:${(parsed.args.nonce as bigint).toString()}`, String(parsed.args.reason ?? "skipped by vault"));
      } catch {
        // not ours
      }
    }
    for (const r of rows) {
      const key = `${r.payer}:${r.nonce}`;
      if (status !== 1) {
        // the whole batch reverted (never for a bad voucher — settleBatch skips those): retry, then park as unsettleable for review
        const exhausted = r.attempts + 1 >= X402_MAX_SETTLE_ATTEMPTS;
        mark.run(exhausted ? "failed" : "queued", txHash, exhausted ? `batch reverted ${X402_MAX_SETTLE_ATTEMPTS}× — needs operator review` : "batch reverted — re-queued", exhausted ? t : null, r.payer, r.nonce);
        if (exhausted) console.error(`[x402] voucher ${key} failed ${X402_MAX_SETTLE_ATTEMPTS} settle attempts (last tx ${txHash})`);
      } else if (skipped.has(key)) mark.run("skipped", txHash, skipped.get(key)!, t, r.payer, r.nonce);
      else mark.run("settled", txHash, null, t, r.payer, r.nonce);
    }
  }

  /** Pushes up to 50 queued vouchers on-chain with settleBatch (FACILITATOR_KEY). */
  async flush(): Promise<{ submitted: number; txHash: string | null }> {
    if (!this.enabled || !this.vault || !this.ctx.facilitator || this.flushing) return { submitted: 0, txHash: null };
    this.flushing = true;
    const db = this.ctx.db;
    try {
      await this.reconcileSubmitted();
      const t0 = this.ctx.nowS();
      // vouchers the vault would skip anyway (expired while queued) — don't spend gas on them
      db.prepare("UPDATE x402_vouchers SET status = 'skipped', error = 'expired before settlement', settledAt = ? WHERE status = 'queued' AND expiry <= ?").run(t0, t0);
      const rows = this.queued.all(X402_BATCH_SIZE) as VoucherRow[];
      if (!rows.length) return { submitted: 0, txHash: null };
      const vs = rows.map((r) => [r.payer, r.payee, BigInt(r.amount), BigInt(r.nonce), r.expiry, r.ref]);
      const sigs = rows.map((r) => r.sig);
      const signer = this.vault.connect(this.ctx.facilitator) as Contract;
      const mark = db.prepare("UPDATE x402_vouchers SET status = ?, txHash = ?, error = ?, settledAt = ? WHERE payer = ? AND nonce = ?");
      let tx;
      try {
        tx = await signer.settleBatch(vs, sigs);
      } catch (err) {
        const msg = (err as Error).message.slice(0, 200);
        for (const r of rows) mark.run("queued", null, msg, null, r.payer, r.nonce);
        const funds = await this.facilitatorStatus();
        console.error(`[x402] settleBatch send failed${funds.lowFunds ? ` — FACILITATOR ${funds.address} IS OUT OF GAS (${funds.balance} wei)` : ""}:`, msg);
        return { submitted: 0, txHash: null };
      }
      // settledAt doubles as the submit time while `submitted` (reconcileSubmitted uses it for staleness)
      for (const r of rows) mark.run("submitted", tx.hash, null, this.ctx.nowS(), r.payer, r.nonce);
      let receipt;
      try {
        receipt = await tx.wait(1);
      } catch (err) {
        // ethers throws on a reverted tx (CALL_EXCEPTION with the receipt attached): finalise from it right away
        const attached = (err as { receipt?: { status: number | null; logs: ReadonlyArray<{ topics: readonly string[]; data: string }> } }).receipt;
        if (attached) {
          this.finalize(rows, tx.hash, attached.status ?? 0, attached.logs ?? []);
          return { submitted: rows.length, txHash: tx.hash };
        }
        // receipt unknown (dropped / replaced / RPC timeout): left `submitted`, reconcileSubmitted() settles it next tick
        console.error("[x402] settleBatch wait failed:", (err as Error).message.slice(0, 200));
        return { submitted: rows.length, txHash: tx.hash };
      }
      this.finalize(rows, tx.hash, receipt?.status ?? null, receipt?.logs ?? []);
      return { submitted: rows.length, txHash: tx.hash };
    } finally {
      this.flushing = false;
      this.lastFlush = this.ctx.now();
    }
  }

  start(intervalMs: number): () => void {
    if (!this.enabled) return () => undefined;
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      try {
        await this.flush();
      } catch (err) {
        console.error("[x402] flush failed:", err);
      }
    };
    const handle = setInterval(run, intervalMs);
    handle.unref?.();
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }

  async payerView(address: string) {
    const addr = getAddress(address);
    let balance: string | null = null;
    let unlockAt: number | null = null;
    if (this.vault) {
      try {
        balance = ((await this.vault.balance(addr)) as bigint).toString();
        unlockAt = Number((await this.vault.unlockAt(addr)) as bigint);
      } catch {
        // RPC down: leave nulls
      }
    }
    const rows = this.ctx.db.prepare("SELECT payer, nonce, payee, amount, ref, expiry, resource, status, txHash, error, createdAt, settledAt FROM x402_vouchers WHERE payer = ? ORDER BY createdAt DESC LIMIT 200").all(addr) as Array<Omit<VoucherRow, "sig">>;
    const pending = rows.filter((r) => r.status === "queued" || r.status === "submitted");
    let pendingWei = 0n;
    for (const r of pending) pendingWei += BigInt(r.amount);
    const settled = this.ctx.db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM x402_settlements WHERE payer = ?").get(addr) as { c: number; s: number };
    return { address: addr, vault: this.vaultAddress, balance, unlockAt, pendingWei: pendingWei.toString(), pending, settledCount: settled.c, vouchers: rows, ...(this.vaultAddress ? {} : DISABLED_NOT_DEPLOYED) };
  }

  /** Sends a 402 with the requirement in the PAYMENT-REQUIRED header and the JSON body. */
  send402(reply: FastifyReply, requirement: PaymentRequirement, error?: string): void {
    const body = { x402Version: X402_VERSION, accepts: [requirement], ...(error ? { error } : {}) };
    reply.code(402);
    reply.header("payment-required", b64json(body));
    reply.header("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    void reply.send(body);
  }

  /**
   * Charges the request: returns PaidInfo (and sets PAYMENT-RESPONSE) when
   * paid or free, or null after replying 402. Callers use it inside handlers
   * that need to decide about payment themselves (A2A jobId bypass);
   * `priced()` wraps it as a preHandler.
   */
  async charge(req: FastifyRequest, reply: FastifyReply, opts: PricedOptions): Promise<PaidInfo | null> {
    const amount = await opts.amount(req);
    if (amount === null || amount <= 0n) {
      req.x402 = { free: true, payer: null, nonce: null, amount: "0", payee: null };
      return req.x402;
    }
    const payTo = opts.payTo(req);
    if (!payTo) {
      req.x402 = { free: true, payer: null, nonce: null, amount: "0", payee: null };
      return req.x402;
    }
    const resource = opts.resource ? opts.resource(req) : `${this.ctx.cfg.publicUrl.replace(/\/+$/, "")}${req.url}`;
    const description = typeof opts.description === "function" ? opts.description(req) : (opts.description ?? "Ferminux x402 priced resource");
    const requirement = this.requirement({ payTo, amount, resource, description, mimeType: opts.mimeType });
    let payment: Payment | null;
    try {
      payment = paymentFromRequest(req);
    } catch (err) {
      this.send402(reply, requirement, err instanceof HttpError ? err.message : "bad PAYMENT header");
      return null;
    }
    if (!payment) {
      this.send402(reply, requirement);
      return null;
    }
    const res = await this.settle(payment, resource, { payTo: requirement.payTo, maxAmountRequired: requirement.maxAmountRequired });
    if (!res.success) {
      this.send402(reply, requirement, res.errorReason ?? "payment rejected");
      return null;
    }
    const response = { success: true, txHash: res.txHash, nonce: res.nonce, payer: res.payer };
    reply.header("payment-response", b64json(response));
    reply.header("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    req.x402 = { free: false, payer: res.payer, nonce: res.nonce, amount: payment.payload.voucher.amount, payee: requirement.payTo };
    return req.x402;
  }

  /** Fastify preHandler: 402 until a valid voucher for `amount` to `payTo` arrives. */
  priced(opts: PricedOptions): preHandlerHookHandler {
    return async (req, reply) => {
      const paid = await this.charge(req, reply, opts);
      if (!paid) return reply;
      return undefined;
    };
  }
}

export function registerX402Routes(app: FastifyInstance, ctx: V3Context, fac: X402Facilitator): void {
  const { sendError } = ctx.commons;
  const rl = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  app.get("/api/x402/supported", async () => fac.supported());

  app.post("/api/x402/verify", rl, async (req, reply) => {
    try {
      const body = ctx.commons.parseJson(req);
      const payment = parsePayment(body.payment ?? body.paymentPayload ?? body);
      const requirement = (body.paymentRequirements ?? body.requirement) as Partial<PaymentRequirement> | undefined;
      const res = await fac.verify(payment, requirement && typeof requirement === "object" ? requirement : undefined);
      return { isValid: res.isValid, ok: res.isValid, ...(res.invalidReason ? { invalidReason: res.invalidReason, reason: res.invalidReason } : {}), payer: res.payer ?? null, vault: fac.vaultAddress, settlement: fac.enabled ? "facilitator" : "disabled", ...(fac.vaultAddress ? {} : { disabled: true, disabledReason: "not deployed" }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/x402/settle", rl, async (req, reply) => {
    try {
      const body = ctx.commons.parseJson(req);
      const payment = parsePayment(body.payment ?? body.paymentPayload ?? body);
      const requirement = (body.paymentRequirements ?? body.requirement) as Partial<PaymentRequirement> | undefined;
      const resource = typeof requirement?.resource === "string" ? requirement.resource : typeof body.resource === "string" ? body.resource : "";
      const res = await fac.settle(payment, resource, requirement && typeof requirement === "object" ? requirement : undefined);
      reply.header("payment-response", b64json({ success: res.success, txHash: res.txHash, nonce: res.nonce }));
      return { ...res, network: X402_NETWORK, settlement: fac.enabled ? "facilitator" : "disabled", ...(fac.vaultAddress ? {} : { disabled: true, disabledReason: "not deployed" }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { addr: string } }>("/api/x402/payer/:addr", async (req, reply) => {
    try {
      let addr: string;
      try {
        addr = getAddress(req.params.addr);
      } catch {
        throw new HttpError(400, "addr must be a 0x address");
      }
      return await fac.payerView(addr);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
