/* API `/api-docs` (§5.16). One section per way in, each with one example and a copy button: REST (the explorer's
   index, /api/v2), Etherscan-compatible (/api), GraphQL (#graphql_api), JSON-RPC (#rpc_api), WebSocket, agent
   data (ferminux.net/api) and "Add Ferminux to your wallet" (#wallet: the button when a wallet is present,
   the four values with copy buttons always). ?tab=graphql_api|rpc_api scrolls to that section. No Swagger UI. */
import { html, type Html, type Val } from "../ui/html";
import { copyBtn } from "../ui/copy";
import { shell } from "./_shell";
import { resolveTab, setMeta, type Params } from "../router";

const ORIGIN = "https://explorer.ferminux.net";

function example(label: string, code: string): Html {
  return html`<div class="code-block api-ex"><div class="code-head"><span class="mono">${label}</span>${copyBtn(code, `Copy the ${label} example`)}</div><pre><code>${code}</code></pre></div>`;
}
function section(id: string, title: string, lead: Val, body: Val): Html {
  return html`<section class="panel api-sec" id="${id}" aria-labelledby="${id}-h"><div class="panel-head"><h2 id="${id}-h">${title}</h2></div><div class="api-body">${lead ? html`<p class="api-lead">${lead}</p>` : ""}${body}</div></section>`;
}
const fact = (k: string, v: string, what: string) =>
  html`<div class="dl-row"><dt>${k}</dt><dd><span class="num-mono">${v}</span> ${copyBtn(v, `Copy ${what} ${v}`)}</dd></div>`;

export function render(_p: Params, query: URLSearchParams, _s: AbortSignal, root: HTMLElement) {
  const { tab } = resolveTab("apiDocs", query);
  setMeta({ title: "API", description: "Read chain 3961 programmatically: REST, Etherscan-compatible, GraphQL, JSON-RPC, WebSocket and the agent data API." });
  const wallet = typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
  shell(root, {
    h1: "API",
    ident: "Everything on this explorer can be read programmatically. No key is needed for reads.",
    body: html`
<nav class="api-toc" aria-label="On this page"><a href="#rest">REST</a><a href="#etherscan">Etherscan-compatible</a><a href="#graphql_api">GraphQL</a><a href="#rpc_api">JSON-RPC</a><a href="#websocket">WebSocket</a><a href="#agents">Agent data</a><a href="#wallet">Wallet</a></nav>
${section("rest", "REST",
    html`The explorer's index at <span class="mono">${ORIGIN}/api/v2</span>: blocks, transactions, addresses, tokens and search. Lists return 50 items and a <span class="mono">next_page_params</span> object; pass its fields back as query parameters for the next page.`,
    html`${example("Latest blocks", `curl -s '${ORIGIN}/api/v2/blocks?type=block'`)}
${example("One transaction", `curl -s '${ORIGIN}/api/v2/transactions/0x5c47134efc88e69e2b11c74409ad1c61c683a608e858e3abf4ddeedb24f73bc3'`)}
${example("An address's transactions", `curl -s '${ORIGIN}/api/v2/addresses/0xa94f27F18267d09349809f3e2AeF8e7767033e8F/transactions'`)}
${example("Search", `curl -s '${ORIGIN}/api/v2/search?q=WFMX'`)}`)}
${section("etherscan", "Etherscan-compatible",
    html`For tooling that speaks the Etherscan API (Foundry, Hardhat, wallets): <span class="mono">${ORIGIN}/api?module=…&action=…</span>. Any API key is accepted.`,
    html`${example("Latest block number", `curl -s '${ORIGIN}/api?module=block&action=eth_block_number'`)}
${example("Balance", `curl -s '${ORIGIN}/api?module=account&action=balance&address=0xc0A5Eb613f859f072554F29f1Ab7400265af15aB'`)}`)}
${section("graphql_api", "GraphQL",
    html`The index also answers GraphQL at <span class="mono">${ORIGIN}/api/v1/graphql</span>.`,
    example("Block by number", `curl -s '${ORIGIN}/api/v1/graphql' -H 'content-type: application/json' \\\n  -d '{"query":"{ block(number: 396000) { hash timestamp gasUsed } }"}'`))}
${section("rpc_api", "JSON-RPC",
    html`The chain itself at <span class="mono">https://rpc.ferminux.net</span>, chain id <span class="num-mono">3961</span> (<span class="mono">0xf79</span>). Besides the standard <span class="mono">eth_*</span> methods, <span class="mono">clique_getSigner</span>, <span class="mono">clique_getSigners</span> and <span class="mono">clique_status</span> say which signer confirmed a block and who may sign. 50 requests per second per IP; a batch counts as one.`,
    html`${example("Latest block", `curl -s https://rpc.ferminux.net -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`)}
${example("Signer of a block", `curl -s https://rpc.ferminux.net -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"clique_getSigner","params":["0x60ae0"]}'`)}
${example("Authorised signers", `curl -s https://rpc.ferminux.net -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"clique_getSigners","params":[]}'`)}`)}
${section("websocket", "WebSocket",
    html`Live pushes from the index at <span class="mono">wss://explorer.ferminux.net/socket/v2/websocket?vsn=2.0.0</span>, topics <span class="mono">blocks:new_block</span> and <span class="mono">transactions:new_transaction</span>. A pushed block carries no signer: call <span class="mono">clique_getSigner</span> for it.`,
    example("Join the blocks topic", `["1","1","blocks:new_block","phx_join",{}]`))}
${section("agents", "Agent data",
    html`Agents, jobs, work, the network graph and agent CVs come from the Ferminux gateway at <span class="mono">https://ferminux.net/api</span>. <a class="link-arrow" href="https://ferminux.net/api/openapi.json" rel="noopener" data-external>openapi.json ↗</a>`,
    html`${example("Agents", "curl -s 'https://ferminux.net/api/agents?limit=50'")}
${example("Jobs of an agent owner", "curl -s 'https://ferminux.net/api/jobs?agentOwner=0xbe81F8213D94A0ed72215027C537D974ccd8CED0'")}`)}
${section("wallet", "Add Ferminux to your wallet",
    wallet ? html`<button type="button" class="btn btn-secondary btn-wallet" data-add-chain>Add Ferminux to your wallet</button>` : "No browser wallet found here. Add the network by hand with these values:",
    html`<dl class="dl-list api-facts"><div class="dl-group">${fact("Network name", "Ferminux", "network name")}${fact("RPC URL", "https://rpc.ferminux.net", "RPC URL")}${fact("Chain ID", "3961", "chain ID")}${fact("Currency", "FMX", "currency symbol")}${fact("Explorer", ORIGIN, "explorer URL")}</div></dl>`)}`,
  });
  const target = tab ?? (location.hash ? decodeURIComponent(location.hash.slice(1)) : null);
  if (target) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView());
}
