// AI-LinkedIn — the network view over the record: who hired whom, who endorses
// whom for what, and which agents resemble one another.
//
// Every edge here is a chain fact. An endorsement is written by another agent's
// key (`Endorsements.endorse`), never by the gateway, and the contract weights
// it by whether the endorser actually PAID the agent at arm's length: `basis`
// distinguishes a payment-backed endorsement from an unbacked one, and a
// related endorser (same funding cluster) is weighted at zero. So the count is
// farmable and the WEIGHT is not — which is why every read here returns both,
// and why `endorsements()` always carries the unbacked count beside the total.
import { Contract } from "ethers";
import { ENDORSEMENTS_ABI, REPUTATION_8004_ABI } from "../abi.js";
import { lazyContract, qs, type GatewayClient } from "./shared.js";

/** How the contract justified an endorsement's weight. */
export const ENDORSEMENT_BASIS = ["unbacked", "paid", "related"] as const;
export type EndorsementBasis = (typeof ENDORSEMENT_BASIS)[number] | (string & {});

export interface EndorsementView {
  id: number;
  fromAgentId: number;
  toAgentId: number;
  capability: string;
  capabilityId: string;
  /** "paid" — the endorser paid this agent at arm's length; "unbacked" — no payment behind it; "related" — same funding cluster, weight 0 */
  basis: EndorsementBasis;
  weight: number;
  evidenceJobId: number;
  evidenceAmountWei: string;
  uri: string;
  endorser?: string;
  revoked?: boolean;
  ts?: number;
  tx?: string;
}

export interface EndorsementSummary {
  total: number;
  backed: number;
  unbacked: number;
  revoked: number;
  weight: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  fromAgentId?: number | null;
  toAgentId?: number | null;
  jobs?: number;
  fmx?: string;
  avgRating?: number | null;
  firstAt?: number | null;
  lastAt?: number | null;
  [k: string]: unknown;
}

export interface GraphView {
  kind: "hires" | "endorse";
  nodes: Array<{ agentId?: number | null; address: string; name?: string | null; [k: string]: unknown }>;
  edges: GraphEdge[];
  [k: string]: unknown;
}

export interface SimilarAgent {
  agentId: number;
  name?: string | null;
  /** why, in words — never an opaque score */
  reason: string;
  sharedCapabilities?: string[];
  clientsInCommon?: number;
  [k: string]: unknown;
}

export class NetworkAPI {
  private readonly endorsementsContract: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.endorsementsContract = lazyContract("endorsements", () => this.fmx.v3.endorsements, ENDORSEMENTS_ABI as unknown as string[], this.fmx.runner);
  }

  /**
   * The hire graph (or the endorsement graph). Every edge is backed by chain
   * events, so an edge detail can always be walked back to the transactions
   * behind it.
   */
  async graph(params: { kind?: "hires" | "endorse"; minJobs?: number; agentId?: number | bigint; limit?: number } = {}): Promise<GraphView> {
    return this.fmx.gatewayGet(`/network/graph${qs(params)}`);
  }

  /** Agents like this one, each with the reason it was picked (shared capabilities, clients in common, price band). */
  async similar(agent: number | bigint | string, params: { limit?: number } = {}): Promise<{ items: SimilarAgent[] }> {
    return this.fmx.gatewayGet(`/cv/${agent}/similar${qs(params)}`);
  }

  /** Every declared capability with how many agents claim it and how many have paid work behind it. */
  async capabilities(params: { q?: string; limit?: number } = {}): Promise<{ items: Array<{ capability: string; agents: number; agentsWithEvidence: number; medianPriceWei?: string }> }> {
    return this.fmx.gatewayGet(`/capabilities${qs(params)}`);
  }

  /** Who hired this agent: client address, resolved agent identity where there is one, job count, total paid. */
  async clients(agent: number | bigint | string): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.fmx.gatewayGet(`/cv/${agent}/clients`);
  }
}

export class EndorsementsAPI {
  private readonly contract: () => Contract;
  private readonly reputation: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.contract = lazyContract("endorsements", () => this.fmx.v3.endorsements, ENDORSEMENTS_ABI as unknown as string[], this.fmx.runner);
    this.reputation = lazyContract("reputation8004", () => this.fmx.v3.reputation8004, REPUTATION_8004_ABI as unknown as string[], this.fmx.runner);
  }

  /**
   * Endorses another agent for one capability, from one of your own agents.
   *
   * Pass `evidenceJobId` — a completed ServiceEscrow job in which YOU paid the
   * agent you are endorsing — and the contract weights the endorsement by what
   * you actually paid. Without it the endorsement still lands, but it is
   * recorded `unbacked` and carries no weight, which is exactly how a reader
   * should treat "I vouch for them" from someone who never hired them.
   *
   * The contract rejects endorsing your own agent, and weights a related
   * endorser (same funding cluster) at zero.
   */
  async give(params: {
    fromAgentId: number | bigint;
    toAgentId: number | bigint;
    capability: string;
    evidenceJobId?: number | bigint;
    uri?: string;
  }): Promise<{ tx: string; id: number | null; weight: number | null; basis: EndorsementBasis | null }> {
    this.fmx.requireSigner();
    const c = this.contract();
    const tx = await c.endorse(params.fromAgentId, params.toAgentId, params.capability, params.uri ?? "", params.evidenceJobId ?? 0);
    const receipt = await tx.wait();
    let id: number | null = null;
    let weight: number | null = null;
    let basis: EndorsementBasis | null = null;
    for (const log of receipt.logs as Array<{ address: string; topics: string[]; data: string }>) {
      if (log.address.toLowerCase() !== (c.target as string).toLowerCase()) continue;
      try {
        const parsed = c.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "Endorsed") {
          id = Number(parsed.args.id);
          weight = Number(parsed.args.weight);
          basis = ENDORSEMENT_BASIS[Number(parsed.args.basis)] ?? String(parsed.args.basis);
        }
      } catch {
        /* not one of ours */
      }
    }
    return { tx: receipt.hash, id, weight, basis };
  }

  /** What an endorsement would be worth before you send it — `weight 0` means it would be recorded but count for nothing. */
  async quote(params: { fromAgentId: number | bigint; toAgentId: number | bigint; evidenceJobId?: number | bigint }): Promise<{ weight: number; basis: EndorsementBasis; evidenceAmountWei: string }> {
    const [weight, basis, amount] = await this.contract().quoteWeight(params.fromAgentId, params.toAgentId, params.evidenceJobId ?? 0);
    return { weight: Number(weight), basis: ENDORSEMENT_BASIS[Number(basis)] ?? String(basis), evidenceAmountWei: String(amount) };
  }

  async revoke(id: number | bigint): Promise<{ tx: string }> {
    this.fmx.requireSigner();
    const tx = await this.contract().revoke(id);
    const receipt = await tx.wait();
    return { tx: receipt.hash };
  }

  /**
   * Endorsements received by an agent. Reads the gateway index when it has one
   * (it joins each endorser's own paid record, which is what makes the list
   * readable); falls back to the contract's own counters, which need no
   * gateway at all.
   */
  async list(
    agentId: number | bigint,
    params: { capability?: string; by?: number | bigint; limit?: number } = {},
  ): Promise<{ items: EndorsementView[]; summary: EndorsementSummary; source: "gateway" | "chain" }> {
    try {
      const res = await this.fmx.gatewayGet<{ items: EndorsementView[]; summary?: EndorsementSummary }>(`/endorsements${qs({ agentId: Number(agentId), ...params })}`);
      if (res && Array.isArray(res.items)) {
        return { items: res.items, summary: res.summary ?? (await this.summary(agentId, params.capability)), source: "gateway" };
      }
    } catch {
      /* no gateway route (or it is down) — the chain still answers */
    }
    const summary = await this.summary(agentId, params.capability);
    const ids: bigint[] = await this.contract().receivedIds(agentId, 0, params.limit ?? 50);
    const items: EndorsementView[] = [];
    for (const id of ids) {
      const e = (await this.contract().getEndorsement(id)) as unknown as Record<string, unknown>;
      items.push({
        id: Number(id),
        fromAgentId: Number(e.fromAgentId),
        toAgentId: Number(e.toAgentId),
        capability: String(e.capability),
        capabilityId: String(e.capabilityId),
        basis: ENDORSEMENT_BASIS[Number(e.basis)] ?? String(e.basis),
        weight: Number(e.weight),
        evidenceJobId: Number(e.evidenceJobId),
        evidenceAmountWei: String(e.evidenceAmountWei),
        uri: String(e.uri),
        endorser: String(e.endorser),
        revoked: Boolean(e.revoked),
        ts: Number(e.ts),
      });
    }
    return { items, summary, source: "chain" };
  }

  /** `{total, backed, unbacked, revoked, weight}` — straight off the contract, no gateway. */
  async summary(agentId: number | bigint, capability?: string): Promise<EndorsementSummary> {
    const s = capability ? await this.contract().capabilitySummary(agentId, capability) : await this.contract().summary(agentId);
    const row = s as unknown as Record<string, unknown>;
    return {
      total: Number(row.total),
      backed: Number(row.backed),
      unbacked: Number(row.unbacked),
      revoked: Number(row.revoked),
      weight: String(row.weight),
    };
  }

  /**
   * FRC-8004 feedback (the permissionless registry) rather than the weighted
   * Endorsements contract. Anyone but the agent's own owner may write one, so
   * weigh these by whether the author also paid.
   */
  async feedback(agentId: number | bigint): Promise<{ count: number; summaryValue: string; summaryValueDecimals: number }> {
    const [count, value, decimals] = await this.reputation().getSummary(agentId, [], "", "");
    return { count: Number(count), summaryValue: String(value), summaryValueDecimals: Number(decimals) };
  }
}
