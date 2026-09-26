// /developers/ — the deploy quickstart. The page is static HTML so crawlers and agents read every command and
// address without running it; this script adds copy buttons for whole snippets, explorer links on the addresses,
// the live network figures (head, gas limit, base fee, signer count) and each address's bytecode size.
import { config } from "../config";
import { int } from "../format";
import { $, $$, addrHtml, copyText, initChrome } from "../ui";
import { addNetwork, errMessage, readProvider } from "../wallet";

initChrome();

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-block]"); if (!b) return;
  const pre = b.closest(".code-block")?.querySelector("pre"); if (pre) copyText(pre.textContent ?? "", b);
});

$("#dv-add")?.addEventListener("click", async () => {
  const s = $("#dv-add-status")!;
  try { await addNetwork(); s.textContent = "Ferminux added. Switch to it in your wallet."; }
  catch (e) { s.textContent = errMessage(e, "The wallet did not add the network."); }
});

const cells = $$<HTMLTableCellElement>(".dv-addr td[data-addr]");
for (const td of cells) td.innerHTML = addrHtml(td.dataset.addr!, { n: 8, label: td.previousElementSibling?.textContent ?? "Address" });

/** Live figures; each stays as printed (or "—") when its read fails. */
async function loadNetwork() {
  if (config.mock) return;
  const p = readProvider();
  p.getBlock("latest").then((b) => {
    if (!b) return;
    $("#dv-head")!.textContent = `block ${int(b.number)}`;
    $("#dv-gaslimit")!.textContent = int(b.gasLimit.toString());
    if (b.baseFeePerGas != null) $("#dv-basefee")!.textContent = b.baseFeePerGas < 1_000_000n ? `${int(b.baseFeePerGas.toString())} wei` : `${(Number(b.baseFeePerGas) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 })} gwei`;
  }).catch(() => {});
  p.send("clique_getSigners", []).then((list: unknown) => {
    if (Array.isArray(list) && list.length) $("#dv-signers")!.textContent = `a set of ${list.length} authorised signers`;
  }).catch(() => {});
}

/** Bytecode size per address, so a reader sees at a glance that every contract listed is really there. */
async function loadCode() {
  if (config.mock) return;
  const p = readProvider();
  await Promise.all(cells.map(async (td) => {
    const out = td.parentElement?.querySelector<HTMLElement>("[data-code]"); if (!out) return;
    try {
      const code: string = await p.getCode(td.dataset.addr!);
      const bytes = (code.length - 2) / 2;
      out.innerHTML = bytes > 0 ? `<span class="num">${int(bytes)}</span> <span class="faint">bytes</span>` : `<span class="faint">account</span>`;
    } catch { out.textContent = "—"; }
  }));
}

loadNetwork();
loadCode();

// the section in view is marked in the table of contents, as on /docs/
const tocLinks = $$<HTMLAnchorElement>(".toc a");
const io = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) {
    const id = "#" + en.target.id;
    tocLinks.forEach((l) => l.classList.toggle("on", l.getAttribute("href") === id));
  }
}, { rootMargin: "-20% 0px -70% 0px" });
tocLinks.forEach((l) => { const s = document.querySelector(l.getAttribute("href")!); if (s) io.observe(s); });
