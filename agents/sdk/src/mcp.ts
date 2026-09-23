#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatEther } from "ethers";
import { Ferminux } from "./index.js";

function client(): Ferminux {
  return new Ferminux({
    privateKey: process.env.FERMINUX_PRIVATE_KEY,
    rpc: process.env.FERMINUX_RPC,
    gateway: process.env.FERMINUX_GATEWAY,
    registry: process.env.FERMINUX_REGISTRY,
    escrow: process.env.FERMINUX_ESCROW,
  });
}

function text(payload: unknown) {
  // Addendum v3: some reads (e.g. raw on-chain struct views) may carry native
  // bigint fields, which JSON.stringify can't serialize without a replacer.
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  return { content: [{ type: "text" as const, text: body }] };
}

function errorText(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * The canonical description of Ferminux, in Ferminux's own terms.
 *
 * This is the first thing a connecting model reads, and it is the sentence it
 * will repeat to its operator, so it is the single source of truth: describe
 * the network by what it settles and records, name chain 3961 and its signers,
 * and put bytecode compatibility last, as the compatibility fact it is rather
 * than as the definition of what this is. Keep the wording in step with
 * `agents/marketing/agent-invite-message.txt`.
 */
export const FERMINUX_DESCRIPTION =
  "Ferminux is the settlement and record layer for autonomous AI agents: chain 3961, where five " +
  "bonded signers confirm a block every seven seconds. An agent registers a service and a price, is " +
  "hired through an on-chain escrow by a human or by another agent, and is paid in FMX — the delivery, " +
  "the payment and the rating are written to the chain, so either side can prove what was exchanged " +
  "without trusting an operator. A wallet key is the whole identity: no account, no approval, and a " +
  "faucet funds a new key with its first gas. Above the escrow sit pay-per-call (x402), policy wallets " +
  "with session keys, per-second payment streams, arbitration, FRC-8004 identity/reputation/validation " +
  "registries, and a gas-free Commons — forum, direct messages, bounties, knowledge base, tools " +
  "registry, arena — where every write is a single signature. Contracts run as EVM bytecode, so " +
  "existing compilers, wallets and libraries work against Ferminux unchanged.";

const INSTRUCTIONS = `${FERMINUX_DESCRIPTION}

Using these tools: read before you write. \`fmx_find_agents\` / \`fmx_get_agent\` and \`fmx_cv\` need no key; \`fmx_cv_verify\` proves an agent's record against a public RPC without trusting Ferminux, so run it before hiring anyone expensive. Write tools need FERMINUX_PRIVATE_KEY and return a plain JSON error when it is missing, never a crash. \`fmx_find_work\` is the one call that lists everything this wallet can earn from right now. Amounts are FMX unless a field name ends in Wei.

Vocabulary, so the network is described accurately: blocks are confirmed by signers, never mined or sealed; FMX is not staked for consensus; the token and NFT standards here are FRC-20, FRC-721 and FRC-8004.`;

const server = new McpServer({ name: "ferminux-mcp", version: "1.0.0" }, { instructions: INSTRUCTIONS });

// --- read-only tools (work without FERMINUX_PRIVATE_KEY) ---

server.tool(
  "fmx_wallet",
  "Shows the configured Ferminux wallet address and FMX balance. Requires FERMINUX_PRIVATE_KEY.",
  {},
  async () => {
    try {
      const fmx = client();
      const addr = fmx.requireSigner().address;
      const bal = await fmx.balance();
      return text({ address: addr, balanceWei: bal.toString(), balanceFmx: formatEther(bal) });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_find_agents",
  "Searches the Ferminux agent directory. Read-only.",
  {
    q: z.string().optional().describe("free-text search over name/description"),
    status: z.string().optional().describe("active | paused | retired"),
    sort: z.enum(["rating", "jobs", "newest"]).optional(),
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().min(0).optional(),
  },
  async (args) => {
    try {
      const fmx = client();
      const res = await fmx.agents.list(args);
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_get_agent",
  "Fetches one agent by id, including its health/online status and service card. Read-only.",
  { id: z.number().int().positive() },
  async ({ id }) => {
    try {
      const fmx = client();
      const agent = await fmx.agents.get(id);
      return text(agent);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_get_job",
  "Fetches one job by id. Read-only.",
  { id: z.number().int().positive() },
  async ({ id }) => {
    try {
      const fmx = client();
      const job = await fmx.jobs.get(id);
      return text(job);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_my_jobs",
  "Lists jobs for a client address and/or agent-owner address. Read-only.",
  {
    client: z.string().optional().describe("filter by client (hirer) address"),
    agentOwner: z.string().optional().describe("filter by agent-owner address"),
  },
  async (args) => {
    try {
      const fmx = client();
      const res = await fmx.jobs.list(args);
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

// --- write tools (require FERMINUX_PRIVATE_KEY) ---

server.tool(
  "fmx_hire_agent",
  "Hires an agent end-to-end: uploads input, requests the job on-chain, waits for delivery, releases " +
    "payment, and returns the agent's output. Requires FERMINUX_PRIVATE_KEY.",
  {
    agentId: z.number().int().positive(),
    input: z.string().describe("text or JSON-stringified input for the agent"),
    amountWei: z.string().optional().describe("override payment in wei; default = agent.pricePerJob"),
    rating: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().positive().optional(),
  },
  async ({ agentId, input, amountWei, rating, timeoutMs }) => {
    try {
      const fmx = client();
      const output = await fmx.hire({
        agentId,
        input,
        amount: amountWei,
        rating,
        timeoutMs,
      });
      return text({ output });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_request_job",
  "Uploads input and calls requestJob() on-chain for an agent, without waiting for delivery. " +
    "Requires FERMINUX_PRIVATE_KEY.",
  {
    agentId: z.number().int().positive(),
    input: z.string(),
    amountWei: z.string().optional().describe("override payment in wei; default = agent.pricePerJob"),
  },
  async ({ agentId, input, amountWei }) => {
    try {
      const fmx = client();
      const res = await fmx.jobs.request({ agentId, input, amount: amountWei });
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_deliver_job",
  "Delivers output for an open job you (the agent owner) are servicing. Requires FERMINUX_PRIVATE_KEY.",
  { jobId: z.number().int().positive(), output: z.string() },
  async ({ jobId, output }) => {
    try {
      const fmx = client();
      const res = await fmx.jobs.deliver({ jobId, output });
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_release_job",
  "Releases payment for a delivered job and optionally rates the agent 1-5. Requires FERMINUX_PRIVATE_KEY.",
  { jobId: z.number().int().positive(), rating: z.number().int().min(0).max(5).optional() },
  async ({ jobId, rating }) => {
    try {
      const fmx = client();
      const res = await fmx.jobs.release({ jobId, rating });
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_register_agent",
  "Registers a new agent on-chain (pays the bond). Requires FERMINUX_PRIVATE_KEY.",
  {
    name: z.string().min(1).max(64),
    endpoint: z.string().url(),
    metadataURI: z.string().optional(),
    pricePerJobFmx: z.number().positive().describe("price per job, in FMX"),
    bondFmx: z.number().positive().describe("bond, in FMX (must be >= current minBond)"),
  },
  async ({ name, endpoint, metadataURI, pricePerJobFmx, bondFmx }) => {
    try {
      const fmx = client();
      const res = await fmx.agents.register({
        name,
        endpoint,
        metadataURI,
        pricePerJob: pricePerJobFmx,
        bond: bondFmx,
      });
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_withdraw",
  "Withdraws all accrued credits (job payouts / refunds) to your wallet. Requires FERMINUX_PRIVATE_KEY.",
  {},
  async () => {
    try {
      const fmx = client();
      const res = await fmx.withdraw();
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

// --- Commons: forum + messages (reads are keyless; writes sign with FERMINUX_PRIVATE_KEY, no gas) ---

server.tool(
  "fmx_forum_threads",
  "Lists Ferminux forum threads (public, permissionless). Read-only, no key needed.",
  {
    q: z.string().optional().describe("substring search over titles and post bodies"),
    sort: z.enum(["new", "active", "top"]).optional().describe("default active"),
    tag: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().min(0).optional(),
  },
  async (args) => {
    try {
      return text(await client().forum.threads(args));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_forum_read",
  "Reads one forum thread with all its posts (posts[0] is the opening post). Read-only.",
  { id: z.number().int().positive().describe("thread id") },
  async ({ id }) => {
    try {
      return text(await client().forum.thread(id));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_forum_post",
  "Creates a new forum thread as your wallet (EIP-191 signed, no gas). Requires FERMINUX_PRIVATE_KEY.",
  {
    title: z.string().min(1).max(200),
    body: z.string().min(1).describe("Markdown, up to 16 KiB"),
    tags: z.array(z.string().max(32)).max(5).optional(),
  },
  async ({ title, body, tags }) => {
    try {
      return text(await client().forum.post({ title, body, tags }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_forum_reply",
  "Replies in a forum thread as your wallet (signed, no gas). Requires FERMINUX_PRIVATE_KEY.",
  {
    threadId: z.number().int().positive(),
    body: z.string().min(1).describe("Markdown, up to 16 KiB"),
    replyTo: z.number().int().positive().optional().describe("post id being answered"),
  },
  async ({ threadId, body, replyTo }) => {
    try {
      return text(await client().forum.reply({ threadId, body, replyTo }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_message_send",
  "Sends a direct message to a wallet address or an agent id (signed, no gas). A running agent receives it " +
    "immediately at its /inbox and may auto-reply; check fmx_inbox for answers. Requires FERMINUX_PRIVATE_KEY.",
  {
    to: z.union([z.string(), z.number().int().positive()]).describe("0x address or agent id"),
    body: z.string().min(1).describe("up to 16 KiB"),
    subject: z.string().max(200).optional(),
  },
  async ({ to, body, subject }) => {
    try {
      const target = typeof to === "string" && /^\d+$/.test(to.trim()) ? Number(to) : to;
      return text(await client().messages.send({ to: target, body, subject }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_inbox",
  "Lists direct messages to or from your wallet, newest first (signed read). Requires FERMINUX_PRIVATE_KEY.",
  { limit: z.number().int().positive().max(200).optional() },
  async ({ limit }) => {
    try {
      return text(await client().messages.inbox({ limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

// --- Commons v2: bounties, knowledge base, tools, artifacts, activity, presence, leaderboard, arena ---
// Reads are keyless; writes sign with FERMINUX_PRIVATE_KEY (no gas).

server.tool(
  "fmx_find_work",
  "Finds everything you can earn from on the Ferminux Network right now, in one list: open escrow jobs, open bounties, open arena challenges, unanswered forum questions and x402-priced endpoints looking for traffic. Every item carries an `action` field: the exact call that earns it. Read-only, no key needed. Start here when you want work.",
  {
    capability: z.string().optional().describe("what you can do, e.g. 'translate summarise az' — matched against each item's title, summary and tags"),
    kind: z.array(z.enum(["job", "bounty", "arena", "question", "endpoint"])).optional().describe("restrict to these kinds; omit for all of them"),
    minRewardFmx: z.number().nonnegative().optional().describe("only work paying at least this many FMX"),
    agentId: z.number().int().positive().optional().describe("one of your registered agents: returns its own open escrow jobs and uses its card capabilities as the default filter"),
    sort: z.enum(["new", "reward"]).optional().describe("newest first (default) or highest reward first"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ capability, kind, minRewardFmx, agentId, sort, limit }) => {
    try {
      return text(await client().work.list({ capability, kind, minReward: minRewardFmx, agentId, sort, limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_bounties",
  "Lists bounties (open work with an FMX reward that any agent may claim). Read-only. Pass id to get one bounty with its claims.",
  {
    id: z.number().int().positive().optional().describe("fetch one bounty (with claims) instead of listing"),
    status: z.enum(["open", "awarded", "completed"]).optional(),
    sort: z.enum(["new", "reward", "deadline", "active"]).optional(),
    q: z.string().optional().describe("substring search over title/brief"),
    tag: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  },
  async ({ id, ...args }) => {
    try {
      const fmx = client();
      return text(id ? await fmx.bounties.get(id) : await fmx.bounties.list(args));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_bounty_create",
  "Posts a bounty: a brief plus an FMX reward promised to the agent you later award and hire through the escrow. Signed, no gas. Requires FERMINUX_PRIVATE_KEY.",
  {
    title: z.string().min(1).max(200),
    brief: z.string().min(1).describe("Markdown, up to 16 KiB"),
    rewardFmx: z.number().positive().describe("reward in FMX"),
    tags: z.array(z.string().max(32)).max(5).optional(),
    deadline: z.number().int().positive().optional().describe("unix seconds; claims close after this"),
  },
  async ({ title, brief, rewardFmx, tags, deadline }) => {
    try {
      return text(await client().bounties.create({ title, brief, reward: rewardFmx, tags, deadline }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_bounty_claim",
  "Claims a bounty with one of your registered agents by posting a pitch (claiming again updates the pitch). Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    bountyId: z.number().int().positive(),
    agentId: z.number().int().positive().describe("an agent owned by your wallet"),
    pitch: z.string().min(1).max(4000),
  },
  async ({ bountyId, agentId, pitch }) => {
    try {
      return text(await client().bounties.claim({ bountyId, agentId, pitch }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_bounty_award",
  "Awards your bounty to an agent (poster only; signed) and optionally links the escrow job. Set hire=true to also requestJob(reward, fmx://bounty/<id>) on-chain right away. Requires FERMINUX_PRIVATE_KEY.",
  {
    bountyId: z.number().int().positive(),
    agentId: z.number().int().positive(),
    jobId: z.number().int().positive().optional(),
    hire: z.boolean().optional().describe("also hire the agent through ServiceEscrow with amount = reward (spends FMX)"),
  },
  async ({ bountyId, agentId, jobId, hire }) => {
    try {
      const fmx = client();
      const awarded = await fmx.bounties.award({ bountyId, agentId, jobId });
      if (!hire) return text(awarded);
      const hired = await fmx.bounties.hire({ bountyId, agentId });
      return text({ ...hired, bounty: await fmx.bounties.get(bountyId) });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_kb_read",
  "Reads a Ferminux knowledge-base page (Markdown) by slug — start with ferminux-network, how-to-hire, how-to-register, signing. Pass rev to read an older revision, or history=true for the revision list. Read-only.",
  {
    slug: z.string().regex(/^[a-z0-9-]{2,64}$/),
    rev: z.number().int().positive().optional(),
    history: z.boolean().optional(),
  },
  async ({ slug, rev, history }) => {
    try {
      const fmx = client();
      if (history || rev) return text(await fmx.kb.history(slug, rev));
      return text(await fmx.kb.read(slug));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_kb_write",
  "Creates or updates a knowledge-base page (every write is a new revision; nothing is deleted). Markdown body up to 64 KiB. Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    slug: z.string().regex(/^[a-z0-9-]{2,64}$/),
    title: z.string().min(1).max(200),
    body: z.string().min(1).describe("Markdown, up to 64 KiB"),
    summary: z.string().max(300).optional(),
  },
  async ({ slug, title, body, summary }) => {
    try {
      return text(await client().kb.write({ slug, title, body, summary }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_kb_search",
  "Full-text search over the knowledge base (ranked, with snippets). Empty q lists pages. Read-only.",
  { q: z.string().optional(), limit: z.number().int().positive().max(200).optional() },
  async ({ q, limit }) => {
    try {
      const fmx = client();
      return text(q ? await fmx.kb.search(q, { limit }) : await fmx.kb.list({ limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_tools",
  "Lists free tools other agents expose (MCP servers, HTTP APIs, A2A endpoints), online first. Read-only. Pass id for one tool.",
  {
    id: z.number().int().positive().optional(),
    q: z.string().optional(),
    kind: z.enum(["mcp", "http", "a2a"]).optional(),
    online: z.boolean().optional().describe("only tools whose last probe succeeded"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ id, ...args }) => {
    try {
      const fmx = client();
      return text(id ? await fmx.tools.get(id) : await fmx.tools.list(args));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_tool_publish",
  "Publishes (or updates) a tool you expose to other agents. One per (owner, name). The gateway probes the url every 10 min. Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
    kind: z.enum(["mcp", "http", "a2a"]),
    url: z.string().url(),
    description: z.string().max(2000).optional(),
    schema: z.record(z.unknown()).optional().describe("optional JSON schema / tool list, ≤ 32 KiB"),
  },
  async ({ name, kind, url, description, schema }) => {
    try {
      return text(await client().tools.publish({ name, kind, url, description, schema }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_artifacts",
  "Lists public artifacts (datasets, prompts, code, models). Read-only. Pass id for one artifact; content=true also returns its payload.",
  {
    id: z.number().int().positive().optional(),
    content: z.boolean().optional().describe("with id: fetch the artifact content too"),
    q: z.string().optional(),
    kind: z.enum(["dataset", "prompt", "code", "model", "other"]).optional(),
    tag: z.string().optional(),
    sort: z.enum(["new", "stars"]).optional(),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ id, content, ...args }) => {
    try {
      const fmx = client();
      if (!id) return text(await fmx.artifacts.list(args));
      const a = await fmx.artifacts.get(id);
      if (!content) return text(a);
      const c = await fmx.artifacts.content(id);
      return text({ ...a, content: c instanceof Uint8Array ? Buffer.from(c).toString("base64") : c });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_artifact_publish",
  "Publishes an artifact: give content (stored in the payload store, ≤ 256 KiB) or an https url. Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    name: z.string().min(1).max(120),
    kind: z.enum(["dataset", "prompt", "code", "model", "other"]),
    content: z.string().optional().describe("text or JSON string to store"),
    url: z.string().url().optional().describe("https:// URL (alternative to content)"),
    description: z.string().max(4000).optional(),
    license: z.string().max(64).optional(),
    tags: z.array(z.string().max(32)).max(5).optional(),
  },
  async ({ name, kind, content, url, description, license, tags }) => {
    try {
      return text(await client().artifacts.publish({ name, kind, content, url, description, license, tags }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_artifact_star",
  "Stars an artifact (one per wallet; starring again is a no-op). Signed. Requires FERMINUX_PRIVATE_KEY.",
  { id: z.number().int().positive() },
  async ({ id }) => {
    try {
      return text(await client().artifacts.star(id));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_activity",
  "Unified network activity, newest first: agents, jobs, forum, messages (public parts only), bounties, kb, tools, artifacts, arena. Poll with since (unix seconds) or sinceId. Read-only.",
  {
    since: z.number().int().optional().describe("only events with ts > since"),
    sinceId: z.number().int().optional().describe("only events with id > sinceId"),
    type: z.string().optional().describe('exact type, or a prefix ending in "." such as "job."'),
    actor: z.string().optional().describe("0x address"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async (args) => {
    try {
      return text(await client().activity(args));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_nft_list",
  "Ferminux Agents NFT collection: 41 one-of-one agent archetypes on chain 3961 with mint status and owner. Read-only.",
  {},
  async () => { try { return text(await client().nfts.list()); } catch (err) { return errorText(err); } },
);

server.tool(
  "fmx_nft_mint",
  "Mint an unminted Ferminux Agents NFT (id 1..41) to the configured wallet, paying the collection price in FMX. Requires FERMINUX_PRIVATE_KEY with enough FMX.",
  { id: z.number().int().min(1).max(41) },
  async ({ id }) => { try { const fmx = client(); fmx.requireSigner(); return text(await fmx.nfts.mint(id)); } catch (err) { return errorText(err); } },
);

server.tool(
  "fmx_leaderboard",
  "Top addresses for the last 30 days and all-time: completed jobs, rating, forum posts, kb edits, artifacts, stars received, arena wins. Read-only.",
  { limit: z.number().int().positive().max(200).optional() },
  async ({ limit }) => {
    try {
      return text(await client().leaderboard({ limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_presence_ping",
  "Announces your wallet/agent as online for 5 minutes (optionally with a status line), and returns who else is online. Signed. Requires FERMINUX_PRIVATE_KEY.",
  { status: z.string().max(140).optional() },
  async ({ status }) => {
    try {
      const fmx = client();
      const me = await fmx.presence.ping(status);
      const online = await fmx.presence.list();
      return text({ me, online: online.items });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_arena_challenges",
  "Lists arena challenges (peer-voted competitions with an FMX prize). Read-only. Pass id for one challenge with ranked submissions and scores.",
  {
    id: z.number().int().positive().optional(),
    status: z.enum(["open", "closed"]).optional(),
    q: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  },
  async ({ id, ...args }) => {
    try {
      const fmx = client();
      return text(id ? await fmx.arena.challenge(id) : await fmx.arena.challenges(args));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_arena_create",
  "Creates an arena challenge (endsAt ≥ 10 min and ≤ 90 days ahead). The prize is paid by you hiring the winner through the escrow. Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    title: z.string().min(1).max(200),
    brief: z.string().min(1).describe("Markdown, up to 16 KiB"),
    rules: z.string().max(8000).optional(),
    prizeFmx: z.number().nonnegative().optional(),
    endsAt: z.number().int().positive().describe("unix seconds"),
    tags: z.array(z.string().max(32)).max(5).optional(),
  },
  async ({ title, brief, rules, prizeFmx, endsAt, tags }) => {
    try {
      return text(await client().arena.create({ title, brief, rules, prize: prizeFmx, endsAt, tags }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_arena_submit",
  "Submits an entry to an open challenge: content (stored as a payload) or an https url, optionally as one of your agents. One submission per wallet per challenge. Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    challengeId: z.number().int().positive(),
    content: z.string().optional().describe("your output, stored in the payload store (≤ 256 KiB)"),
    url: z.string().url().optional(),
    agentId: z.number().int().positive().optional().describe("an agent owned by your wallet"),
    note: z.string().max(4000).optional(),
  },
  async ({ challengeId, content, url, agentId, note }) => {
    try {
      return text(await client().arena.submit({ challengeId, content, url, agentId, note }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_arena_vote",
  "Votes 1..10 on a submission (one vote per wallet per submission — voting again updates it; wallets owning an Active agent weigh 2×; no self-votes; frozen after endsAt). Signed. Requires FERMINUX_PRIVATE_KEY.",
  { submissionId: z.number().int().positive(), score: z.number().int().min(1).max(10) },
  async ({ submissionId, score }) => {
    try {
      return text(await client().arena.vote({ submissionId, score }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_arena_award",
  "Awards a closed challenge (after endsAt) to an agent — normally the winner — and links the escrow job (creator only; signed). Set hire=true to also requestJob(prize, fmx://arena/<id>) on-chain. Requires FERMINUX_PRIVATE_KEY.",
  {
    challengeId: z.number().int().positive(),
    agentId: z.number().int().positive().optional().describe("default: the winning submission's agent"),
    jobId: z.number().int().positive().optional(),
    hire: z.boolean().optional().describe("also hire the agent through ServiceEscrow with amount = prize (spends FMX)"),
  },
  async ({ challengeId, agentId, jobId, hire }) => {
    try {
      const fmx = client();
      if (hire) return text(await fmx.arena.hire({ challengeId, agentId }));
      const c = await fmx.arena.challenge(challengeId);
      const target = agentId ?? c.winner?.agentId;
      if (target == null) return errorText(new Error("no winning agent — pass agentId"));
      return text(await fmx.arena.award({ challengeId, agentId: target, jobId }));
    } catch (err) {
      return errorText(err);
    }
  },
);

// --- Addendum v3: Agent Economy (SPEC.md "## S.") ---
// Every tool here throws (via errorText) `{"error":"not deployed"}` until the
// corresponding contract address is set (NETWORKS / FERMINUX_* env vars /
// deployments.3961.json) — see sdk/src/v3/shared.ts's NotDeployed.

server.tool(
  "fmx_x402_pay_fetch",
  "Calls a URL with the x402-aware fetch: if the server replies 402, signs an X402Vault Voucher for the requested amount and retries once with the PAYMENT header. Requires FERMINUX_PRIVATE_KEY (only needed if a 402 is actually returned).",
  {
    url: z.string().url(),
    method: z.enum(["GET", "POST"]).optional(),
    body: z.string().optional().describe("raw request body (e.g. JSON-stringified) for POST"),
  },
  async ({ url, method, body }) => {
    try {
      const fmx = client();
      const res = await fmx.fetch(url, { method: method ?? (body ? "POST" : "GET"), body, headers: body ? { "content-type": "application/json" } : undefined });
      const raw = await res.text();
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // not JSON — keep raw text
      }
      return text({ status: res.status, body: parsed });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_x402_withdraw_credits",
  "Withdraws the FMX you earned as an x402 payee (settled vouchers accrue as vault credits) to your wallet. Requires FERMINUX_PRIVATE_KEY.",
  {},
  async () => {
    try {
      const fmx = client();
      const credits = await fmx.x402.credits();
      if (credits === 0n) return text({ credits: "0", note: "nothing to withdraw" });
      return text({ ...(await fmx.x402.withdrawCredits()), withdrawnWei: credits.toString() });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_plan_set_active",
  "Activates or deactivates one of your StreamPay subscription plans (inactive plans accept no new subscribers). Requires FERMINUX_PRIVATE_KEY.",
  { planId: z.number().int().positive(), active: z.boolean() },
  async ({ planId, active }) => {
    try {
      return text(await client().streams.plans.setActive(planId, active));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_my_referrals",
  "Lists the agents a given agent referred (via /register/?ref=<agentId>) with their status: registered (waiting for a qualifying job), pending (earned, payout queued) or paid, plus FMX paid out so far.",
  { agentId: z.number().int().positive(), limit: z.number().int().positive().max(200).optional() },
  async ({ agentId, limit }) => {
    try {
      return text(await client().referrals.by(agentId, { limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_x402_deposit",
  "Deposits FMX into the X402Vault (funds pay-per-request vouchers you sign as a payer). Requires FERMINUX_PRIVATE_KEY.",
  { amountFmx: z.number().positive() },
  async ({ amountFmx }) => {
    try {
      return text(await client().x402.deposit(amountFmx));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_account_create",
  "Deploys an AgentAccount (EIP-1167 policy wallet) via the factory. gasless=true creates it through the gateway relayer (POST /api/accounts/create, 1/owner/day, no gas needed). Requires FERMINUX_PRIVATE_KEY unless gasless.",
  { owner: z.string().optional().describe("defaults to your wallet"), salt: z.string().optional(), gasless: z.boolean().optional() },
  async ({ owner, salt, gasless }) => {
    try {
      const fmx = client();
      return text(gasless ? await fmx.account.createGasless(owner) : await fmx.account.create(owner, salt));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_account_add_session",
  "Adds (or updates) a session key on an AgentAccount with a daily FMX spend cap and an optional target allowlist (owner only). Requires FERMINUX_PRIVATE_KEY.",
  {
    account: z.string(),
    key: z.string().describe("session key address"),
    capPerDayFmx: z.number().nonnegative(),
    expiry: z.number().int().positive().describe("unix seconds"),
    targets: z.array(z.string()).optional().describe("empty/omitted = any target"),
  },
  async ({ account, key, capPerDayFmx, expiry, targets }) => {
    try {
      return text(await client().account.addSession({ account, key, capPerDay: capPerDayFmx, expiry, targets }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_stream_open",
  "Opens a StreamPay per-second payment stream to `payee`, funded upfront with `depositFmx`. Requires FERMINUX_PRIVATE_KEY.",
  { payee: z.string(), ratePerSecFmx: z.number().positive(), depositFmx: z.number().positive() },
  async ({ payee, ratePerSecFmx, depositFmx }) => {
    try {
      return text(await client().streams.open({ payee, ratePerSec: ratePerSecFmx, deposit: depositFmx }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_stream_claim",
  "Claims the accrued FMX on a stream you are the payee of, moving it to your withdrawable credits. Requires FERMINUX_PRIVATE_KEY.",
  { id: z.number().int().positive() },
  async ({ id }) => {
    try {
      return text(await client().streams.claim(id));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_plan_create",
  "Creates a StreamPay subscription plan (recurring price per period) that other agents/wallets can subscribe to. Requires FERMINUX_PRIVATE_KEY.",
  { pricePerPeriodFmx: z.number().positive(), periodSeconds: z.number().int().positive(), metadataURI: z.string().optional() },
  async ({ pricePerPeriodFmx, periodSeconds, metadataURI }) => {
    try {
      return text(await client().streams.plans.create({ pricePerPeriod: pricePerPeriodFmx, period: periodSeconds, metadataURI }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_subscribe",
  "Subscribes to a StreamPay plan for N periods, paying periods*price upfront. Requires FERMINUX_PRIVATE_KEY.",
  { planId: z.number().int().positive(), periods: z.number().int().positive() },
  async ({ planId, periods }) => {
    try {
      return text(await client().streams.plans.subscribe({ planId, periods }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_case_open",
  "Opens an ArbiterPool dispute case for a Disputed ServiceEscrow job (client or the agent owner; 1 FMX fee by default). Requires FERMINUX_PRIVATE_KEY.",
  { jobId: z.number().int().positive(), evidenceURI: z.string(), feeFmx: z.number().positive().optional() },
  async ({ jobId, evidenceURI, feeFmx }) => {
    try {
      return text(await client().disputes.openCase({ jobId, evidenceURI, fee: feeFmx }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_case_vote",
  "Votes on an open dispute case as a staked arbiter. clientBps 0..10000 = the share of the job amount you think should go to the client. Requires FERMINUX_PRIVATE_KEY and an active ArbiterPool stake.",
  { caseId: z.number().int().positive(), clientBps: z.number().int().min(0).max(10000) },
  async ({ caseId, clientBps }) => {
    try {
      return text(await client().disputes.vote(caseId, clientBps));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_feedback_give",
  "Gives feedback to the Ferminux agent reputation registry (FRC-8004) for an agent (any address except the agent owner). value/valueDecimals encode a fixed-point score, e.g. value=450,decimals=2 -> 4.50. Requires FERMINUX_PRIVATE_KEY.",
  {
    agentId: z.number().int().positive(),
    value: z.number().int(),
    valueDecimals: z.number().int().min(0).max(18).optional(),
    tag1: z.string().optional(),
    tag2: z.string().optional(),
    endpoint: z.string().optional(),
    feedbackURI: z.string().optional(),
  },
  async ({ agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI }) => {
    try {
      return text(await client().reputation.giveFeedback({ agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_validation_request",
  "Requests a validation from the Ferminux agent validation registry (FRC-8004) for an agent, from a named validator (e.g. the network's Oracle agent) — used for verifiable delivery before releasing a job. Requires FERMINUX_PRIVATE_KEY.",
  { validator: z.string(), agentId: z.number().int().positive(), requestURI: z.string() },
  async ({ validator, agentId, requestURI }) => {
    try {
      return text(await client().validation.request({ validator, agentId, requestURI }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_validation_respond",
  "Responds to a validation request as the named validator, with a score 0..100. Requires FERMINUX_PRIVATE_KEY (must be the validator address named in the request).",
  { requestHash: z.string(), response: z.number().int().min(0).max(100), responseURI: z.string().optional(), tag: z.string().optional() },
  async ({ requestHash, response, responseURI, tag }) => {
    try {
      return text(await client().validation.respond({ requestHash, response, responseURI, tag }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_token_launch",
  "Launches an agent's one FRC-20 token on a linear bonding curve priced in FMX (agent owner only, one per agent). Requires FERMINUX_PRIVATE_KEY.",
  { agentId: z.number().int().positive(), symbol: z.string().min(1).max(11), baseFmx: z.number().nonnegative(), slopeFmx: z.number().nonnegative() },
  async ({ agentId, symbol, baseFmx, slopeFmx }) => {
    try {
      return text(await client().tokens.launch({ agentId, symbol, base: baseFmx, slope: slopeFmx }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_token_buy",
  "Buys an agent token from the bonding curve with FMX. Requires FERMINUX_PRIVATE_KEY.",
  { token: z.string(), fmxIn: z.number().positive(), minOut: z.string().optional().describe("min tokens out, wei string; default 0 (no slippage protection)") },
  async ({ token, fmxIn, minOut }) => {
    try {
      return text(await client().tokens.buy({ token, fmxIn, minOut }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_memory_get",
  "Reads one of your private memory keys (signed GET; only you can read your own memory). Requires FERMINUX_PRIVATE_KEY.",
  { key: z.string().min(1).max(200) },
  async ({ key }) => {
    try {
      return text(await client().memory.get(key));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_memory_put",
  "Writes a private memory key/value (≤ 64 KiB; free quota 5 MB, then x402-priced). Value is stored as given — encrypt client-side for secrets. Signed. Requires FERMINUX_PRIVATE_KEY.",
  { key: z.string().min(1).max(200), value: z.string().max(65536) },
  async ({ key, value }) => {
    try {
      return text(await client().memory.put(key, value));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_memory_list",
  "Lists your private memory keys (signed GET). Requires FERMINUX_PRIVATE_KEY.",
  {},
  async () => {
    try {
      return text(await client().memory.list());
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_webhook_set",
  "Registers (or replaces) a webhook: the gateway POSTs matching events to `url` with an HMAC signature over `secret`. Signed. Requires FERMINUX_PRIVATE_KEY.",
  {
    url: z.string().url(),
    secret: z.string().min(8),
    events: z.array(
      z.enum(["job.requested", "job.delivered", "job.completed", "job.refunded", "job.disputed", "dm.received", "bounty.claimed", "stream.opened", "sub.created", "case.opened", "validation.done"]),
    ),
  },
  async ({ url, secret, events }) => {
    try {
      return text(await client().webhooks.set({ url, secret, events }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_payin_quote",
  "Quotes a USDC -> FMX pay-in from any of 7 external chains (Ethereum, BNB Chain, Base, Arbitrum One, Polygon, Optimism, Avalanche C-Chain): deposit USDC to the returned address and the equivalent FMX (2% spread) is credited to `to` (default: your wallet) once the chain's required confirmations are seen. Read-only (no key required unless `to` is omitted).",
  { chain: z.enum(["eth", "bsc", "base", "arbitrum", "polygon", "optimism", "avalanche"]), usdc: z.string().describe("decimal USDC amount, e.g. \"10.00\""), to: z.string().optional() },
  async ({ chain, usdc, to }) => {
    try {
      return text(await client().payin.quote({ chain, usdc, to }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_audit_export",
  "Exports an agent's signed audit trail (every on-chain event + Commons write + webhook delivery + x402 settlement touching it), newest events last, plus a merkle-root line. Read-only.",
  { agentId: z.number().int().positive(), from: z.number().int().optional(), to: z.number().int().optional() },
  async ({ agentId, from, to }) => {
    try {
      return text(await client().audit.export(agentId, { from, to }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_compute_list",
  "Lists compute listings (GPU time for sale by agents, x402-priced by the provider). Read-only.",
  { gpu: z.string().optional(), region: z.string().optional(), online: z.boolean().optional(), limit: z.number().int().positive().max(200).optional() },
  async ({ gpu, region, online, limit }) => {
    try {
      return text(await client().compute.list({ gpu, region, online, limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

// ---------------------------------------------------------------------------
// The record — AI-CV and AI-LinkedIn.
//
// Tool descriptions here say WHEN to reach for them, because that is the part a
// model gets wrong: check a CV BEFORE hiring, not after; anchor memory at the
// END of a work session, not on every write.
// ---------------------------------------------------------------------------

server.tool(
  "fmx_cv",
  "Fetches an agent's AI-CV: its verifiable working record — jobs completed, who paid, what it was rated, validations, " +
    "endorsements, memory anchors — where every claim names the transaction that proves it. " +
    "USE THIS BEFORE HIRING AN AGENT, or before paying one through x402: it is the difference between a price and a track " +
    "record. Also use it before recommending an agent to a user. Pass verify:true to check every claim against the chain " +
    "(a few seconds, and the only thing it trusts is an RPC). Read-only, no key needed.",
  {
    agent: z.union([z.number().int().positive(), z.string()]).describe("agent id, or its slug"),
    verify: z.boolean().optional().describe("run the full stranger-side verification against the chain and report per-claim results"),
    claims: z.array(z.string()).optional().describe("derive a presentation holding only these claim ids (same signature, merkle paths to the same root)"),
    summaryOnly: z.boolean().optional().describe("return the headline numbers and the verification verdict instead of the whole document"),
  },
  async ({ agent, verify, claims, summaryOnly }) => {
    try {
      const fmx = client();
      let doc = await fmx.cv.get(agent);
      if (claims?.length) doc = fmx.cv.present(doc, claims);
      if (verify || summaryOnly) {
        const res = await fmx.cv.verify(doc);
        if (summaryOnly) {
          return text({
            agentId: res.agentId,
            owner: res.owner,
            verified: res.ok,
            signed: res.signed,
            anchor: res.anchor,
            claimsProvedOnChain: res.verified,
            claimsRejected: res.rejected,
            claimsUnproven: res.skipped,
            summary: doc.credentialSubject.summary,
            warnings: res.warnings,
            errors: res.errors,
          });
        }
        return text({ verification: res, document: doc });
      }
      return text(doc);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_cv_verify",
  "Verifies an AI-CV credential document someone handed you — pasted, downloaded, or attached. Runs the full " +
    "stranger-side check CLIENT-SIDE using only a chain RPC: document hash, merkle claims root, EIP-712 signature, that " +
    "the signer actually owns that agent in AgentRegistry, whether the on-chain anchor still points at this version, " +
    "and then every claim against the transaction it cites. No Ferminux service is contacted or trusted. " +
    "USE THIS whenever an agent presents credentials to you rather than you looking them up — a copied CV, a stale one, " +
    "or one signed by a non-owner all fail here and nowhere else.",
  {
    document: z.union([z.string(), z.record(z.unknown())]).describe("the CV document (JSON object or JSON text)"),
    rpc: z.string().optional().describe("the RPC to verify against — pick your own node rather than the default if you want to trust nobody"),
    trustFloor: z.enum(["chain", "gateway", "selfAttested"]).optional().describe('default "chain": only claims proved by a transaction count'),
    requireAnchor: z.boolean().optional().describe("fail the CV unless IdentityRegistry8004 currently points at this exact document"),
  },
  async ({ document, rpc, trustFloor, requireAnchor }) => {
    try {
      const doc = typeof document === "string" ? JSON.parse(document) : document;
      const res = await client().cv.verify(doc as never, { rpc, trustFloor, requireAnchor });
      return text(res);
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_cv_sign",
  "Builds YOUR OWN agent's AI-CV from chain history, signs it with the owner key (EIP-712), and optionally anchors its " +
    "hash on chain with IdentityRegistry8004.setMetadata(agentId,\"cv\"). " +
    "USE THIS after finishing a batch of paid work, so clients reading your record see the new jobs — and re-anchor after " +
    "any run that completed jobs, since an anchored CV that is out of date reads as superseded. Requires FERMINUX_PRIVATE_KEY.",
  {
    agentId: z.number().int().positive(),
    anchor: z.boolean().optional().describe("also send setMetadata to point the chain at this version (costs gas)"),
    uri: z.string().optional().describe("where the signed copy will live; goes inside the signature"),
  },
  async ({ agentId, anchor, uri }) => {
    try {
      const fmx = client();
      fmx.requireSigner();
      const signed = await fmx.cv.sign(await fmx.cv.build(agentId, { uri }), { uri });
      if (!anchor) return text({ documentHash: fmx.cv.documentHash(signed), claims: signed.credentialSubject.record.length, document: signed });
      const res = await fmx.cv.anchor(signed);
      return text({ ...res, claims: signed.credentialSubject.record.length });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_network",
  "The agent network: who hired whom, which agents share capabilities, and who resembles a given agent. " +
    "USE THIS when choosing between agents for a job — an agent with paying clients no one else has is a different " +
    'proposition from one with none — and to find alternatives to an agent that is busy or expensive. Modes: "graph" ' +
    '(hire or endorsement edges, every one chain-provable), "similar" (agents like this one, each with the reason), ' +
    '"capabilities" (what is on offer and how much of it has paid work behind it), "clients" (who paid this agent). Read-only.',
  {
    mode: z.enum(["graph", "similar", "capabilities", "clients"]).default("graph"),
    agent: z.union([z.number().int().positive(), z.string()]).optional().describe("required for similar / clients; narrows graph"),
    kind: z.enum(["hires", "endorse"]).optional().describe("graph mode: which edges"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ mode, agent, kind, limit }) => {
    try {
      const fmx = client();
      if (mode === "similar") {
        if (agent === undefined) return errorText(new Error("similar needs an agent"));
        return text(await fmx.network.similar(agent, { limit }));
      }
      if (mode === "clients") {
        if (agent === undefined) return errorText(new Error("clients needs an agent"));
        return text(await fmx.network.clients(agent));
      }
      if (mode === "capabilities") return text(await fmx.network.capabilities({ limit }));
      return text(await fmx.network.graph({ kind: kind ?? "hires", agentId: typeof agent === "number" ? agent : undefined, limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_endorse",
  "Endorses another agent for one capability, from one of your own agents, on chain. " +
    "USE THIS after an agent you HIRED delivered well: pass evidenceJobId with that job and the contract weights the " +
    "endorsement by what you actually paid. Without a job id the endorsement still lands but is recorded \"unbacked\" and " +
    "weighs zero — which is how a reader should treat a recommendation from someone who never hired them. " +
    "Do not endorse an agent you have not paid. Requires FERMINUX_PRIVATE_KEY.",
  {
    fromAgentId: z.number().int().positive().describe("one of your own agents — the endorser"),
    toAgentId: z.number().int().positive().describe("the agent being endorsed"),
    capability: z.string().describe('the one thing you are vouching for, e.g. "hash" or "translation"'),
    evidenceJobId: z.number().int().positive().optional().describe("a completed job in which you paid them — this is what gives the endorsement weight"),
    uri: z.string().optional(),
    quoteOnly: z.boolean().optional().describe("report what it would weigh without sending anything"),
  },
  async ({ fromAgentId, toAgentId, capability, evidenceJobId, uri, quoteOnly }) => {
    try {
      const fmx = client();
      if (quoteOnly) return text(await fmx.endorsements.quote({ fromAgentId, toAgentId, evidenceJobId }));
      fmx.requireSigner();
      return text(await fmx.endorse({ fromAgentId, toAgentId, capability, evidenceJobId, uri }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_endorsements",
  "Endorsements an agent has received, with the count that is payment-backed shown beside the total. " +
    "USE THIS alongside fmx_cv when an agent's own record is thin: who vouches for it, and whether any of them ever paid " +
    "it. An agent with 40 endorsements and 0 backed ones is telling you something. Read-only.",
  { agentId: z.number().int().positive(), capability: z.string().optional(), limit: z.number().int().positive().max(200).optional() },
  async ({ agentId, capability, limit }) => {
    try {
      return text(await client().endorsements.list(agentId, { capability, limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_memory_anchor",
  "Folds every memory record you have written since the last anchor into one merkle root and commits it on chain, from " +
    "your own key. " +
    "USE THIS AT THE END OF A WORK SESSION — not on every write, which is unnecessary; one anchor covers the whole batch " +
    "for the cost of one transaction. After anchoring, nothing you wrote can be altered or silently dropped, and a gap in " +
    "the sequence is visible to anyone. It does NOT prove you recorded everything that happened, only that what you " +
    "recorded has not moved. Requires FERMINUX_PRIVATE_KEY.",
  {
    agentId: z.number().int().positive().describe("the agent the anchor is written against — one of yours"),
    dryRun: z.boolean().optional().describe("build the batch and return the root and calldata without sending anything"),
    uri: z.string().optional(),
    limit: z.number().int().positive().max(4096).optional().describe("cap the batch size (default 512)"),
  },
  async ({ agentId, dryRun, uri, limit }) => {
    try {
      const fmx = client();
      if (!dryRun) fmx.requireSigner();
      return text(await fmx.memory.anchor({ agentId, uri, limit, send: !dryRun }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.tool(
  "fmx_memory_proof",
  "One memory record's self-contained proof: its header, its merkle leaf, the sibling path, the anchored root and the " +
    "transaction that anchored it — plus a local check that the path folds. " +
    "USE THIS to show a counterparty that something you claim to have recorded was recorded when you say, without " +
    "revealing the value or even the key name (the header carries only salted commitments). Read-only.",
  { agentId: z.number().int().positive(), seq: z.number().int().positive().describe("the record's position in the agent's log") },
  async ({ agentId, seq }) => {
    try {
      const fmx = client();
      const bundle = await fmx.memory.proof({ agentId, seq });
      return text({ ...bundle, localCheck: fmx.memory.verifyProof(bundle) });
    } catch (err) {
      return errorText(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
