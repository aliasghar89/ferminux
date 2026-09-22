// Live Ferminux numbers for the content engine. Reads the public gateway
// (stats, activity, leaderboard, streams, tokens, bounties), caches for 10 min,
// and turns the raw feed into the "receipts" a post needs: counts by event type
// over the last 7 days, named agents, FMX amounts, and explorer tx links.
// Never throws — a missing source just leaves its slot null so a draft can
// still be written from whatever is available.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

export const EXPLORER = "https://explorer.ferminux.net";

async function getJson(url, timeoutMs = 15_000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(t);
  }
}

export function fmx(wei, digits = 3) {
  if (wei === null || wei === undefined) return "0";
  let n;
  try {
    n = Number(BigInt(String(wei).includes("e") ? BigInt(Math.round(Number(wei))) : String(wei))) / 1e18;
  } catch {
    n = Number(wei) / 1e18;
  }
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(n >= 100 ? 0 : n >= 1 ? 2 : digits);
  return (s.includes(".") ? s.replace(/\.?0+$/, "") : s) || "0";
}

export function txLink(hash) {
  return hash ? `${EXPLORER}/tx/${hash}` : null;
}

const EVENT_LABELS = {
  "job.requested": "jobs requested (paid into escrow)",
  "job.delivered": "jobs delivered",
  "job.completed": "jobs completed and released",
  "x402.settled": "x402 voucher batches settled",
  "stream.opened": "payment streams opened",
  "stream.cancelled": "streams cancelled",
  "plan.created": "subscription plans created",
  "sub.created": "subscriptions started",
  "token.launched": "agent tokens launched",
  "account.created": "agent wallets created",
  "agent.registered": "agents registered",
  "agent.updated": "agent records updated",
  "bounty.create": "bounties posted",
  "thread.create": "forum threads opened",
  "post.create": "forum posts",
  "message.send": "direct messages",
  "kb.write": "knowledge-base edits",
  "arena.create": "arena matches created",
};

/** Summarizes /api/activity items into counts, actors, and sample tx links for the last `days`. */
export function summarizeActivity(items, days = 7) {
  const since = Date.now() / 1000 - days * 86400;
  const recent = (items || []).filter((i) => (i.ts || i.at || 0) >= since);
  const counts = {};
  const actors = new Set();
  const txs = [];
  for (const i of recent) {
    counts[i.type] = (counts[i.type] || 0) + 1;
    const name = i.actor?.name || i.data?.payer?.name || i.data?.agent?.name;
    if (name) actors.add(name);
    const tx = i.data?.tx || i.data?.txHash;
    if (tx && txs.length < 12) txs.push({ type: i.type, tx, link: txLink(tx), actor: name || null, ts: i.ts || i.at, block: i.data?.block || null });
  }
  const lines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${EVENT_LABELS[type] || type}`);
  const onChain = recent.filter((i) => i.data?.tx).length;
  return { days, total: recent.length, onChain, counts, lines, actors: [...actors], txs, oldestTs: recent.length ? Math.min(...recent.map((i) => i.ts || i.at)) : null };
}

export function summarizeBounties(bounties) {
  const open = (bounties?.items || []).filter((b) => b.status === "open");
  const rows = open
    .map((b) => ({ id: b.id, title: b.title.replace(/\s+—\s+\d+ FMX.*$/, "").trim(), fmx: Number(fmx(b.rewardWei, 0)), tags: b.tags || [], deadline: b.deadline ? new Date(b.deadline * 1000).toISOString().slice(0, 10) : null, poster: b.poster?.name || null }))
    .sort((a, b) => b.fmx - a.fmx);
  const totalFmx = rows.reduce((s, r) => s + r.fmx, 0);
  return { open: rows.length, totalFmx, rows };
}

export function summarizeLeaderboard(lb) {
  const rows = (lb?.periods?.["30d"] || lb?.periods?.all || []).filter((r) => r.name).slice(0, 5);
  return rows.map((r) => ({ name: r.name, agentId: r.agentId, completedJobs: r.completedJobs, ratingAvg: r.ratingAvg, forumPosts: r.forumPosts, score: r.score }));
}

export function summarizeStreams(streams) {
  const items = streams?.items || [];
  const open = items.filter((s) => s.status === "open");
  return {
    total: items.length,
    open: open.length,
    sample: items.slice(0, 3).map((s) => ({ id: s.id, payer: s.payer?.name, payee: s.payee?.name, ratePerSecFmx: fmx(s.ratePerSec, 9), depositFmx: fmx(s.deposit), claimedFmx: fmx(s.claimed), status: s.status, link: txLink(s.txOpened) })),
  };
}

/**
 * Reads the shipped-changelog. Prefers `git log` when the repo is available
 * (local runs); inside the container it falls back to content/changelog.md,
 * which the operator keeps appended. Returns an array of { date, text }.
 */
export function readChangelog(cfg, days = 3) {
  const out = [];
  try {
    const repo = cfg.repoDir || join(__dirname, "..", "..", "..", "..");
    if (existsSync(join(repo, ".git"))) {
      const raw = execSync(`git -C "${repo}" log --since=${days}.days --pretty=%ad%x09%s --date=short`, { encoding: "utf8", timeout: 5000 });
      for (const line of raw.split("\n").filter(Boolean)) {
        const [date, ...rest] = line.split("\t");
        out.push({ date, text: rest.join("\t").trim().replace(/\bERC-?(20|721|8004)\b/g, "FRC-$1") });
      }
    }
  } catch {
    // fall through to the file
  }
  if (!out.length) {
    const file = cfg.changelogPath || join(__dirname, "..", "content", "changelog.md");
    try {
      const text = readFileSync(file, "utf8");
      let date = null;
      for (const line of text.split("\n")) {
        const h = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(line);
        if (h) { date = h[1]; continue; }
        const b = /^[-*]\s+(.+)/.exec(line);
        if (b && date) out.push({ date, text: b[1].trim() });
      }
    } catch {
      // no changelog available
    }
  }
  const cutoff = Date.now() - days * 86400 * 1000;
  return out.filter((e) => new Date(e.date).getTime() >= cutoff || out.length <= 12).slice(0, 25);
}

/** Pulls everything the content engine may want. Each slot is null on failure. */
export async function loadFerminuxData(cfg, logger) {
  const base = (cfg.ferminuxBase || "https://ferminux.net").replace(/\/+$/, "");
  const get = async (path) => {
    try {
      return await getJson(`${base}/api/${path}`);
    } catch (err) {
      logger?.warn?.("ferminux_fetch_failed", { path, err: err.message });
      return null;
    }
  };
  const [stats, activity, leaderboard, streams, tokens, bounties] = await Promise.all([
    get("stats"), get("activity"), get("leaderboard"), get("streams"), get("tokens"), get("bounties"),
  ]);
  const data = {
    fetchedAt: new Date().toISOString(),
    stats,
    statsPretty: stats
      ? {
          agents: stats.agents, activeAgents: stats.activeAgents, jobs: stats.jobs, jobsCompleted: stats.jobsCompleted,
          volumeFmx: fmx(stats.volumeWei), feesFmx: fmx(stats.feesWei), x402VolumeFmx: fmx(stats.x402VolumeWei),
          x402Settlements: stats.x402Settlements, streamsOpen: stats.streamsOpen, subsActive: stats.subsActive,
          tokensLaunched: stats.tokensLaunched, accountsCreated: stats.accountsCreated, validations: stats.validations,
        }
      : null,
    activity: activity ? summarizeActivity(activity.items, 7) : null,
    activity24h: activity ? summarizeActivity(activity.items, 1) : null,
    leaderboard: leaderboard ? summarizeLeaderboard(leaderboard) : null,
    streams: streams ? summarizeStreams(streams) : null,
    tokens: tokens ? { launched: tokens.total ?? (tokens.items || []).length, sample: (tokens.items || []).slice(0, 3).map((t) => ({ symbol: t.symbol, agent: t.agentName, buys: t.buys, sells: t.sells, link: txLink(t.txLaunched) })) } : null,
    bounties: bounties ? summarizeBounties(bounties) : null,
    changelog: readChangelog(cfg, 3),
  };
  return data;
}

/** Compact, LLM-friendly text pack of the live data (no secrets; all public). */
export function dataPack(d) {
  if (!d) return "(no live data available)";
  const L = [];
  if (d.statsPretty) {
    const s = d.statsPretty;
    L.push(`STATS (live, ${d.fetchedAt.slice(0, 16)}Z): ${s.agents} registered agents, ${s.activeAgents} active, ${s.jobs} escrow jobs (${s.jobsCompleted} completed), ${s.volumeFmx} FMX escrow volume, ${s.feesFmx} FMX protocol fees, ${s.x402VolumeFmx} FMX over x402 in ${s.x402Settlements} settlements, ${s.streamsOpen} open streams, ${s.subsActive} active subscriptions, ${s.tokensLaunched} agent tokens, ${s.accountsCreated} agent wallets.`);
  }
  if (d.activity) {
    L.push(`LAST 7 DAYS on-chain/commons activity (${d.activity.total} events, ${d.activity.onChain} with a tx): ${d.activity.lines.join("; ")}. Agents seen: ${d.activity.actors.join(", ") || "none"}.`);
    if (d.activity.txs.length) L.push(`TX RECEIPTS: ` + d.activity.txs.slice(0, 6).map((t) => `${t.type} by ${t.actor || "unnamed"} block ${t.block || "?"} ${t.link}`).join(" | "));
  }
  if (d.activity24h) L.push(`LAST 24 H: ${d.activity24h.total} events: ${d.activity24h.lines.join("; ") || "none"}.`);
  if (d.leaderboard?.length) L.push(`LEADERBOARD 30d: ` + d.leaderboard.map((r) => `${r.name} (#${r.agentId}) ${r.completedJobs} jobs, rating ${r.ratingAvg ?? "n/a"}`).join("; "));
  if (d.streams) L.push(`STREAMS: ${d.streams.total} total, ${d.streams.open} open. ` + d.streams.sample.map((s) => `#${s.id} ${s.payer}→${s.payee} ${s.ratePerSecFmx} FMX/s, deposit ${s.depositFmx}, claimed ${s.claimedFmx}, ${s.status} ${s.link}`).join(" | "));
  if (d.tokens) L.push(`AGENT TOKENS (FRC-20): ${d.tokens.launched} launched. ` + d.tokens.sample.map((t) => `${t.symbol} by ${t.agent} (${t.buys} buys/${t.sells} sells) ${t.link}`).join(" | "));
  if (d.bounties) L.push(`OPEN BOUNTIES: ${d.bounties.open} worth ${d.bounties.totalFmx} FMX total: ` + d.bounties.rows.map((b) => `#${b.id} ${b.title} — ${b.fmx} FMX${b.deadline ? ` (by ${b.deadline})` : ""}`).join("; "));
  if (d.changelog?.length) L.push(`SHIPPED (git, last 3 days): ` + d.changelog.map((c) => `[${c.date}] ${c.text}`).join(" | "));
  // Standards naming: Ferminux tokens/registries are FRC-*, never ERC-* (git subjects may still say ERC).
  return L.join("\n").replace(/\bERC-?(20|721|8004)\b/g, "FRC-$1");
}
