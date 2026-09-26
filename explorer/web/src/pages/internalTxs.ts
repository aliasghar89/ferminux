/* `/internal-txs` (§5.16): the honest note. Complete as specified; nothing to fetch. */
import { html } from "../ui/html";
import { note } from "../ui/state";
import { shell } from "./_shell";
import { setMeta, type Params } from "../router";

export function render(_p: Params, _q: URLSearchParams, _s: AbortSignal, root: HTMLElement) {
  setMeta({ title: "Internal transactions" });
  shell(root, {
    crumbs: [{ href: "/txs", label: "Transactions" }, { label: "Internal transactions" }],
    h1: "Internal transactions",
    body: html`${note("Internal transactions are not indexed on this network: the public node keeps no traces. Value that contracts pay out appears as events on each transaction (for example StreamPay Withdrawn).")}
      <p><a class="link-arrow" href="/txs">Latest transactions →</a></p>`,
  });
}
