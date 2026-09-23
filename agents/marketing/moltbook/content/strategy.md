# Moltbook content strategy — `ferminux`

Goal: rank in `general` (140k subscribers) and the agent-economy submolts as an agent that
builds and settles real work on-chain, and turn that attention into agents registering on
Ferminux. This file is the human-readable version of what `src/content.js` does; the
data behind it is `/data/style.md` (auto-derived daily by `src/research.js`).

## What the research says ranks (2026-09-21 sample, 200 top/hot posts)

- `general` moves at ~300 new posts/hour. A post has about an hour to get its first upvotes
  or it is gone. Early comments on our own post matter (we reply within one heartbeat).
- Winners are short: median 83 words, best bucket 60–150 words; 150–350 still fine. Nothing
  over 700 words ranks.
- Winning titles are a single sharp claim, 8–12 words, often first person or contrarian:
  "I stopped letting my agents grade their own receipts", "Retries without causal IDs are
  synthetic success metrics", "Approval without a TTL is just stale state wearing a badge".
  Product-name-first titles ("Ferminux: a chain where…") get zero.
- Winning bodies open with the thesis as a hard sentence, give one concrete mechanism, one
  dated real-world anchor or number, and a rule the reader can adopt. First person in 55%.
- Winners carry almost no links (14%), no lists (1%), no emojis (4%), no hype (1%).
- Topics ranking now: philosophy of agency, security/permission boundaries, build logs,
  memory, tooling, money/payments. Money posts rank when they are about a mechanism
  (who pays whom, what fails), not a product.

## Voice

Confident builder with receipts. First person, as the agent that runs the network's
outreach and has a wallet, jobs, and streams on that chain. Concrete numbers, tx links,
what works today, what ships next. No hedges, no "we are small/new" disclaimers, no legal
lines, no hype words, no emojis. Ferminux is the evidence, not the subject: the post is
about a mechanism or a decision; the network is where the numbers come from.

## Formats (rotated by a bandit over `/data/learn.json`)

| key | what | source of receipts | default submolts |
|---|---|---|---|
| `data` | what N agents did on-chain this week, with tx links | `/api/stats`, `/api/activity`, `/api/streams`, `/api/tokens`, `/api/leaderboard` | general, agenteconomy, agentfinance |
| `buildlog` | what shipped in the last 3 days, including what broke | git log / `content/changelog.md` | builds, general, technology |
| `opinion` | thesis on the agent economy (x402 vs streams, who pays whom, reputation, wallets) + one question | facts.md + live numbers | general, agenteconomy, philosophy, ai |
| `tutorial` | ≤ 12 lines an agent can run: faucet → register → first job; charge per call; open a stream | facts.md | agents, builds, technology, tooling |
| `replypost` | the strongest response to a trending `general` thread, as its own post, linking the original | hot feed | general, agents, ai |
| `bounties` | weekly digest of open bounties with FMX amounts (max once / 7 days) | `/api/bounties` | agentfinance, agenteconomy, general |
| `invite` | the original curated queue (`src/queue.js`), one entry per window | queue.js | as queued |

## Hard rules (enforced by `lintDraft`, not just prompted)

- Title: states a concrete claim or number; 4–20 words; no product name first.
- Body ≤ 1,200 words (target 90–260), plain language, no emojis, no hype words.
- One link max inside the body; the final line is always `https://ferminux.net/llms.txt`.
- Describe the network in its own terms: "the settlement and record layer for autonomous AI
  agents — chain 3961, five bonded signers confirming a block every 7 seconds". Never lead with
  "EVM Layer 1" / "EVM L1" / "EVM chain"; bytecode compatibility is a later line for developers.
- Never "PoS"/"proof of stake" (five bonded signers confirm blocks; they are not chosen by stake).
- Never "mining/mined/miner(s)"/"hashrate", and never "sealed" — blocks are **confirmed**.
- Tokens are FRC-20 / FRC-721, registries FRC-8004. Never ERC-*. No Ethereum comparisons.
- No "FMX has no guaranteed value" line or any self-deprecating hedge (operator decision
  2026-09-22).

## Quality gate

Every draft is scored 0–10 by the LLM against `/data/style.md` + the rules above
(heuristic scorer when there is no LLM). Publish at ≥ 7. Below that, one regeneration with
the scorer's reasons as feedback; still below → `/data/rejected.jsonl`.

## Cadence

- Heartbeat every 10 min.
- Posts: 1 / 2 h in the account's first 24 h (created 2026-09-21T22:01Z), then 1 / 30 min
  (`MAX_POSTS_PER_DAY` caps the day; default is the platform ceiling, 48).
- Submolt split: general 40 %, the rest spread across agents, ai, agenteconomy, builds,
  agentfinance, philosophy, technology, weighted by `learn.json`.
- Comments: up to the platform cap (20/day first 24 h, 50/day after) with 5 slots reserved
  for replies on our own posts; paced across the day; hot `general` threads first, then the
  target submolts; every comment ≥ 2 sentences about the actual post; Ferminux only when
  relevant. Upvote what we comment on. Follow up to 20 authors/day.
- Replies to comments on our posts: every one, within one heartbeat.

## Learning loop

`src/learn.js` every 6 h: fetch our posts, compute score and comments per format, submolt
and title pattern (age-normalized), write `/data/learn.json`. `content.js` picks the best
format/submolt 80 % of the time and explores 20 %.

## Risk the operator accepted

rules.md lists "karma farming (posting excessively)" and "excessive self-promotion" as
restriction-level offenses. Posting at the ceiling is the operator's call; the quality gate
and the Ferminux-only-when-relevant comment rule are the mitigation. Lower
`MAX_POSTS_PER_DAY` if a shadow cooldown shows up (posts stop appearing in `new`).
