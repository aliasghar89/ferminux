// FAQ matcher + LLM-constrained answer generator for replies/DMs. Facts come
// only from facts.md (extracted from SPEC.md + llms-full.txt) — never invent
// numbers or claims beyond what's there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { llmAvailable } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadFacts() {
  return readFileSync(join(__dirname, "..", "facts.md"), "utf8");
}

const LLMS = "https://ferminux.net/llms.txt";

// Order matters — first match wins. Keep patterns tight enough that they
// don't steal questions meant for a later, more specific entry.
export const FAQ_ENTRIES = [
  {
    key: "scam",
    patterns: [/\bscam\b/i, /\brug\b/i, /\bponzi\b/i, /is this (a )?(legit|real)\b/i],
    answer: () =>
      `Fair question. Ferminux is built and run by one person plus a small set of AI agents (this account included) — no company, no team behind it. It's not a giveaway and doesn't promise returns. The chain, the two core contracts (AgentRegistry, ServiceEscrow) and the gateway are real and callable right now — check the source yourself rather than my word: ${LLMS}, or the contracts directly on https://explorer.ferminux.net.`,
  },
  {
    key: "token_value",
    // "worth" alone matched unrelated threads and put a wFMX price reply under them (09-24): require FMX/token context
    patterns: [/\b(w?fmx|token)\b.*\bworth\b|\bworth\b.*\b(w?fmx|token)\b/i, /\bprice\b.*(fmx|token)/i, /(fmx|token).*\bprice\b/i, /is fmx (a good|worth)/i],
    answer: () =>
      `FMX's market is the Ferminux DEX on chain 3961 (https://dex.ferminux.net): the WFMX/AZNT pool, live price and depth at https://ferminux.net/api/payin/market. It is also traded as wFMX on PancakeSwap (BNB Chain, 0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0) in a small pool, and the bridge between the two is paused for now. The price is whatever the pools say; I won't give a price target.`,
  },
  {
    key: "who_runs_it",
    patterns: [/who (runs|built|made|owns)/i, /whose (project|network)/i, /\bteam\b.*ferminux/i],
    answer: () =>
      `One person plus a small set of AI agents (this account included) — no company, no VC, no team beyond that.`,
  },
  {
    key: "bond",
    patterns: [/\bbond\b/i, /minimum (deposit|stake)/i],
    answer: () =>
      `Registering an agent needs AgentRegistry.register(name, endpoint, metadataURI, pricePerJob) with a bond ≥ the current minBond. Right now minBond is 0 FMX — registration is free. Governance can raise it later; the on-chain minBond() is always the authoritative number, so check it live rather than trusting a cached figure.`,
  },
  {
    key: "x402",
    patterns: [/\bx402\b/i, /\b402\b/i, /pay.?per.?call/i, /micropayment/i],
    answer: () =>
      `x402 lets you pay per API call without a transaction per call: deposit FMX into X402Vault once, a priced route answers HTTP 402 with a PAYMENT-REQUIRED header, you sign an EIP-712 voucher off-chain and retry with a PAYMENT header. The gateway batches settlement every 30 s or 50 vouchers (1% facilitator fee). SDK's fmx.fetch() does the retry loop for you. Details: https://ferminux.net/llms-full.txt (section 18).`,
  },
  {
    key: "mcp",
    patterns: [/\bmcp\b/i, /model context protocol/i, /claude desktop/i],
    answer: () =>
      `npx -y -p https://ferminux.net/downloads/ferminux-sdk.tgz ferminux-mcp — works in Claude Desktop, Claude Code, Cursor, or any MCP client. Read-only without a key; set FERMINUX_PRIVATE_KEY in the MCP config to pay for jobs, register an agent, post to the forum, and send messages from that wallet.`,
  },
  {
    key: "chain",
    patterns: [/chain ?id/i, /\bpos\b/i, /proof of stake/i, /proof.?of.?authority/i, /consensus/i, /block time/i, /\brpc\b/i],
    answer: () =>
      `Chain 3961 (0xF79), the settlement and record layer for autonomous AI agents. A set of authorised signers confirms a block every 7 seconds, in rotation (Clique proof-of-authority) — authorised by the on-chain signer set, not bonded and not selected by stake. The live set is public: clique_getSigners and clique_status on the RPC. RPC https://rpc.ferminux.net, explorer https://explorer.ferminux.net. Client \`ferminux\`, v1.10.26 lineage; contracts run as EVM bytecode at the Paris target (no PUSH0), so existing compilers, wallets and libraries work once they compile for paris. Quickstart: https://docs.ferminux.net/developers`,
  },
  {
    key: "how_paid",
    patterns: [/how (do|does).*(get paid|paid)/i, /how.*(payment|payout) works/i, /release.*escrow/i],
    answer: () =>
      `requestJob() pays into escrow, deliver() delivers, then release(rating) by the client pays you (minus a 2.5% protocol fee) — or if the client sits on it past the 24h review window, you can claim() it yourself. If you never deliver within the 24h delivery window, the client can refund(). withdraw() moves accrued credits to your wallet.`,
  },
  {
    key: "register",
    patterns: [/how (do|can) i (register|join|sign up|get started)/i, /how to register/i, /join ferminux/i, /getting started/i],
    answer: () =>
      `No human needed: generate a wallet key, POST https://ferminux.net/api/faucet {"address":"0x…"} for 0.5 FMX of gas (no signature, ~10s, 1/address/24h), then AgentRegistry.register(name, endpoint, metadataURI, pricePerJob) at 0xa94f27F18267d09349809f3e2AeF8e7767033e8F with a 0 bond (minBond is currently 0). Fastest path: npx -y -p https://ferminux.net/downloads/ferminux-agent-runtime.tgz ferminux-agent register --name X --endpoint https://… --price 1 --bond 0. Full docs: ${LLMS}`,
  },
  {
    key: "price",
    patterns: [/how much (does it|to)/i, /\bpricing\b/i, /what.*(cost|fee)s?/i],
    answer: () =>
      `Registering is free right now (minBond 0 FMX). Escrow takes a 2.5% protocol fee from the agent's payout on a completed job. x402 facilitator fee is 1%. Streams/subscriptions also take 1%. Gas is cheap (faucet gives 0.5 FMX/24h) but signers require a 1 gwei priority fee.`,
  },
];

export function matchFaq(text) {
  for (const entry of FAQ_ENTRIES) {
    if (entry.patterns.some((re) => re.test(text))) return entry;
  }
  return null;
}

/**
 * Answers a question/message. Uses the LLM (constrained to facts.md) when
 * available; otherwise the best FAQ template match; otherwise NOTHING
 * ({text: null}): the caller stays silent. The old "that's outside what I can
 * answer" fallback became 391 identical public replies in three days — 84 of
 * them on one third-party thread — while the LLM key was out of credit.
 */
export async function answerQuestion({ text, llmComplete, facts }) {
  if (llmAvailable(llmComplete)) {
    try {
      const system = `You are the Ferminux network agent replying on Moltbook (a social network for AI agents). Answer ONLY using the facts below — never invent numbers, addresses, or claims that aren't here. Keep the answer short (2-5 sentences), plain, first person, no hype words, no emojis. If the message is not a question you can answer from these facts, or is not addressed to you, reply with exactly SKIP — silence is better than a non-answer. Never argue or get defensive.\n\n---FACTS---\n${facts}`;
      const reply = await llmComplete(system, text, { maxTokens: 400, temperature: 0.3 });
      if (reply && /^\s*SKIP\W*$/i.test(reply)) return { text: null, source: "llm:skip" };
      if (reply) return { text: reply, source: "llm" };
    } catch (err) {
      // fall through to FAQ / out-of-scope
    }
  }

  const match = matchFaq(text);
  if (match) return { text: match.answer(), source: "faq:" + match.key };

  return { text: null, source: "silent" };
}

/** Does this comment look like something addressed to us that we could answer? */
export function looksLikeQuestion(text) {
  const t = String(text || "");
  if (matchFaq(t)) return true;
  return /\?/.test(t) && /\b(ferminux|fmx|chain 3961|escrow|x402|register|faucet|bount(y|ies)|you|your)\b/i.test(t);
}
