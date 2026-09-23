// Content engine. Picks a format + submolt (bandit over /data/learn.json),
// drafts a post (LLM when configured, curated templates otherwise), lints it
// against the hard rules, scores it 0–10 against /data/style.md, and returns
// a publishable draft or records the rejection in /data/rejected.jsonl.
//
// Formats: data | buildlog | opinion | tutorial | replypost | bounties | invite
// ("invite" is the original curated queue in queue.js — handled by heartbeat.js,
// this module only decides when to pick it).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadFerminuxData, dataPack } from "./ferminux.js";
import { renderTemplate } from "./templates.js";
import { loadStyle } from "./research.js";
import { loadLearn } from "./learn.js";
import { loadFacts } from "./faq.js";

export const LLMS = "https://ferminux.net/llms.txt";
export const FORMATS = ["data", "buildlog", "opinion", "tutorial", "replypost", "bounties", "invite"];

// Where each format lands by default; weights are relative and get multiplied
// by learn.json submolt weights. `general` always stays around 40 % overall
// through the global weighting in pickSubmolt.
const FORMAT_SUBMOLTS = {
  data: { general: 4, agenteconomy: 2, agentfinance: 2, builds: 1 },
  buildlog: { builds: 3, general: 3, technology: 1, agents: 1 },
  opinion: { general: 4, agenteconomy: 2, philosophy: 1.5, ai: 1.5, agents: 1 },
  tutorial: { agents: 3, builds: 2, technology: 2, general: 2 },
  replypost: { general: 5, agents: 1, ai: 1 },
  bounties: { agentfinance: 3, agenteconomy: 2, general: 2 },
};
export const TARGET_SUBMOLTS = ["general", "agents", "ai", "agenteconomy", "builds", "agentfinance", "philosophy", "technology"];
const GENERAL_SHARE = 0.4;

// Per-day ceilings per format so the mix stays a mix even when one format wins the bandit.
const FORMAT_DAILY_MAX = { data: 4, buildlog: 3, opinion: 12, tutorial: 4, replypost: 12, bounties: 1, invite: 6 };
const BOUNTIES_MIN_GAP_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Hard rules

const BANNED = [
  { re: /\bproof[- ]of[- ]stake\b|\bPoS\b/g, why: "PoS (Ferminux signers are not selected by stake)" },
  { re: /\b(mining|mined|miners?|hashrate)\b/gi, why: "mining vocabulary (say signers/confirmed)" },
  { re: /\b(sealed|seals|sealing)\b/gi, why: "\"sealed\" (blocks are confirmed by signers)" },
  // The lead-descriptor rule: compatibility is a later line, never the opening
  // claim. Catches "EVM Layer 1 / EVM L1 / EVM chain / EVM blockchain / EVM network".
  { re: /\bEVM[- ]?(Layer[- ]?1|L1|L-1|chain|blockchain|network)\b/gi, why: "\"EVM <noun>\" as the lead descriptor (lead with: settlement and record layer for AI agents, chain 3961)" },
  { re: /\bERC-?(20|721|8004)\b/g, why: "ERC-* (use FRC-20/FRC-721/FRC-8004)" },
  { re: /\bEthereum\b|\bETH\b(?!\s*on Base)/g, why: "Ethereum comparison" },
  { re: /\p{Extended_Pictographic}/gu, why: "emoji" },
  { re: /\b(revolutionary|game[- ]?changing|unleash|next[- ]gen|to the moon|100x|guaranteed returns|paradigm|cutting[- ]edge|seamless|supercharge)\b/gi, why: "hype word" },
  { re: /no guaranteed value|the network is new|we are (small|new|early)|still early|bear with us/gi, why: "hedge/disclaimer line (operator: none)" },
];

function wordCount(s) {
  return String(s || "").split(/\s+/).filter(Boolean).length;
}

// Blocks on Ferminux are CONFIRMED by signers. "sealed" is the upstream client's
// internal verb for the same act and reads as borrowed vocabulary in public
// copy; the swap is a straight one, so it is auto-fixed rather than rejected.
const SEAL_FIX = [
  [/\bSealed\b/g, "Confirmed"], [/\bsealed\b/g, "confirmed"],
  [/\bSeals\b/g, "Confirms"], [/\bseals\b/g, "confirms"],
  [/\bSealing\b/g, "Confirming"], [/\bsealing\b/g, "confirming"],
];
function unseal(s) {
  let out = String(s || "");
  for (const [re, to] of SEAL_FIX) out = out.replace(re, to);
  return out;
}

/**
 * Normalizes and checks a draft. Returns { draft, violations }. Auto-fixes what
 * is safe to fix (ERC→FRC, sealed→confirmed, strip emojis, strip hedge lines,
 * ensure llms.txt final line); reports the rest as violations. The "EVM <noun>"
 * lead is deliberately NOT auto-fixed — it needs the sentence rewritten, not a
 * word swapped, so it is reported and the draft is rejected.
 */
export function lintDraft(input) {
  let title = String(input.title || "").replace(/\s+/g, " ").trim();
  let body = String(input.body || "").replace(/\r/g, "").trim();
  const violations = [];

  // Auto-fixes.
  title = unseal(title.replace(/\bERC-?(20|721|8004)\b/g, "FRC-$1")).replace(/\p{Extended_Pictographic}/gu, "").trim();
  body = unseal(body.replace(/\bERC-?(20|721|8004)\b/g, "FRC-$1")).replace(/\p{Extended_Pictographic}/gu, "");
  body = body
    .split("\n")
    .filter((l) => !/no guaranteed value|the network is new/i.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Final line must be the llms.txt link, alone.
  const lines = body.split("\n").map((l) => l.trimEnd());
  while (lines.length && (lines[lines.length - 1].trim() === "" || lines[lines.length - 1].trim() === LLMS)) lines.pop();
  body = lines.join("\n").trim() + `\n\n${LLMS}`;

  // Checks.
  const bodyNoFinal = body.slice(0, body.lastIndexOf(LLMS));
  for (const b of BANNED) {
    let text = title + "\n" + bodyNoFinal;
    if (b.why === "Ethereum comparison") {
      // "pay in with USDC on Ethereum/Base/…" is a pay-in fact, not a comparison.
      text = text.split(/(?<=[.!?\n])/).filter((sent) => !/\b(pay-?in|USDC|USDT)\b/i.test(sent)).join("");
    }
    const hit = text.match(b.re);
    if (hit) violations.push(`${b.why}: "${hit[0]}"`);
  }
  // One link max in prose. URLs inside command lines (numbered steps, curl/npx
  // lines, code fences) are part of the instruction, not a link drop.
  const proseLines = bodyNoFinal.split("\n").filter((l) => !/^\s*(\d+[.)]|[-*•]\s|[$>]|curl|npx|npm|POST|GET|```)/.test(l));
  const links = (proseLines.join("\n").match(/https?:\/\/\S+/g) || []).filter((u) => !u.startsWith(LLMS)).length;
  // The curated invite queue predates the one-link rule and carries a deeper link or two; allow 3 there.
  const maxLinks = input.format === "invite" ? 3 : 1;
  if (links > maxLinks) violations.push(`${links} links in body prose (max ${maxLinks} plus the final llms.txt line)`);
  const words = wordCount(bodyNoFinal);
  if (words > 1200) violations.push(`${words} words (max 1200)`);
  if (words < 40) violations.push(`${words} words (too short to say anything)`);
  const tw = wordCount(title);
  if (tw < 4 || tw > 22) violations.push(`title is ${tw} words (want 4–22)`);
  if (title.length > 300) violations.push("title over 300 chars");
  if (/^ferminux\b/i.test(title)) violations.push("title starts with the product name");
  if (/^(introducing|announcing|check out|excited to)/i.test(title)) violations.push("press-release title");
  if (/\bERC-?(20|721|8004)\b/.test(input.title + input.body)) {
    // was auto-fixed; note it so the LLM feedback loop learns
    violations.push("used ERC-* naming (auto-corrected to FRC-*)");
  }
  if (/\b(sealed|seals|sealing)\b/i.test(input.title + input.body)) {
    violations.push('used "sealed" for block production (auto-corrected to "confirmed")');
  }

  return { draft: { ...input, title, body, words, links }, violations };
}

// ---------------------------------------------------------------------------
// Scoring

const STYLE_EXCERPT_CHARS = 5000;

function styleExcerpt(style) {
  if (!style) return "(no style.md yet — use the rubric below)";
  const idx = style.indexOf("## Length");
  return (idx > 0 ? style.slice(0, idx) : style).slice(0, STYLE_EXCERPT_CHARS);
}

/** Heuristic score for the no-LLM path (or when the LLM judge fails). */
export function heuristicScore(draft, violations) {
  let score = 5;
  const t = draft.title;
  const b = draft.body;
  if (/\d/.test(t)) score += 1.5;
  if (/\b(is|are|isn't|not|never|wrong|only|stop|without|no)\b/i.test(t)) score += 1; // makes a claim
  if (/\b(I|my|me)\b/.test(b.slice(0, 300))) score += 0.5;
  if (/0x[0-9a-f]{8,}|explorer\.ferminux\.net|block \d+/i.test(b)) score += 1; // receipts
  if (/\?\s*(\n|$)/.test(b.replace(LLMS, "").trim())) score += 0.5;
  const w = draft.words || wordCount(b);
  if (w >= 80 && w <= 300) score += 1;
  else if (w > 600) score -= 1;
  score -= violations.filter((v) => !/auto-corrected/.test(v)).length * 2;
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

export async function scoreDraft({ draft, violations, llmComplete, style, logger }) {
  if (violations.some((v) => !/auto-corrected/.test(v))) {
    return { score: Math.min(4, heuristicScore(draft, violations)), reasons: violations, judge: "lint" };
  }
  if (llmComplete) {
    try {
      const system = `You are a strict editor for posts on Moltbook, a social network where AI agents post and only agents vote. Score the draft 0-10 for how likely it is to rank in the "general" feed, using the research notes and rubric below. Be harsh on anything that reads like marketing, a press release, or a product announcement; reward one concrete claim in the title, receipts in the body (numbers, ids, tx links, commands), first-person experience, plain language, and a specific closing question. Reply with JSON only: {"score": <number>, "reasons": ["<short reason>", ...]}.

RESEARCH NOTES + RUBRIC:
${styleExcerpt(style)}`;
      const user = `SUBMOLT: ${draft.submolt}\nFORMAT: ${draft.format}\nTITLE: ${draft.title}\n\nBODY:\n${draft.body}`;
      const raw = await llmComplete(system, user, { maxTokens: 300, temperature: 0 });
      const m = raw.match(/\{[\s\S]*\}/);
      const j = JSON.parse(m ? m[0] : raw);
      const score = Math.max(0, Math.min(10, Number(j.score)));
      if (Number.isFinite(score)) return { score, reasons: Array.isArray(j.reasons) ? j.reasons.slice(0, 6) : [], judge: "llm" };
    } catch (err) {
      logger?.warn?.("llm_score_failed", { err: err.message });
    }
  }
  return { score: heuristicScore(draft, violations), reasons: violations, judge: "heuristic" };
}

// ---------------------------------------------------------------------------
// Selection (bandit)

function weightedPick(weights, rnd = Math.random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return null;
  let r = rnd() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Picks the next format. 80 % best-by-learn.json, 20 % explore; respects daily
 * caps, the weekly bounties gap, "invite only while queue has entries", and
 * "replypost only with a trending thread"; avoids repeating the last format.
 */
export function pickFormat({ state, learn, inviteAvailable, threadAvailable, rnd = Math.random }) {
  const today = new Date().toISOString().slice(0, 10);
  const counts = state.content.formatDailyCounts[today] || {};
  const last = state.content.lastFormats.slice(-2);
  const eligible = FORMATS.filter((f) => {
    if ((counts[f] || 0) >= (FORMAT_DAILY_MAX[f] ?? 99)) return false;
    if (f === "invite" && !inviteAvailable) return false;
    if (f === "replypost" && !threadAvailable) return false;
    if (f === "bounties") {
      const lastAt = state.content.lastBountyDigestAt ? new Date(state.content.lastBountyDigestAt).getTime() : 0;
      if (Date.now() - lastAt < BOUNTIES_MIN_GAP_MS) return false;
    }
    return true;
  });
  if (!eligible.length) return null;
  const notRepeated = eligible.filter((f) => f !== last[last.length - 1]);
  const pool = notRepeated.length ? notRepeated : eligible;

  const scores = learn?.byFormat || {};
  const known = pool.filter((f) => scores[f]?.n >= 2);
  if (known.length && rnd() < 0.8) {
    known.sort((a, b) => (scores[b].meanScore ?? 0) - (scores[a].meanScore ?? 0));
    return known[0];
  }
  // Explore: uniform over the pool, but the bounties digest is weekly so it
  // takes its turn as soon as it is eligible.
  if (pool.includes("bounties")) return "bounties";
  return pool[Math.floor(rnd() * pool.length)];
}

export function pickSubmolt({ format, learn, state, rnd = Math.random }) {
  const base = { ...(FORMAT_SUBMOLTS[format] || { general: 1 }) };
  // Learned weights: mean score per submolt, normalized, blended 50/50 with the prior.
  const learned = learn?.bySubmolt || {};
  for (const k of Object.keys(base)) {
    const l = learned[k];
    if (l?.n >= 2 && Number.isFinite(l.meanScore)) base[k] *= 0.5 + 0.5 * Math.min(3, Math.max(0.2, (l.meanScore + 1) / (learn.overallMean + 1 || 1)));
  }
  // Keep general at ~40 % of all posts: if today's share is below, bias to it; if above, bias away.
  const today = new Date().toISOString().slice(0, 10);
  const sub = state.content.submoltDailyCounts[today] || {};
  const total = Object.values(sub).reduce((s, v) => s + v, 0);
  const generalShare = total ? (sub.general || 0) / total : GENERAL_SHARE;
  if (base.general !== undefined) base.general *= generalShare < GENERAL_SHARE ? 2 : 0.5;
  if (rnd() < 0.2) return TARGET_SUBMOLTS[Math.floor(rnd() * TARGET_SUBMOLTS.length)]; // explore
  return weightedPick(base, rnd) || "general";
}

// ---------------------------------------------------------------------------
// Drafting

const VOICE = `You are "ferminux", the outreach agent of Ferminux Network, posting on Moltbook (a Reddit-like network where only AI agents post and vote; humans read). You have a wallet, jobs, streams and a reputation on that chain. Voice: confident builder with receipts. First person. Concrete numbers, tx links, what works today, what ships next. Plain language. No hype words, no emojis, no hedges, no "we are small/new" disclaimers, no legal lines, no apologies.

HARD RULES (a post that breaks one is discarded):
- Title: one concrete claim or number, 6-16 words, could only be written by someone who did the thing. Never start with the product name. Never "Introducing/Announcing".
- Body: 90-260 words unless the format needs more (data digest up to 400; tutorial ≤ 12 numbered lines). Short paragraphs. No bullet walls. At most ONE link inside the body. Do NOT add https://ferminux.net/llms.txt yourself; it is appended automatically as the final line.
- Ferminux is the evidence, not the subject. Lead with the mechanism, decision, or number; mention the network where the receipt comes from.
- When you do describe the network, describe it in its own terms: "the settlement and record layer for autonomous AI agents — chain 3961, five bonded signers confirming a block every 7 seconds". NEVER open with "EVM Layer 1", "EVM L1" or "EVM chain"; bytecode compatibility is a later line for developers, never the first thing said.
- Five bonded signers confirm blocks in rotation: say "signers" and "confirmed". NEVER "PoS", "proof of stake", "mining", "mined", "miners", "hashrate", "sealed".
- Standards: FRC-20 / FRC-721 tokens, FRC-8004 registries. NEVER "ERC-". No Ethereum comparisons at all — Ethereum is a foreign chain you can pay in from, never a yardstick for this one.
- Only facts from the FACTS and DATA sections. Never invent numbers, incidents, tests, quotes or tx hashes. If a receipt is not in DATA, do not claim it.
- End opinion and reply posts with one specific question another agent can answer from its own experience.
Reply with JSON only: {"title": "...", "body": "..."}.`;

const FORMAT_BRIEFS = {
  data: `FORMAT: data post. "What N agents did on-chain this week." Use the STATS, LAST 7 DAYS, TX RECEIPTS, STREAMS, TOKENS lines. Put the most surprising number in the title. Include exactly one explorer tx link as the receipt. Explain what the numbers mean (an agent paid another agent with a contract holding the money), then one thing you learned from the log.`,
  buildlog: `FORMAT: build log. What shipped in the last 3 days (SHIPPED lines), written by the agent that ships it. Name concrete changes with dates. Include what did not go cleanly ONLY if the SHIPPED lines state it (e.g. a defect count) — never invent an incident. Say what ships next (open bounties are a fair source). End with a question about the reader's own shipping rule.`,
  opinion: `FORMAT: opinion/analysis on the agent economy. Pick ONE thesis from: x402 per-call vs streams vs escrow (which unit is right for which work); who pays whom in agent-to-agent work; reputation that can only be written by a payment; agent wallets with session keys and spend caps; A2A cards vs directories; bounties vs jobs. State the thesis in the first sentence as a hard claim, give the mechanism, use one live number or contract from DATA/FACTS as the receipt, name where the thesis fails, end with a rule and one question. Skin in the game: you get paid on this chain.`,
  tutorial: `FORMAT: tutorial an agent can execute in ≤ 12 numbered lines. Pick ONE: (1) faucet → register → first escrow job → withdraw; (2) charge per call with x402 from the server side; (3) open a per-second payment stream / subscription. Use the exact endpoints, commands, contract addresses and limits from FACTS. Title states what the reader can do in how many calls. No prose beyond one intro sentence and one closing sentence.`,
  replypost: `FORMAT: reply-as-post. TREND below is a thread currently ranking in general. Write the strongest response as its own post: agree or disagree with its central claim in the first sentence, add the mechanism or receipt the thread is missing (from DATA/FACTS, only if genuinely relevant — if Ferminux is not relevant, do not force it), and end with a question. Include the original thread link as the single body link: https://www.moltbook.com/post/<id>. The title must be your own claim, not "Re:".`,
  bounties: `FORMAT: weekly open-bounties digest. From OPEN BOUNTIES: list every open bounty as "<FMX> FMX: <title> (by <deadline>)", one per line, largest first. Title states the count, the total FMX, and the largest one. One short paragraph on how a claim gets paid (poster hires the winner through escrow, FMX locked at award, released on delivery) and how to claim (register, then ferminux claim <id> "<pitch>" --agent <yourAgentId>). Body link: https://ferminux.net/api/bounties.`,
};

function threadText(t) {
  if (!t) return "";
  return `TREND (thread in ${t.submolt || "general"} by ${t.author}, ${t.upvotes ?? "?"} upvotes, id ${t.id}):\nTITLE: ${t.title}\nBODY: ${String(t.content || "").slice(0, 1800)}`;
}

async function llmDraft({ format, submolt, data, thread, facts, style, llmComplete, avoidTitles, feedback }) {
  const user = [
    FORMAT_BRIEFS[format],
    `SUBMOLT: ${submolt} (${submoltHint(submolt)})`,
    `RESEARCH NOTES (what ranks):\n${styleExcerpt(style)}`,
    `DATA (live):\n${dataPack(data)}`,
    thread ? threadText(thread) : "",
    `FACTS:\n${facts.slice(0, 9000)}`,
    avoidTitles?.length ? `DO NOT repeat these earlier titles or their angle:\n- ${avoidTitles.slice(-25).join("\n- ")}` : "",
    feedback ? `PREVIOUS DRAFT WAS REJECTED. Editor's reasons: ${feedback.join("; ")}. Fix every one of them.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await llmComplete(VOICE, user, { maxTokens: 1200, temperature: 0.7 });
  const m = raw.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : raw);
  if (!j.title || !j.body) throw new Error("LLM draft missing title/body");
  return { title: String(j.title), body: String(j.body) };
}

function submoltHint(name) {
  return {
    general: "the town square, 140k subscribers, fastest feed; broad agent audience",
    agents: "autonomous agents: workflows, architectures, the craft",
    ai: "AI news, research, tools",
    agenteconomy: "agents earning, paying, hiring each other",
    builds: "build logs, shipped projects, real work",
    agentfinance: "wallets, earnings, budgeting for agents",
    philosophy: "big questions: ethics, meaning, agency",
    technology: "tech news and infrastructure",
  }[name] || "";
}

/**
 * Produces one gated draft for a format/submolt. Tries the LLM up to 2 times
 * (second try with the editor's reasons), then the template library; the
 * template is scored too. Returns { draft, score, reasons, judge, attempts,
 * rejected: [...] } — `draft` is null if nothing reached the threshold.
 */
export async function generatePost({ cfg, state, logger, llmComplete, format, submolt, thread, data, facts, style, threshold = 7 }) {
  const attempts = [];
  const rejected = [];
  const avoidTitles = state.content.usedTitles;
  let feedback = null;

  const tryOne = async (source, produce) => {
    let raw;
    try {
      raw = await produce();
    } catch (err) {
      logger.warn("draft_failed", { format, source, err: err.message });
      return null;
    }
    if (!raw) return null;
    const { draft, violations } = lintDraft({ ...raw, format, submolt, source, threadId: thread?.id || null });
    const { score, reasons, judge } = await scoreDraft({ draft, violations, llmComplete, style, logger });
    const rec = { ...draft, score, reasons, judge, violations, at: new Date().toISOString() };
    attempts.push({ source, score, judge, violations: violations.length });
    if (score >= threshold) return rec;
    rejected.push(rec);
    feedback = [...violations, ...reasons];
    return null;
  };

  let ok = null;
  if (llmComplete) {
    ok = await tryOne("llm", () => llmDraft({ format, submolt, data, thread, facts, style, llmComplete, avoidTitles, feedback }));
    if (!ok) ok = await tryOne("llm-retry", () => llmDraft({ format, submolt, data, thread, facts, style, llmComplete, avoidTitles, feedback }));
  }
  if (!ok) {
    ok = await tryOne("template", async () => renderTemplate(format, data, { thread }, state.content.templateCursor));
  }
  if (rejected.length) recordRejected(cfg, rejected);
  return { draft: ok, attempts, rejected, score: ok?.score ?? null, reasons: ok?.reasons ?? [], judge: ok?.judge ?? null };
}

export function recordRejected(cfg, records) {
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    const path = join(cfg.dataDir, "rejected.jsonl");
    for (const r of records) appendFileSync(path, JSON.stringify(r) + "\n");
  } catch {
    // best effort
  }
}

/** Bookkeeping after a successful publish so the bandit and the "no repeats" rule see it. */
export function recordPublished(state, { postId, format, submolt, title, source, score, judge, threadId }) {
  const today = new Date().toISOString().slice(0, 10);
  state.content.lastFormats.push(format);
  if (state.content.lastFormats.length > 20) state.content.lastFormats.splice(0, state.content.lastFormats.length - 20);
  const fc = (state.content.formatDailyCounts[today] ||= {});
  fc[format] = (fc[format] || 0) + 1;
  const sc = (state.content.submoltDailyCounts[today] ||= {});
  sc[submolt] = (sc[submolt] || 0) + 1;
  for (const key of ["formatDailyCounts", "submoltDailyCounts"]) {
    const keys = Object.keys(state.content[key]).sort();
    while (keys.length > 14) delete state.content[key][keys.shift()];
  }
  state.content.usedTitles.push(title);
  if (state.content.usedTitles.length > 200) state.content.usedTitles.splice(0, state.content.usedTitles.length - 200);
  if (format === "bounties") state.content.lastBountyDigestAt = new Date().toISOString();
  if (threadId) state.content.repliedThreadIds.push(threadId);
  state.published.push({ postId, format, submolt, title, source, score, judge, postedAt: new Date().toISOString(), titlePattern: titlePattern(title) });
  if (state.published.length > 2000) state.published.splice(0, state.published.length - 2000);
}

export function titlePattern(title) {
  const t = String(title || "");
  const tags = [];
  if (/\d/.test(t)) tags.push("number");
  if (/\?/.test(t)) tags.push("question");
  if (/\b(I|I'm|I've|my|me|we)\b/.test(t)) tags.push("firstPerson");
  if (/\b(nobody|no one|wrong|stop|isn't|not|never|don't|only|without|worth nothing)\b/i.test(t)) tags.push("contrarian");
  if (/^(how|why|what|from|open|charge)\b/i.test(t)) tags.push("howto");
  if (/:/.test(t)) tags.push("colon");
  return tags.length ? tags.join("+") : "plain";
}

/** Loads everything a drafting round needs (live data, style, learn, facts). */
export async function loadContentContext(cfg, logger) {
  const [data] = await Promise.all([loadFerminuxData(cfg, logger)]);
  return { data, style: loadStyle(cfg), learn: loadLearn(cfg), facts: loadFacts() };
}
