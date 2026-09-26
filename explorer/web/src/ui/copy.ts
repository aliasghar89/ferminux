/* Copy button (§4.17) and toast. One delegated listener handles every [data-copy] button on every page.
   Success: the icon swaps to a check for 1.2 s and a polite live region says "Copied". No clipboard API:
   the text is selected in a hidden field and the toast says "Press ⌘C to copy". */
import { html, type Html } from "./html";
import { icon } from "./icons";

/** A copy button. `what` names it for readers: "Copy address 0x3322…187d". */
export const copyBtn = (value: string, what = "Copy"): Html =>
  html`<button type="button" class="cp" data-copy="${value}" aria-label="${what}" title="${what}">${icon("i-copy", "ic")}${icon("i-check", "ok")}</button>`;

let toastT = 0;
export function toast(msg: string) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove("show"), 1800);
}
function say(msg: string) {
  const r = document.getElementById("live-polite");
  if (!r) return;
  r.textContent = "";
  window.setTimeout(() => { r.textContent = msg; }, 30);
}

export function initCopy() {
  document.addEventListener("click", async (e) => {
    const b = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-copy]");
    if (!b) return;
    e.preventDefault();
    const v = b.dataset.copy ?? "";
    try {
      await navigator.clipboard.writeText(v);
      b.setAttribute("data-done", "");
      say("Copied");
      window.setTimeout(() => b.removeAttribute("data-done"), 1200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = v; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(ta); ta.select();
      toast(/Mac|iPhone|iPad/.test(navigator.platform) ? "Press ⌘C to copy" : "Press Ctrl+C to copy");
      window.setTimeout(() => ta.remove(), 4000);
    }
  });
}
