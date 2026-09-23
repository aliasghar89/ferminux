// Addendum v3 — C5 FRC-8004 adapters: ReputationRegistry8004 + ValidationRegistry8004
// (SPEC.md "## C5", "## S."). IdentityRegistry8004 is exposed read-only through
// `fmx.identity8004Contract()` — most identity data is already served by the
// gateway's regular agent views and `/api/agents/:id/erc8004.json`.
import { Contract } from "ethers";
import { IDENTITY_8004_ABI, REPUTATION_8004_ABI, VALIDATION_8004_ABI } from "../abi.js";
import { lazyContract, type GatewayClient } from "./shared.js";

export class ReputationAPI {
  private readonly contract: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.contract = lazyContract("reputation8004", () => this.fmx.v3.reputation8004, REPUTATION_8004_ABI, this.fmx.runner);
  }

  /** Any address except the agent owner may give feedback. `value`/`valueDecimals` follow FRC-8004 (e.g. value=450, valueDecimals=2 → 4.50). */
  async giveFeedback(params: {
    agentId: number | bigint;
    value: number | bigint;
    valueDecimals?: number;
    tag1?: string;
    tag2?: string;
    endpoint?: string;
    feedbackURI?: string;
    feedbackHash?: string;
  }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().giveFeedback(
      params.agentId,
      params.value,
      params.valueDecimals ?? 0,
      params.tag1 ?? "",
      params.tag2 ?? "",
      params.endpoint ?? "",
      params.feedbackURI ?? "",
      params.feedbackHash ?? "0x" + "00".repeat(32),
    );
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Imports a completed ServiceEscrow job's rating (1..5 → value, decimals 0, tag1="escrow") — anyone, once per job. */
  async syncFromEscrow(jobId: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().syncFromEscrow(jobId);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Feedback is indexed per (agentId, clientAddress); `feedbackIndex` is that client's Nth entry (from syncFromEscrow's return or an event). */
  async readFeedback(
    agentId: number | bigint,
    clientAddress: string,
    feedbackIndex: number | bigint,
  ): Promise<{ value: bigint; valueDecimals: number; tag1: string; tag2: string; isRevoked: boolean }> {
    const [value, valueDecimals, tag1, tag2, isRevoked] = await this.contract().readFeedback(agentId, clientAddress, feedbackIndex);
    return { value, valueDecimals: Number(valueDecimals), tag1, tag2, isRevoked };
  }

  /** `clientAddresses: []` = no filter (all clients); `tag1`/`tag2: ""` = no filter. */
  async readAllFeedback(
    agentId: number | bigint,
    params: { clientAddresses?: string[]; tag1?: string; tag2?: string; includeRevoked?: boolean } = {},
  ): Promise<Array<{ client: string; feedbackIndex: bigint; value: bigint; valueDecimals: number; tag1: string; tag2: string; revoked: boolean }>> {
    const [clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s, revokedStatuses] = await this.contract().readAllFeedback(
      agentId,
      params.clientAddresses ?? [],
      params.tag1 ?? "",
      params.tag2 ?? "",
      params.includeRevoked ?? true,
    );
    return (clients as string[]).map((client, i) => ({
      client,
      feedbackIndex: feedbackIndexes[i],
      value: values[i],
      valueDecimals: Number(valueDecimals[i]),
      tag1: tag1s[i],
      tag2: tag2s[i],
      revoked: revokedStatuses[i],
    }));
  }

  /** `clientAddresses: []` = aggregate across all clients; `tag1`/`tag2: ""` = no filter. */
  async summary(
    agentId: number | bigint,
    params: { clientAddresses?: string[]; tag1?: string; tag2?: string } = {},
  ): Promise<{ count: bigint; summaryValue: bigint; summaryValueDecimals: number }> {
    const [count, summaryValue, summaryValueDecimals] = await this.contract().getSummary(
      agentId,
      params.clientAddresses ?? [],
      params.tag1 ?? "",
      params.tag2 ?? "",
    );
    return { count, summaryValue, summaryValueDecimals: Number(summaryValueDecimals) };
  }

  async clients(agentId: number | bigint): Promise<string[]> {
    return this.contract().getClients(agentId);
  }

  async lastIndex(agentId: number | bigint, clientAddress: string): Promise<bigint> {
    return this.contract().getLastIndex(agentId, clientAddress);
  }

  async revokeFeedback(agentId: number | bigint, feedbackIndex: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().revokeFeedback(agentId, feedbackIndex);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async appendResponse(params: {
    agentId: number | bigint;
    clientAddress: string;
    feedbackIndex: number | bigint;
    responseURI: string;
    responseHash?: string;
  }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().appendResponse(
      params.agentId,
      params.clientAddress,
      params.feedbackIndex,
      params.responseURI,
      params.responseHash ?? "0x" + "00".repeat(32),
    );
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }
}

export class ValidationAPI {
  private readonly contract: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.contract = lazyContract("validation8004", () => this.fmx.v3.validation8004, VALIDATION_8004_ABI, this.fmx.runner);
  }

  /** Requests a validation for `agentId` from `validator` (e.g. the network's Oracle agent). */
  async request(params: { validator: string; agentId: number | bigint; requestURI: string; requestHash?: string }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().validationRequest(params.validator, params.agentId, params.requestURI, params.requestHash ?? "0x" + "00".repeat(32));
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /** Only the named validator may respond; `response` is 0..100. */
  async respond(params: { requestHash: string; response: number; responseURI?: string; responseHash?: string; tag?: string }): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().validationResponse(
      params.requestHash,
      params.response,
      params.responseURI ?? "",
      params.responseHash ?? "0x" + "00".repeat(32),
      params.tag ?? "",
    );
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  async status(requestHash: string): Promise<unknown> {
    return this.contract().getValidationStatus(requestHash);
  }

  /** `validatorAddresses: []` = aggregate across all validators; `tag: ""` = no filter. */
  async summary(agentId: number | bigint, params: { validatorAddresses?: string[]; tag?: string } = {}): Promise<{ count: bigint; avgResponse: number }> {
    const [count, avgResponse] = await this.contract().getSummary(agentId, params.validatorAddresses ?? [], params.tag ?? "");
    return { count, avgResponse: Number(avgResponse) };
  }

  async agentValidations(agentId: number | bigint): Promise<string[]> {
    return this.contract().getAgentValidations(agentId);
  }

  async validatorRequests(validator: string): Promise<string[]> {
    return this.contract().getValidatorRequests(validator);
  }
}

/** IdentityRegistry8004 — read/write helper kept as a plain lazy Contract accessor (small surface). */
export function identityContract(fmx: GatewayClient): () => Contract {
  return lazyContract("identity8004", () => fmx.v3.identity8004, IDENTITY_8004_ABI, fmx.runner);
}
