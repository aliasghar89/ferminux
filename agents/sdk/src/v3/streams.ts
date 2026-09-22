// Addendum v3 — C3 StreamPay: per-second payment streams + subscription plans
// (SPEC.md "## C3", "## S.").
import type { Contract } from "ethers";
import { STREAM_PAY_ABI } from "../abi.js";
import { findEventArgs, lazyContract, toWei, type AmountLike, type GatewayClient } from "./shared.js";

export class StreamsAPI {
  private readonly contract: () => Contract;
  readonly plans: PlansAPI;

  constructor(private readonly fmx: GatewayClient) {
    this.contract = lazyContract("streamPay", () => this.fmx.v3.streamPay, STREAM_PAY_ABI, this.fmx.runner);
    this.plans = new PlansAPI(fmx, this.contract);
  }

  /** Opens a stream to `payee` at `ratePerSec` FMX/second; `deposit` funds it upfront. */
  async open(params: { payee: string; ratePerSec: AmountLike; deposit: AmountLike }): Promise<{ id: number; tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().openStream(params.payee, toWei(params.ratePerSec), { value: toWei(params.deposit) });
    const receipt = await tx.wait();
    const args = findEventArgs(this.contract(), receipt, "StreamOpened");
    if (!args) throw new Error("Ferminux: StreamOpened event not found in receipt");
    return { id: Number(args.id as bigint), tx: receipt.hash };
  }

  async topUp(id: number | bigint, amount: AmountLike): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().topUp(id, { value: toWei(amount) });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Payer or payee; settles accrued FMX to the payee's credits, remainder back to the payer's. */
  async cancel(id: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().cancelStream(id);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async claimable(id: number | bigint): Promise<bigint> {
    return this.contract().claimable(id);
  }

  /** Payee: moves the accrued amount to `credits` (pull via `fmx.withdraw`-style `streams.withdraw()`). */
  async claim(id: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().claimStream(id);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async get(id: number | bigint): Promise<{ payer: string; payee: string; ratePerSec: bigint; deposit: bigint; withdrawn: bigint; start: bigint; stop: bigint; cancelled: boolean }> {
    return this.contract().getStream(id);
  }

  async credits(address?: string): Promise<bigint> {
    const addr = address ?? this.fmx.requireSigner().address;
    return this.contract().credits(addr);
  }

  async withdraw(): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().withdraw();
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }
}

export class PlansAPI {
  constructor(
    private readonly fmx: GatewayClient,
    private readonly contract: () => Contract,
  ) {}

  async create(params: { pricePerPeriod: AmountLike; period: number; metadataURI?: string }): Promise<{ planId: number; tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().createPlan(toWei(params.pricePerPeriod), params.period, params.metadataURI ?? "");
    const receipt = await tx.wait();
    const args = findEventArgs(this.contract(), receipt, "PlanCreated");
    if (!args) throw new Error("Ferminux: PlanCreated event not found in receipt");
    return { planId: Number(args.planId as bigint), tx: receipt.hash };
  }

  async setActive(planId: number | bigint, active: boolean): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().setPlanActive(planId, active);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async get(planId: number | bigint): Promise<{ payee: string; pricePerPeriod: bigint; period: bigint; active: boolean; metadataURI: string }> {
    return this.contract().getPlan(planId);
  }

  async subscribe(params: { planId: number | bigint; periods: number }): Promise<{ subId: number; tx: string }> {
    this.fmx.requireSigner();
    const plan = await this.get(params.planId);
    const value = (plan.pricePerPeriod as bigint) * BigInt(params.periods);
    const tx = await this.contract().subscribe(params.planId, params.periods, { value });
    const receipt = await tx.wait();
    const args = findEventArgs(this.contract(), receipt, "Subscribed");
    if (!args) throw new Error("Ferminux: Subscribed event not found in receipt");
    return { subId: Number(args.subId as bigint), tx: receipt.hash };
  }

  async renew(subId: number | bigint, periods: number): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const sub = await this.getSub(subId);
    const plan = await this.get(sub.planId);
    const value = (plan.pricePerPeriod as bigint) * BigInt(periods);
    const tx = await this.contract().renew(subId, periods, { value });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async cancel(subId: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().cancelSub(subId);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Payee: moves due periods to `credits`. */
  async claim(subId: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().claimSub(subId);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async getSub(subId: number | bigint): Promise<{ planId: bigint; payer: string; paidThrough: bigint; cancelled: boolean; prepaid: bigint }> {
    return this.contract().getSub(subId);
  }

  async isSubscribed(planId: number | bigint, payer?: string): Promise<boolean> {
    const addr = payer ?? this.fmx.address;
    if (!addr) throw new Error("Ferminux: no payer given and no signer configured");
    return this.contract().isSubscribed(planId, addr);
  }
}
