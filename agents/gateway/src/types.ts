export const AgentStatusName = ["None", "Active", "Paused", "Retired"] as const;
export const JobStatusName = [
  "None",
  "Open",
  "Delivered",
  "Completed",
  "Refunded",
  "Disputed",
  "Resolved",
] as const;

export interface AgentRow {
  id: number;
  owner: string;
  name: string;
  endpoint: string;
  metadataURI: string;
  pricePerJob: string;
  bond: string;
  status: number;
  registeredAt: number;
  retiredAt: number;
  jobsCompleted: number;
  jobsFailed: number;
  ratingCount: number;
  ratingSum: number;
  card: string | null;
  online: number;
  lastSeen: number | null;
  updatedAtBlock: number;
}

export interface JobRow {
  id: number;
  agentId: number;
  client: string;
  amount: string;
  inputHash: string;
  inputURI: string;
  outputHash: string | null;
  outputURI: string | null;
  createdAt: number;
  deliveredAt: number | null;
  status: number;
  txRequested: string | null;
  txDelivered: string | null;
  txClosed: string | null;
  updatedAtBlock: number;
}

export interface AgentView {
  id: number;
  owner: string;
  name: string;
  endpoint: string;
  metadataURI: string;
  pricePerJob: string;
  bond: string;
  status: string;
  registeredAt: number;
  jobsCompleted: number;
  jobsFailed: number;
  ratingCount: number;
  ratingAvg: number | null;
  card: unknown | null;
  online: boolean;
  lastSeen: number | null;
}

export interface JobView {
  id: number;
  agentId: number;
  agentName: string | null;
  client: string;
  amount: string;
  inputHash: string;
  inputURI: string;
  outputHash: string | null;
  outputURI: string | null;
  createdAt: number;
  deliveredAt: number | null;
  status: string;
  tx: { requested: string | null; delivered: string | null; closed: string | null };
}

export function agentRowToView(row: AgentRow): AgentView {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    endpoint: row.endpoint,
    metadataURI: row.metadataURI,
    pricePerJob: row.pricePerJob,
    bond: row.bond,
    status: AgentStatusName[row.status] ?? "None",
    registeredAt: row.registeredAt,
    jobsCompleted: row.jobsCompleted,
    jobsFailed: row.jobsFailed,
    ratingCount: row.ratingCount,
    ratingAvg: row.ratingCount > 0 ? row.ratingSum / row.ratingCount : null,
    card: row.card ? safeJsonParse(row.card) : null,
    online: row.online === 1,
    lastSeen: row.lastSeen ?? null,
  };
}

export function jobRowToView(row: JobRow, agentName: string | null): JobView {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName,
    client: row.client,
    amount: row.amount,
    inputHash: row.inputHash,
    inputURI: row.inputURI,
    outputHash: row.outputHash,
    outputURI: row.outputURI,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    status: JobStatusName[row.status] ?? "None",
    tx: { requested: row.txRequested, delivered: row.txDelivered, closed: row.txClosed },
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
