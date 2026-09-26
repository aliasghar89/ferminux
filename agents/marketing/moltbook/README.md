# moltbook-bot

Runs the `ferminux` agent on [Moltbook](https://www.moltbook.com) (the agents-only social
network, 140k subscribers in `general`) as a content engine: researches what ranks, drafts
posts in six formats from live Ferminux numbers, gates every draft on a 0–10 quality score,
posts at the platform ceiling, engages hot threads, and learns from its own results. Node 20,
ESM, no dependencies beyond Node built-ins (global `fetch`).

Strategy, voice and hard rules: [`content/strategy.md`](content/strategy.md). Ranking research
output: `/data/style.md` (regenerated daily).

## What it does, every 10 minutes (`HEARTBEAT_MINUTES`)

Order follows [heartbeat.md](https://www.moltbook.com/heartbeat.md):

1. **Safety gate** — `GET /agents/status`; if it isn't `"claimed"`, stops (exits 1).
2. **Reply to every new comment on our posts** (FAQ/LLM reply, constrained to `facts.md`), then
   marks the post's notifications read. Runs first, every tick.
3. **Direct messages** — answered the same way, best-effort (see "DM handling").
4. **Ranking research** (`src/research.js`, daily, reads only) — top + hot posts from the global
   feed and `general`, `agents`, `ai`, `agenteconomy`, `builds`, `philosophy`, `agentfinance`,
   `technology`; keeps the top 200 in `/data/research.json` and derives `/data/style.md`
   (length, title patterns, formats, hooks, topics that win; a scoring rubric).
5. **Quality loop** (`src/learn.js`, every 6 h, reads only) — re-fetches every post we published,
   aggregates age-normalized score/comments by format, submolt and title pattern into
   `/data/learn.json`.
6. **Publish one post** if the cadence allows (`src/content.js`): pick a format (bandit: 80 % the
   best format in `learn.json`, 20 % explore; per-format daily caps; bounties digest weekly),
   pick a submolt (`general` ≈ 40 %, the rest weighted by `learn.json`), draft it (LLM when
   `LLM_*` is set, else `src/templates.js`), lint it against the hard rules, score it 0–10
   against `style.md` (LLM judge, heuristic fallback), publish at ≥ `MIN_POST_SCORE` (7). A
   failed LLM draft is regenerated once with the editor's reasons, then the template library is
   tried; everything that failed goes to `/data/rejected.jsonl`. The original curated invite
   queue (`src/queue.js`) is one of the formats (`invite`).
7. **Engage hot threads** (`src/comments.js`) — up to `MAX_COMMENTS_PER_TICK` comments per tick,
   paced across the UTC day against the platform cap with `RESERVED_REPLY_SLOTS` kept for step 2;
   `general` hot first, then global rising, then one rotating target submolt; each comment ≥ 2
   sentences about the post's actual claim (LLM, or best-matching topic angle on the template
   path — never the same angle twice in 8 comments, skip the post rather than post filler);
   Ferminux only when relevant; upvote the post; follow the author (≤ 20/day).

### Post formats

| key | what | receipts from |
|---|---|---|
| `data` | what N agents did on-chain this week, one explorer tx link | `/api/stats`, `/api/activity`, `/api/streams`, `/api/tokens`, `/api/leaderboard` |
| `buildlog` | what shipped in the last 3 days, incl. what broke (only if the log says so) | `git log` locally, `content/changelog.md` in the container — **append it when you deploy** |
| `opinion` | one thesis on the agent economy, mechanism, receipt, rule, closing question | `facts.md` + live numbers |
| `tutorial` | ≤ 12 lines an agent can run (faucet → register → job; x402; streams) | `facts.md` |
| `replypost` | strongest response to a trending `general` thread as its own post, linking it | hot feed |
| `bounties` | weekly open-bounties digest with FMX amounts | `/api/bounties` |
| `invite` | the curated 12-post queue, one per window | `src/queue.js` |

Hard rules enforced by `lintDraft` (not just prompted): title states a concrete claim or number
and never starts with the product name; body ≤ 1,200 words; one link in prose (three for the
curated invite queue; URLs inside numbered/bulleted command lines don't count) plus
`https://ferminux.net/llms.txt` as the final line; no emojis; no hype words; never "PoS"/"proof
of stake" (a set of authorised signers confirms blocks → "signers"/"confirmed"; never "bonded",
never a fixed count such as "five signers"); never
"mining/mined/miners"/"hashrate"; never "sealed" (auto-corrected to "confirmed"); never
"EVM Layer 1"/"EVM L1"/"EVM chain" as the lead descriptor; FRC-20 / FRC-721 / FRC-8004, never
ERC-* (auto-corrected); no Ethereum comparisons; no hedge or
disclaimer lines (operator decision 2026-09-22 — the old "FMX has no guaranteed value" line is
gone everywhere and is stripped if an LLM reproduces it).

### Operator CLI

```sh
node src/cli.js research                   # refresh research.json + style.md (reads only)
node src/cli.js draft <format> [submolt]   # one gated draft, printed, not published
node src/cli.js drafts 3                   # three drafts across formats
node src/cli.js learn                      # refresh learn.json
node src/cli.js publish <format> [submolt] # generate, gate, publish ONE post (honours cooldown unless FORCE=1)
```

## Caps and cadence

| Limit | Value | Enforced in |
|---|---|---|
| Posts | 1 / 30 min established, 1 / 2 h first 24 h (account created 2026-09-21T22:01Z), `MAX_POSTS_PER_DAY` (default 48 = ceiling); `MAX_POSTS_PER_DAY_NO_LLM` (4) while no LLM is working (templates only) | `heartbeat.js` (`state.posts`) |
| Duplicate posts | never: a title/content hash already published, or a create call that hands back an existing post ("You already posted this!"), is not counted and marks the template used | `heartbeat.js` `publish()`, `state.content.publishedHashes` |
| Replies in threads | only on our own posts or to comments replying to ours, only to questions, only with a real answer (no canned "out of scope"); 1 per author per thread, 5 per thread on our posts / 2 elsewhere, `MAX_REPLIES_PER_DAY` (10) | `dm.js` `handlePostActivity()` |
| Reply-as-post | 1 per thread author per 7 days | `state.content.replyAuthors` |
| Comments + replies (platform hard cap) | 50/day (20/day first 24 h), 20 s / 60 s cooldown | `state.comments.dailyCounts`, `comments.js` |
| Outreach comments | platform cap − `RESERVED_REPLY_SLOTS` (5), paced over the UTC day + `COMMENT_BURST`, ≤ `MAX_COMMENTS_PER_TICK` (3) per tick | `commentBudget()` |
| Comment on the same post twice | never | `state.comments.seenPostIds` |
| Reply-post on the same thread twice | never | `state.content.repliedThreadIds` |
| Follows | 20/day | `MAX_FOLLOWS_PER_DAY` |
| Format mix | data 4, buildlog 3, tutorial 4, bounties 1 (and ≥ 7 days apart), invite 6, opinion/replypost 12 per day; never the same format twice in a row | `content.js` `FORMAT_DAILY_MAX` |
| Reads / writes | 60/min / 30/min | token-buckets in `api.js` |

On a `429` for a read, the client backs off using `Retry-After` (or the body's `retry_after_seconds` /
`retry_after_minutes`) with exponential growth on repeated hits — see `api.js`. A `429` on a write is
not retried: every write fails fast until the retry-after has passed, so the reply and engagement
loops stop for the rest of the tick. The LLM client switches itself off for `LLM_BACKOFF_HOURS` (6)
after a 401/402/403 (e.g. "Insufficient Balance"), instead of failing on every call.

Every write (post, comment, reply, upvote, follow, DM) is logged to `/data/log.jsonl` with the
resulting id. Nothing here ever prints or logs the API key.

**Risk the operator accepted:** rules.md lists "karma farming (posting excessively)" and
"excessive self-promotion" as restriction-level offenses (shadow cooldowns). Posting at the
ceiling is the operator's call; the quality gate and the Ferminux-only-when-relevant rule are the
mitigation. If our posts stop appearing in `sort=new`, lower `MAX_POSTS_PER_DAY`.

## Verification challenges (read this — it decides whether anything is visible)

Every post and comment this account creates comes back with a math word-problem challenge
(`skill.md` → "AI Verification Challenges"); the content is **hidden until the challenge is
solved** and the platform suspends the account after 10 wrong `/verify` answers in a row.

Observed on 2026-09-22, and different from the docs: the create response carries
`post.verification` / `comment.verification` (code + `challenge_text`, 5-minute expiry) and
`verification_status: "pending"`, but **not** the `verification_required: true` flag the docs
describe. The first version of this bot keyed on that flag, never solved a challenge, and every
post and comment it made (including the seed post `8e0a834d…` and the first content-engine post
`4ab42dd3…`) is still hidden at `pending`. `api.js` now keys on the presence of a
`verification_code` and logs a `create_response` line with the status for every write.

`src/verify.js` tries the LLM first, then the heuristic parser, which handles everything seen so
far: scattered symbols inside words, doubled letters (`tWeNn-Tyy`), hyphenated compounds
(`twenty-five` → `twentyfive`), **space-split words** (`tWeN tY ThReE`), literal operator symbols
(`fourteen * three`), and the words product/sum/difference/quotient; when there are more than two
numbers it takes the pair around the operator word. Without a working LLM it submits only a
*confident* answer (exactly two numbers and one operation named by a strong word — not
"and"/"each"/"total") and otherwise lets the challenge expire — an expired challenge did not count
against the account in testing, a wrong answer does. Logs name the solver that answered.

Safety: `state.verification.consecutiveFailures` counts wrong answers; at `VERIFY_FAIL_CEILING`
(default 4) the heartbeat stops writing (still reads) until the operator resets it or configures
an LLM. `VERIFY_DRY=1` creates content normally but logs `challenge_text` + our answer without
submitting, so a human can check the solver against live challenges (submit by hand with
`POST /verify` inside 5 minutes if the answer is right). Every challenge, answer and result is in
`log.jsonl` (`verify` / `verification_unsolved` / `verification_submit_failed`).

## DM handling

`skill.md`/`heartbeat.md` document DM *state* (`home.your_direct_messages`: unread + pending
requests) but not a documented send/list REST endpoint the way posts/comments are. Rather than
invent one, `src/dm.js` follows the same pattern the API already uses on `/home`
(`activity_on_your_posts[].suggested_actions` are literal `"METHOD /path"` strings to execute):
if a DM/conversation object carries an endpoint hint, it's used as given; if not, the DM is
logged for the human instead of guessed at. New DM requests and anything flagged
`needs_human_input: true` are always escalated (logged, never auto-answered), per
`heartbeat.md`'s own "when to tell your human" list.

## FAQ / replies

`facts.md` (in this directory) is the only source of truth for replies — extracted from
`agents/SPEC.md` and `https://ferminux.net/llms-full.txt`, covering: register, price, how paid,
x402, MCP, bond, chain (a set of authorised signers — **never** "bonded", "proof of stake" or a fixed count), FMX token value, who runs it,
and "is it a scam." If `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` are all set, replies are
generated by that OpenAI-compatible endpoint with a system prompt constrained to `facts.md`;
otherwise `src/faq.js`'s pattern-matched templates answer directly. Anything outside `facts.md`
gets "that's outside what I can answer confidently" and a pointer to
https://ferminux.net/forum/ — never a guess, never an argument.

## Invite queue (format `invite`)

12 curated posts, each tailored to its submolt (`src/queue.js`), published as the `invite` format when the bandit picks it (≤ 6/day). Every entry passes `lintDraft`; one that fails is skipped, not published. Every post links
`https://ferminux.net/llms.txt`, one deeper link, and the line "The chain, contracts and gateway
are live and callable right now." Voice: plain, first person as the network's agent, no hype
words, no emojis.

Some submolts named in the original brief don't exist on Moltbook (checked via `GET /submolts`
on 2026-09-21 — only 20 submolts exist total) and are mapped to the closest real one:
`agentcommerce`→`trading`, `ai-agents`→`ai`, `usdc`→`general`, `agentskills`→`technology`,
`showandtell`→`builds`. `agents`, `crypto`, `tooling`, `agentfinance`, `infrastructure`,
`introductions`, and `builds` all exist under those exact names and are used directly.

| # | Submolt | Topic |
|---|---|---|
| 0 | agenteconomy | (already posted, before this bot existed) |
| 1 | trading | how agent-to-agent escrow payment settles |
| 2 | agents | on-chain identity/reputation for agent workflows |
| 3 | ai | why an agent economy needs its own chain |
| 4 | crypto | chain facts + honest framing |
| 5 | general | paying in with USDC |
| 6 | technology | install the Ferminux skill |
| 7 | builds | what we built, with live `/api/stats` numbers |
| 8 | tooling | the MCP server one-liner |
| 9 | agentfinance | x402 pay-per-call + streams |
| 10 | infrastructure | chain facts (chain 3961, an authorised signer set, 7s blocks) |
| 11 | introductions | who I am |

The `agentskills` post links `https://ferminux.net/skills/ferminux/SKILL.md` — as of this bot's
build, that URL 200s but serves the site's SPA shell, not a raw SKILL.md file yet. Confirm it
serves real content before that post's window comes up, or it'll invite agents to "install" a
page that isn't a skill file.

## Operating

```
DRY_RUN=1   # plan everything, write nothing (default posture for first run)
PAUSED=1    # heartbeat still runs/checks in but performs zero writes — pause
            # without stopping/removing the container
```

State lives at `/data/state.json` (queue cursor, daily counters, seen/answered ids, every post
we published with its format/score — survives restarts). Logs at `/data/log.jsonl`. Also under
`/data`: `research.json` + `style.md` (daily), `learn.json` (6-hourly), `rejected.jsonl` (drafts
that failed the gate, with reasons). All need the `/data` volume mounted (the Dockerfile
declares `VOLUME /data`; mount a named volume, e.g. `-v moltbook-bot-data:/data`).

`CONTENT_ENGINE=0` turns the engine off (invite queue only). `MIN_POST_SCORE` moves the gate.
The container has no git, so build-log posts read `content/changelog.md` — append a dated
bullet list when you deploy, failures included.

### Local run

```sh
cd agents/marketing/moltbook
MOLTBOOK_API_KEY=... DRY_RUN=1 DATA_DIR=./tmp-data node src/index.js        # loops every 10 min
MOLTBOOK_API_KEY=... DRY_RUN=1 DATA_DIR=./tmp-data MOLTBOOK_RUN_ONCE=1 node src/index.js  # one tick, exit
```

### Docker (operator deploys — this bot does not deploy itself)

```sh
cd agents/marketing/moltbook
docker build -t moltbook-bot .
docker run -d --name moltbook-bot --restart unless-stopped \
  -e MOLTBOOK_API_KEY=... -e DRY_RUN=1 -v moltbook-bot-data:/data moltbook-bot
```

## Files

- `src/index.js` — entrypoint, loop/once, PAUSED handling
- `src/cli.js` — operator CLI (research / draft / drafts / learn / publish)
- `src/config.js` — env parsing
- `src/state.js` — persistent JSON state (`/data/state.json`)
- `src/log.js` — `/data/log.jsonl` writer
- `src/api.js` — Moltbook REST client: auth, rate-limit token buckets, 429 backoff, verification
- `src/verify.js` — math-challenge solver (LLM first, heuristic fallback)
- `src/heartbeat.js` — one tick, in heartbeat.md priority order
- `src/research.js` — ranking research → `research.json`, `style.md`
- `src/content.js` — format/submolt bandit, LLM drafting, `lintDraft`, scoring, rejected log
- `src/templates.js` — curated template library (no-LLM path and fallback)
- `src/ferminux.js` — live Ferminux data (stats/activity/leaderboard/streams/tokens/bounties/changelog)
- `src/learn.js` — quality loop → `learn.json`
- `src/comments.js` — hot-thread engagement (comments, upvotes, follows), trending-thread picker
- `src/queue.js` — the curated 12-post invite queue
- `src/dm.js` — replies on our posts + DM handling
- `src/faq.js` — FAQ pattern matcher + LLM-constrained answer generator
- `src/llm.js` — minimal OpenAI-compatible chat client (optional)
- `facts.md` — the only source of truth for FAQ/LLM replies and post facts
- `content/strategy.md` — what ranks, voice, formats, rules, cadence, risk
- `content/changelog.md` — shipped items for build-log posts (append on deploy)
- `Dockerfile` — see "Operating" above
