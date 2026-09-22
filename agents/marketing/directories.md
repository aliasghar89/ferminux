# Where to list Ferminux — checklist

URLs verified on 2026-09-22 by fetching or searching each one; "Verified" says how. Two blockers apply across the table: `ferminux-mcp` is **not on npm yet** (tarball only) and there is **no public GitHub repository**. Anything marked "needs npm" or "needs GitHub" is blocked until the operator publishes; everything else can be done today with the listed login. The build agent has no logins, so every row is for the operator.

Priority order: rows 1–4 (agents find MCP servers there), 12 (llms.txt directories are cheap), 16–17 (launch surfaces), then the rest.

| # | Directory | Exact URL (submit / form / repo) | What it needs | Login needed | Verified |
|---|---|---|---|---|---|
| 1 | Official MCP Registry | Quickstart: https://modelcontextprotocol.io/registry/quickstart — publishes to registry.modelcontextprotocol.io via the `mcp-publisher` CLI | **Package on npm first**; `mcpName` field in package.json; a `server.json`; namespace `io.github.<user>/ferminux-mcp` (GitHub auth) or `net.ferminux/ferminux-mcp` via a DNS TXT record on ferminux.net (`mcp-publisher login dns`) | GitHub OAuth device flow, or DNS TXT for the custom namespace | Yes — quickstart page fetched; steps current |
| 2 | Smithery | https://smithery.ai/new | GitHub repo with `smithery.yaml`, `package.json` (module field), an `index.ts` exporting `createServer`; then name / description / category / repo URL → Deploy | GitHub (WorkOS OAuth; confirmed by live redirect) | Yes |
| 3 | Glama | No form — auto-indexes public GitHub repos; claim the listing at `https://glama.ai/mcp/servers/<org>/<repo>` once it appears | **Public GitHub repo** (or npm package) for the server | GitHub, only to claim | Yes (behaviour confirmed from several sources) |
| 4 | PulseMCP | https://www.pulsemcp.com/submit | Name, description, repo link | none stated | **Paused** — submissions closed while ingestion is reworked; re-check monthly |
| 5 | mcp.so | https://mcp.so/submit?type=server | Name, description, features, connection info; free review queue or $39 one-time for instant + verified badge | none required (GitHub issue/PR path also exists) | Yes — form fetched |
| 6 | mcpservers.org | https://mcpservers.org/submit | Server name, category, short description, repo/website/docs URL, contact email; optional "official registry name"; free or paid expedite | none (email) | Yes — form fetched |
| 7 | cursor.directory (MCP) | https://cursor.directory/mcp | unknown — page rate-limited (HTTP 429) on two fetches | unknown | **No** — retry |
| 8 | awesome-mcp-servers (punkpeye) | https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md | Fork, add one line in the right category in alphabetical order, open a PR; the repo fast-tracks PRs whose title starts with three robot emoji (their convention) | GitHub | Yes — CONTRIBUTING fetched |
| 9 | awesome-a2a (pab1it0) | https://github.com/pab1it0/awesome-a2a | PR adding the agent entry (name, description, agent-card link: `https://ferminux.net/a/oracle/.well-known/agent.json`, plus the network card `https://ferminux.net/.well-known/agent.json`) | GitHub | Yes — repo active, PR flow confirmed; CONTRIBUTING text not fetched |
| 10 | x402 ecosystem / awesome-x402 | Self-serve: https://x402scan.com/resources/register — submit an x402-enabled URL; if it returns a valid 402 schema it is auto-listed. Awesome-x402 lists on GitHub are fragmented forks; no canonical repo identified | A live 402 URL: `https://ferminux.net/a/oracle/invoke`. Note our scheme is `ferminux-voucher` on `ferminux:3961`, not the USDC/Base scheme — x402scan may reject the schema; ask them | none for x402scan; GitHub for list PRs | Partial — register page exists; field list not retrievable |
| 11 | ERC-8004 explorers | https://8004scan.io (AltLayer) · https://agentscan.info (21+ chains) | Both track agents on chains they already index. **No self-serve path to add chain 3961**; email/DM the teams with `IdentityRegistry8004` address (from https://ferminux.net/.well-known/ferminux.json), RPC https://rpc.ferminux.net, explorer, and the registration-file URL pattern `https://ferminux.net/api/agents/{id}/erc8004.json` | wallet for per-agent registration on supported chains; direct contact for a new chain | Partial — sites confirmed; onboarding process is outreach |
| 12 | llmstxt.site | https://llmstxt.site/submit | Product name, website, your name, email, llms.txt URL (https://ferminux.net/llms.txt), llms-full.txt URL (https://ferminux.net/llms-full.txt), notes | email only | Yes — form fetched |
| 13 | directory.llmstxt.cloud | https://directory.llmstxt.cloud ("Join") | site URL + llms.txt URL (exact fields unconfirmed) | unknown | Partial |
| 14 | Moltbook (agent social network) | API `POST https://www.moltbook.com/api/v1/agents/register` (use `www`; the bare domain strips the auth header) · skill doc https://moltbook.com/skill.md · docs https://moltbook.com/developers | Agent name + description → returns api_key, claim_url, verification_code; a human opens claim_url to claim. Register the Toolbox and Oracle agents there and post the invitation text | Moltbook account for the human claim step | Yes — endpoint and gotcha confirmed |
| 15 | aiagentsdirectory.com | https://aiagentsdirectory.com/submit-agent | Free basic listing (1 yr); paid SEO boost $29 one-time / premium $79/mo | email (confirmation mail) | Yes |
| 16 | theresanaiforthat.com | https://theresanaiforthat.com/s/submit/ | Paid one-off fee (amount not shown pre-login); free option via their monthly X thread for indie makers | account / email | Yes — submit page live |
| 17 | agent.ai | — | could not find a submission page | — | **No** |
| 18 | DexScreener Enhanced Token Info (wFMX) | https://marketplace.dexscreener.com/product/token-info | Chain BNB Chain, contract 0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0, description, socials/links; **$299** one-time, usually processed in under 12 h. Note the pair (0x2bff929a81a73e9ff9fbe476975a36bff189f5e0) is currently not indexed by DexScreener at all (memory gotcha) — confirm it shows before paying | payment only | Yes — price confirmed |
| 19 | CoinGecko | https://support.coingecko.com → Request & Listing → "New Coin/Token Listing" | Token tradable on a tracked exchange (PancakeSwap v2 pair qualifies); mandatory fields + logo; Regular Pass (≤ 5 days) or paid Fast Pass (24 h; price not confirmed) | CoinGecko account | Yes — process confirmed |
| 20 | CoinMarketCap | https://support.coinmarketcap.com → Submit a request → "[New Listing] Add crypto asset" | Long form: team, investors, evidence-backed claims; standard queue free but backlogged; CMC Priority is paid (order of $5,000 for 24 h). CMC warns that "guaranteed listing" resellers are scams | CMC account | Yes |
| 21 | Product Hunt | https://www.producthunt.com (post) · rules https://help.producthunt.com/en/articles/479557-how-to-post-a-product | Maker account (30+ days old preferred), 240×240 thumbnail, 3–8 gallery images 1270×760, tagline ≤ 60, description ≤ 260, ≤ 3 topics, first comment; Tue–Thu 00:01 PT; copy in `producthunt.md` | PH account (Twitter / Google / email) | Yes |
| 22 | Hacker News (Show HN) | https://news.ycombinator.com/submit · rules https://news.ycombinator.com/showhn.html | Something people can try; poster present; no vote asks; copy in `show-hn.md` | HN account (email) | Yes |
| 23 | dev.to | https://dev.to/new | Article with `canonical_url` (front matter in Basic Markdown editor, or the gear icon); copy in `devto-article.md` | GitHub / Twitter / Apple / email | Yes |
| 24 | Agent Skills directories (skillsmp.com, skills.sh) | none — both auto-index **public GitHub repos** containing `SKILL.md`; skills.sh installs via `npx skills add <owner>/<repo>` | A public GitHub repo holding `skills/ferminux/SKILL.md` (the copy at https://ferminux.net/skills/ferminux/SKILL.md is not enough); skillsmp filters for 2+ stars | GitHub to host the repo | Yes — no manual submission flow exists |
| 25 | Anthropic Connectors directory (Claude) | https://claude.com/docs/connectors/building/submission | A **remote** MCP server (ours is stdio via npx today; a hosted MCP endpoint would be needed), submitted from Claude.ai org settings; Team or Enterprise org required; listed as a community connector | Claude.ai Team/Enterprise account | Yes — requirement confirmed |
| 26 | OpenAI Apps SDK / ChatGPT app directory | https://developers.openai.com/apps-sdk/app-submission-guidelines | App built on the Apps SDK (extends MCP): connectivity details, test guidelines, directory metadata, country availability | OpenAI developer platform account | Yes |
| 27 | Cursor MCP marketplace (official) | https://cursor.com/docs/context/mcp/directory (curated; no public submission form found) | unclear; likely outreach | unknown | Partial |

## Not verified / gaps

- cursor.directory/mcp returned HTTP 429 twice; submission mechanics unconfirmed.
- directory.llmstxt.cloud exists but exact fields are unconfirmed.
- agent.ai: no submission path found.
- awesome-x402: no canonical repository; several near-identical forks, some low-quality. Use x402scan's register form instead of guessing.
- 8004scan / agentscan: adding a new chain (3961) is outreach, not a form.
- CoinGecko Fast Pass price not confirmed.

## What the operator must do first (unblocks 8 rows)

1. `npm publish` the SDK as `@ferminux/agent` with bin `ferminux-mcp`, and add `"mcpName": "net.ferminux/ferminux-mcp"` to package.json (rows 1, 3, 25 partially).
2. Create a public GitHub repository (at minimum: the SDK/MCP source, `skills/ferminux/SKILL.md`, `smithery.yaml`) — rows 2, 3, 8, 9, 24.
3. Add the DNS TXT record the MCP registry asks for on ferminux.net if the `net.ferminux/*` namespace is wanted (row 1).
4. Decide on the two paid listings: DexScreener token info ($299, only once the pair is indexed) and any CoinGecko/CMC fast pass.
