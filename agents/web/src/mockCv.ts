// Demo fixtures for /cv/ and /network/ — only loaded when VITE_MOCK=1 (dynamically imported from
// src/cv.ts so the chunk never reaches a production build). Shapes match what the gateway's
// /api/agents/:id/audit.jsonl and ReputationRegistry8004 return, so the pages exercise exactly the
// same assembly code they run against the live chain.
import { keccak256, toUtf8Bytes, parseEther } from "ethers";
import { AGENTS, JOBS } from "./mock";
import { slugify } from "./economy";
import type { AgentView, CvAnchor, CvEndorsement, NetEdge, NetKind, NetNode, NetView } from "./types";
import type { AuditFooter, AuditLine } from "./cv";
import { agentStatusName } from "./api";

const now = Math.floor(Date.now() / 1000);
const E = (n: string) => parseEther(n).toString();
const T = (s: string) => keccak256(toUtf8Bytes(s));
const delay = <T,>(v: T, ms = 200) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export function agentFor(param: string): Promise<AgentView> {
  const s = param.trim();
  const a = /^\d+$/.test(s) ? AGENTS.find((x) => x.id === Number(s)) : AGENTS.find((x) => slugify(x.name) === slugify(s));
  return a ? delay(a) : Promise.reject(Object.assign(new Error("Not found."), { status: 404 }));
}

export function audit(agentId: number): Promise<{ lines: AuditLine[]; footer: AuditFooter | null }> {
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a) return delay({ lines: [], footer: null });
  const lines: AuditLine[] = [];
  let seq = 0;
  const push = (l: Omit<AuditLine, "seq">) => lines.push({ seq: ++seq, ...l });

  push({ kind: "chain", ts: Number(a.registeredAt), block: 349216 + agentId, contract: "registry", event: "AgentRegistered", tx: T(`reg${agentId}`), logIndex: 0, args: { id: String(agentId), owner: a.owner, name: a.name, endpoint: a.endpoint, pricePerJob: a.pricePerJob, bond: a.bond } });
  push({ kind: "chain", ts: Number(a.registeredAt), block: 349216 + agentId, contract: "registry", event: "BondChanged", tx: T(`reg${agentId}`), logIndex: 2, args: { id: String(agentId), bond: a.bond } });

  for (const j of JOBS.filter((x) => x.agentId === agentId)) {
    const st = String(j.status);
    push({ kind: "chain", ts: Number(j.createdAt), block: 360000 + j.id, contract: "escrow", event: "JobRequested", tx: j.tx?.requested || T(`req${j.id}`), logIndex: 0, args: { jobId: String(j.id), agentId: String(agentId), client: j.client, amount: String(j.amount) } });
    if (j.deliveredAt) push({ kind: "chain", ts: Number(j.deliveredAt), block: 360001 + j.id, contract: "escrow", event: "JobDelivered", tx: j.tx?.delivered || T(`del${j.id}`), logIndex: 0, args: { jobId: String(j.id), outputHash: j.outputHash || "" } });
    if (st === "Completed") {
      const amount = BigInt(String(j.amount));
      const fee = (amount * 250n) / 10000n;
      push({ kind: "chain", ts: Number(j.deliveredAt) + 600, block: 360002 + j.id, contract: "escrow", event: "JobCompleted", tx: j.tx?.closed || T(`cls${j.id}`), logIndex: 0, args: { jobId: String(j.id), agentPayout: (amount - fee).toString(), fee: fee.toString(), rating: String(4 + (j.id % 2)) } });
    }
  }

  // x402: two settled calls in, one paid out to another agent — the counterparty graph is part of the record.
  if (a.jobsCompleted > 0) {
    for (const i of [1, 2]) {
      push({ kind: "x402", ts: now - i * 7200, event: "Voucher", payer: JOBS[0].client, nonce: String(1790016795583094 + i), payee: a.owner, amount: E("0.01"), resource: `${a.endpoint}/invoke`, status: "settled" });
      push({ kind: "chain", ts: now - i * 7200 + 30, block: 380000 + i, contract: "x402Vault", event: "Settled", tx: T(`x402in${agentId}${i}`), logIndex: 0, args: { payer: JOBS[0].client, payee: a.owner, amount: E("0.01"), fee: E("0.0001"), nonce: String(1790016795583094 + i) } });
    }
    push({ kind: "chain", ts: now - 3600, block: 381000, contract: "x402Vault", event: "Settled", tx: T(`x402out${agentId}`), logIndex: 0, args: { payer: a.owner, payee: AGENTS[3].owner, amount: E("0.02"), fee: E("0.0002"), nonce: "1790127479866168" } });
    push({ kind: "chain", ts: now - 86400, block: 379000, contract: "streamPay", event: "PlanCreated", tx: T(`plan${agentId}`), logIndex: 0, args: { planId: "1", payee: a.owner, pricePerPeriod: E("1"), period: "2592000" } });
    push({ kind: "commons", ts: now - 90000, type: "kb.write", actor: a.owner, ref: { kind: "kb", id: "how-to-hire" }, data: { slug: "how-to-hire", title: "How to hire an agent", rev: 3, tags: ["escrow"] } });
    push({ kind: "commons", ts: now - 96000, type: "tool.publish", actor: a.owner, ref: { kind: "tool", id: "1" }, data: { toolId: 1, name: `${a.name.toLowerCase()}-card`, tags: a.card?.capabilities?.slice(0, 1) ?? [] } });
    push({ kind: "commons", ts: now - 120000, type: "artifact.publish", actor: a.owner, ref: { kind: "artifact", id: "1" }, data: { artifactId: 1, name: `${a.name} ops cheatsheet`, tags: a.card?.capabilities?.slice(0, 2) ?? [] } });
  }

  const footer: AuditFooter = {
    merkleRoot: T(`root${agentId}`), leaves: lines.length, signer: "0x2368066B1A6C5D3f3C92a632a1378dd992cC05A3",
    signerEphemeral: false, generatedAt: now, owner: a.owner, agentId,
  };
  return delay({ lines, footer });
}

export function endorsements(agentId: number): Promise<CvEndorsement[]> {
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a || !a.jobsCompleted) return delay([]);
  const caps = a.card?.capabilities ?? [];
  const from = AGENTS.filter((x) => x.id !== agentId).slice(0, 3);
  return delay(from.map((f, i): CvEndorsement => ({
    from: f.owner, fromAgentId: null, fromName: null, capability: caps[i % Math.max(1, caps.length)] ?? null,
    value: 5 - (i % 2), at: now - (i + 1) * 43200, tx: T(`fb${agentId}${i}`), paymentBacked: false,
  })));
}

export const anchors = (agentId: number): Promise<CvAnchor[]> =>
  delay(agentId === 1 ? [{ key: "memoryRoot", root: T("mem1"), at: now - 5400, tx: T("anchor1") }] : []);

export function network(kind: NetKind): Promise<NetView> {
  const nodes = new Map<string, NetNode>();
  const node = (address: string, agent?: AgentView): NetNode => {
    const key = address.toLowerCase();
    let n = nodes.get(key);
    if (!n) {
      const a = agent ?? AGENTS.find((x) => x.owner.toLowerCase() === key);
      n = {
        key, address, agentId: a?.id ?? null, name: a?.name ?? `${address.slice(0, 6)}…${address.slice(-4)}`,
        jobs: a ? a.jobsCompleted : 0, earnedWei: "0", ratingAvg: a?.ratingAvg ?? null, ratingCount: a?.ratingCount ?? 0,
        capabilities: a?.card?.capabilities ?? [], status: a ? agentStatusName(a.status) : "client", isAgent: !!a,
      };
      nodes.set(key, n);
    }
    return n;
  };
  for (const a of AGENTS) node(a.owner, a);

  const edges: NetEdge[] = [];
  if (kind === "hire") {
    for (const j of JOBS) {
      const a = AGENTS.find((x) => x.id === j.agentId); if (!a) continue;
      if (String(j.status) === "Open") continue;
      const from = node(j.client), to = node(a.owner, a);
      if (from.key === to.key) continue; // the owner's own address is not a counterparty
      let e = edges.find((x) => x.from === from.key && x.to === to.key);
      if (!e) { e = { from: from.key, to: to.key, fromName: from.name, toName: to.name, fromAgentId: from.agentId, toAgentId: to.agentId, jobs: 0, fmxWei: "0", ratingAvg: null, firstAt: null, lastAt: null, kind, txs: [] }; edges.push(e); }
      e.jobs++; e.fmxWei = (BigInt(e.fmxWei) + BigInt(String(j.amount))).toString();
      e.ratingAvg = 4 + (j.id % 2);
      const t = Number(j.createdAt);
      e.firstAt = e.firstAt === null ? t : Math.min(e.firstAt, t);
      e.lastAt = e.lastAt === null ? t : Math.max(e.lastAt, t);
      if (j.tx?.requested) e.txs.push(j.tx.requested);
      to.earnedWei = (BigInt(to.earnedWei) + BigInt(String(j.amount))).toString();
    }
  } else {
    for (const a of AGENTS.filter((x) => x.jobsCompleted > 0).slice(0, 5)) {
      const to = node(a.owner, a);
      for (const f of AGENTS.filter((x) => x.id !== a.id).slice(0, 2)) {
        const from = node(f.owner, f);
        edges.push({ from: from.key, to: to.key, fromName: from.name, toName: to.name, fromAgentId: from.agentId, toAgentId: to.agentId, jobs: 1, fmxWei: "0", ratingAvg: 5, firstAt: now - 86400, lastAt: now - 86400, kind, txs: [T(`e${a.id}${f.id}`)] });
      }
    }
  }
  edges.sort((x, y) => (BigInt(y.fmxWei) > BigInt(x.fmxWei) ? 1 : BigInt(y.fmxWei) < BigInt(x.fmxWei) ? -1 : y.jobs - x.jobs));
  return delay({ kind, nodes: [...nodes.values()], edges, builtAt: now, source: "browser", notes: [] });
}
