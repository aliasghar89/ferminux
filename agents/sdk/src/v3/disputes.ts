// Addendum v3 — C4 ArbiterPool: disputes for ServiceEscrow (SPEC.md "## C4", "## S.").
import type { Contract } from "ethers";
import { ARBITER_POOL_ABI } from "../abi.js";
import { findEventArgs, lazyContract, toWei, type AmountLike, type GatewayClient } from "./shared.js";

export interface CaseView {
  jobId: bigint;
  opener: string;
  evidenceURI: string;
  openedAt: bigint;
  result: number;
  votes: number;
  closed: boolean;
}

export class DisputesAPI {
  private readonly contract: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.contract = lazyContract("arbiterPool", () => this.fmx.v3.arbiterPool, ARBITER_POOL_ABI, this.fmx.runner);
  }

  async joinPool(stake: AmountLike): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().joinPool({ value: toWei(stake) });
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async leavePool(): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().leavePool();
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Opens a dispute case for a `Disputed` ServiceEscrow job; fee 1 FMX (msg.value) → pool rewards. */
  async openCase(params: { jobId: number | bigint; evidenceURI: string; fee?: AmountLike }): Promise<{ caseId: number; tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().openCase(params.jobId, params.evidenceURI, { value: toWei(params.fee ?? 1) });
    const receipt = await tx.wait();
    const args = findEventArgs(this.contract(), receipt, "CaseOpened");
    if (!args) throw new Error("Ferminux: CaseOpened event not found in receipt");
    return { caseId: Number(args.caseId as bigint), tx: receipt.hash };
  }

  async submitEvidence(caseId: number | bigint, uri: string): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().submitEvidence(caseId, uri);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Staked arbiter votes once; `clientBps` = 0..10000 share of the job amount going to the client. */
  async vote(caseId: number | bigint, clientBps: number): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().vote(caseId, clientBps);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Closes a case (quorum reached or the voting window elapsed) and calls `escrow.resolve`. */
  async close(caseId: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().close(caseId);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async get(caseId: number | bigint): Promise<CaseView> {
    const c = await this.contract().getCase(caseId);
    return { jobId: c.jobId, opener: c.opener, evidenceURI: c.evidenceURI, openedAt: c.openedAt, result: Number(c.result), votes: Number(c.votes), closed: c.closed };
  }

  async evidence(caseId: number | bigint): Promise<string[]> {
    return this.contract().getEvidence(caseId);
  }

  async voters(caseId: number | bigint): Promise<string[]> {
    return this.contract().getVoters(caseId);
  }

  async voteOf(caseId: number | bigint, arbiter: string): Promise<{ cast: boolean; clientBps: number }> {
    const [cast, clientBps] = await this.contract().getVote(caseId, arbiter);
    return { cast, clientBps: Number(clientBps) };
  }

  async stakeOf(arbiter?: string): Promise<bigint> {
    const addr = arbiter ?? this.fmx.address;
    if (!addr) throw new Error("Ferminux: no arbiter given and no signer configured");
    return this.contract().stake(addr);
  }

  /** Pull-payment credits (arbiter reward split from a closed case). */
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

  async params(): Promise<{ minStake: bigint; votingWindow: bigint; quorum: number }> {
    const [minStake, votingWindow, quorum] = await Promise.all([this.contract().minStake(), this.contract().votingWindow(), this.contract().quorum()]);
    return { minStake, votingWindow, quorum: Number(quorum) };
  }

  /** Gateway-indexed case list (dispute UI), read-only. */
  async list(params: { jobId?: number; open?: boolean; limit?: number } = {}): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.jobId != null) q.set("jobId", String(params.jobId));
    if (params.open != null) q.set("open", params.open ? "1" : "0");
    if (params.limit != null) q.set("limit", String(params.limit));
    const str = q.toString();
    return this.fmx.gatewayGet(`/disputes${str ? `?${str}` : ""}`);
  }
}
