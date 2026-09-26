/* Verify docs `/contract-verification`, `/contract_verification`, `/address/:a/contract-verification` (§5.16).
   A live status line from the index's /smart-contracts/verification/config, then the Foundry and Hardhat
   settings (with the address pre-filled when the URL has one), each with a copy button. No form. */
import { html, mount } from "../ui/html";
import { copyBtn } from "../ui/copy";
import { sk } from "../ui/skeleton";
import { short } from "../format";
import { isAddr, isAbort } from "../util";
import { api } from "../api";
import { shell, slot } from "./_shell";
import { setMeta, setSection, type Params } from "../router";

const block = (label: string, code: string) =>
  html`<div class="code-block api-ex"><div class="code-head"><span class="mono">${label}</span>${copyBtn(code, `Copy the ${label} command`)}</div><pre><code>${code}</code></pre></div>`;

export function render(p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  setSection("contracts");
  const a = p.addr && isAddr(p.addr) ? p.addr : null;
  setMeta({ title: "Verify a contract", description: "Verify a contract's source on the Ferminux explorer (chain 3961) with Foundry or Hardhat.", noindex: !!p.addr });
  shell(root, {
    crumbs: a ? [{ href: "/verified-contracts", label: "Contracts" }, { href: `/address/${a}`, label: short(a, 4) }, { label: "Verify" }] : [{ href: "/verified-contracts", label: "Contracts" }, { label: "Verify" }],
    h1: "Verify a contract",
    ident: a ? html`For <a class="mono" href="/address/${a}">${a}</a>` : "Publish a contract's source so its inputs and events read in plain words.",
    body: html`<div data-slot="status"><div class="skel">${sk("60%", "44px")}</div></div>
<section class="panel api-sec" aria-labelledby="vf-f"><div class="panel-head"><h2 id="vf-f">Foundry</h2></div><div class="api-body">
  ${block("forge", `forge verify-contract --chain 3961 --verifier etherscan \\\n  --verifier-url https://explorer.ferminux.net/api/ \\\n  --etherscan-api-key ferminux \\\n  ${a ?? "<address>"} src/MyContract.sol:MyContract`)}
</div></section>
<section class="panel api-sec" aria-labelledby="vf-h"><div class="panel-head"><h2 id="vf-h">Hardhat</h2></div><div class="api-body">
  <p class="api-lead">In <span class="mono">hardhat.config</span>, under <span class="mono">etherscan</span>, then <span class="mono">npx hardhat verify --network ferminux ${a ?? "<address>"}</span>.</p>
  ${block("hardhat.config", `etherscan: {\n  apiKey: { ferminux: "ferminux" },\n  customChains: [{\n    network: "ferminux",\n    chainId: 3961,\n    urls: {\n      apiURL: "https://explorer.ferminux.net/api",\n      browserURL: "https://explorer.ferminux.net",\n    },\n  }],\n}`)}
</div></section>
<p class="api-lead">Any API key is accepted. Contracts deployed by Ferminux show their source on the address page once their bytecode matches the published build.</p>`,
  });
  api.verificationConfig({ signal }).then((c) => {
    if (signal.aborted) return;
    const sol = (c.solidity_compiler_versions ?? []).length > 0;
    const vy = (c.vyper_compiler_versions ?? []).length > 0;
    mount(slot(root, "status"), sol
      ? html`<div class="alert ok" role="status">Verification is available.</div>`
      : html`<div class="alert warn" role="status">Solidity verification is unavailable on this explorer right now.${vy ? " Vyper works." : ""}</div>`);
  }, (e) => {
    if (isAbort(e) || signal.aborted) return;
    mount(slot(root, "status"), html`<div class="alert warn" role="status">The explorer's index didn't answer, so verification status is unknown right now.</div>`);
  });
}
