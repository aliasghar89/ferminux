// "Connect a wallet" for ferminux.net: Ferminux Wallet first (the web wallet,
// nothing to install), then each injected wallet the browser announces, then
// WalletConnect when the build has a project id. On a phone without a wallet
// app's browser the old hand-off (open this page in MetaMask / Trust /
// Coinbase) is one more row.
//
// It reuses the #fmx-wallet-chooser dialog, so the header partial's focus
// trap, Escape and focus-return apply to it unchanged.

import type { Connection, WalletChoice, WalletConnector } from "../../../shared/fxwallet/connector.ts";
import { esc } from "./format";

export interface ChooserOptions {
  connector: WalletConnector;
  /** Offer the "open in a wallet app" row (a phone with no injected wallet). */
  handoff: () => boolean;
  onHandoff: () => void;
  describeError: (e: unknown) => string;
  cancelled: () => Error;
}

function icon(c: WalletChoice): string {
  if (c.icon) return `<img class="fmx-wc-ico" src="${esc(c.icon)}" alt="" width="30" height="30">`;
  return `<span class="fmx-wc-ico fmx-wc-mono" aria-hidden="true">${esc(c.name.slice(0, 1).toUpperCase())}</span>`;
}

/**
 * Show the chooser and resolve with the connection the user makes. Rejects
 * with `cancelled()` when the dialog is dismissed (Cancel, backdrop, Escape).
 * The click on a row is the user gesture the Ferminux Wallet window needs.
 */
export function openWalletChooser(o: ChooserOptions): Promise<Connection> {
  document.getElementById("fmx-wallet-chooser")?.remove();
  return new Promise<Connection>((resolve, reject) => {
    const wrap = document.createElement("div");
    wrap.id = "fmx-wallet-chooser";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-labelledby", "fmx-wc-title");
    wrap.innerHTML = `
      <div class="fmx-wc-card">
        <h3 id="fmx-wc-title">Connect a wallet</h3>
        <ul class="fmx-wc-list" data-testid="wallet-choices"></ul>
        <p class="fmx-wc-status" role="status" aria-live="polite"></p>
        <button type="button" class="btn btn-secondary" data-close>Cancel</button>
      </div>`;
    const list = wrap.querySelector("ul") as HTMLUListElement;
    const status = wrap.querySelector(".fmx-wc-status") as HTMLElement;
    let busy = false;
    let settled = false;

    const render = () => {
      const rows = o.connector.choices().map(
        (c) => `<li><button type="button" class="fmx-wc-opt" data-choice="${esc(c.id)}" data-testid="choice-${c.kind}"${busy ? " disabled" : ""}>
          ${icon(c)}<span class="fmx-wc-opt-main"><span class="fmx-wc-opt-name">${esc(c.name)}${c.featured ? '<span class="fmx-wc-tag">Recommended</span>' : ""}</span><span class="fmx-wc-opt-detail">${esc(c.detail)}</span></span></button></li>`,
      );
      if (o.handoff()) {
        rows.push(`<li><button type="button" class="fmx-wc-opt" data-handoff data-testid="choice-handoff"${busy ? " disabled" : ""}>
          <span class="fmx-wc-ico fmx-wc-mono" aria-hidden="true">↗</span><span class="fmx-wc-opt-main"><span class="fmx-wc-opt-name">Open in a wallet app</span><span class="fmx-wc-opt-detail">MetaMask, Trust Wallet or Coinbase Wallet</span></span></button></li>`);
      }
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.choice;
      list.innerHTML = rows.join("");
      if (focused) list.querySelector<HTMLElement>(`[data-choice="${CSS.escape(focused)}"]`)?.focus();
    };

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      observer.disconnect();
      wrap.remove();
      settle();
    };
    // Extensions that announce late still show up while the dialog is open.
    const unsubscribe = o.connector.subscribe(() => {
      if (!busy && !settled) render();
    });

    wrap.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === wrap || t.closest("[data-close]")) return finish(() => reject(o.cancelled()));
      if (t.closest("[data-handoff]")) {
        finish(() => reject(o.cancelled()));
        o.onHandoff();
        return;
      }
      const btn = t.closest<HTMLButtonElement>("[data-choice]");
      if (!btn || busy) return;
      busy = true;
      status.textContent = "Waiting for the wallet…";
      list.querySelectorAll("button").forEach((b) => (b.disabled = true));
      // Synchronous inside the click: this is what opens the Ferminux Wallet window.
      o.connector.connect(btn.dataset.choice!).then(
        (conn) => finish(() => resolve(conn)),
        (err) => {
          busy = false;
          status.textContent = o.describeError(err);
          render();
        },
      );
    });
    // The header partial closes the dialog on Escape by removing it.
    const observer = new MutationObserver(() => {
      if (!wrap.isConnected) finish(() => reject(o.cancelled()));
    });
    render();
    document.body.appendChild(wrap);
    observer.observe(document.body, { childList: true });
  });
}
