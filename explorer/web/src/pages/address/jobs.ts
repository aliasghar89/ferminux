/* Address tab: Agent jobs (§5.6): Job · Role (client / agent) · Agent · Amount · Status · Latest tx · Age, from
   the gateway (GW /jobs?agentOwner= and /jobs?client=, merged newest first). */
import { html, mount, type Html } from "../../ui/html";
import { addrChip, txChip } from "../../ui/hash";
import { amt, jobPill, ago } from "../../ui/marks";
import { table, tableSkeleton, rowLink, type Col } from "../../ui/table";
import { empty } from "../../ui/state";
import { gw, agentById, GW_DOWN, type Job } from "../../gateway";
import { phu, type Ctx } from "./common";

export interface JobRow { job: Job; role: "client" | "agent" }

const latestTx = (j: Job) => j.tx.closed ?? j.tx.delivered ?? j.tx.requested;
const agentCell = (j: Job): Html => {
  const a = agentById(j.agentId);
  return a ? addrChip(a.owner, { label: { name: j.agentName || a.name, kind: "agent", id: j.agentId }, copy: false }) : html`<span class="hc-n">${j.agentName || "Agent"}</span> <span class="hc-id">#${j.agentId}</span>`;
};
const COLS: Col<JobRow>[] = [
  { label: "Job", cell: (r) => { const tx = latestTx(r.job); const t = html`<span class="num-mono">Job #${r.job.id}</span>`; return tx ? rowLink(`/tx/${tx}`, t, `Job ${r.job.id}, latest transaction ${tx}`) : t; } },
  { label: "Status", cell: (r) => jobPill(r.job.status) },
  { label: "Role", cell: (r) => html`<span class="kword">${r.role}</span>`, end: true },
  { label: "Agent", cell: (r) => agentCell(r.job), line: 2 },
  { label: "Amount (FMX)", cell: (r) => html`${amt(r.job.amount)}${phu()}`, align: "r", line: 2, end: true },
  { label: "Latest tx", cell: (r) => txChip(latestTx(r.job)), line: 3 },
  { label: "Age", cell: (r) => ago(r.job.createdAt), align: "r", line: 3, end: true },
];

/** Jobs of an address as client and as the owner of the agents (wallets count for their owner). */
export async function loadJobs(a: string, owner: string | null, signal: AbortSignal): Promise<JobRow[]> {
  const [asClient, asAgent] = await Promise.all([
    gw.jobs({ client: a, limit: 100 }, signal),
    owner ? gw.jobs({ agentOwner: owner, limit: 100 }, signal) : Promise.resolve([] as Job[]),
  ]);
  const rows = new Map<number, JobRow>();
  asAgent.forEach((job) => rows.set(job.id, { job, role: "agent" }));
  asClient.forEach((job) => rows.set(job.id, { job, role: rows.has(job.id) ? "agent" : "client" }));
  return [...rows.values()].sort((x, y) => y.job.createdAt - x.job.createdAt);
}

export function jobsTab(_ctx: Ctx, panel: HTMLElement, rows: Promise<JobRow[]>) {
  mount(panel, tableSkeleton({ caption: "Agent jobs", captionHidden: true, cols: COLS }, 3));
  rows.then((list) => {
    if (!list.length) { mount(panel, empty("No jobs for this address on ServiceEscrow.")); return; }
    mount(panel, html`${table({ caption: "Agent jobs", captionHidden: true, cols: COLS, rows: list })}
      <p class="ad-src">From the agent gateway at ferminux.net, which reads ServiceEscrow on chain 3961. Each job links to its latest transaction.</p>`);
  }, () => mount(panel, html`<p class="ad-gw-down">${GW_DOWN}</p>`));
}
