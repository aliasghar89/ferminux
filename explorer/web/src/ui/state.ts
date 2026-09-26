/* Empty, error and not-found states (§8.2, §8.3, §5.15). Explain why, offer a next step, never a blank
   page and never "Something went wrong". */
import { html, type Html, type Val } from "./html";
import { ApiError, errorText } from "../api";
import { isAbort } from "../util";

/** Dashed box, one line + one link. */
export const empty = (text: Val, link?: { href: string; label: string }) =>
  html`<div class="empty">${text}${link ? html` <a class="link-inline" href="${link.href}">${link.label}</a>` : ""}</div>`;

/** A note with the accent edge (honest gaps: internal transactions, traces). */
export const note = (text: Val) => html`<p class="note">${text}</p>`;

/** The error line for a failed request, with Retry (retries only that request). */
export function errorBox(e: unknown): Html {
  const status = e instanceof ApiError && e.status ? html` <span class="mono">HTTP ${e.status}</span>` : "";
  return html`<div class="state-box"><div class="alert warn" role="alert">${errorText(e)}${status}</div><button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></div>`;
}

/**
 * Render an error into `host` with a working Retry. Aborts (navigation) are ignored: the page is gone.
 * Returns true when it rendered something.
 */
export function showError(host: HTMLElement | null, e: unknown, retry: () => void): boolean {
  if (!host || isAbort(e)) return false;
  host.innerHTML = errorBox(e).s;
  host.querySelector("[data-retry]")?.addEventListener("click", retry, { once: true });
  if (e instanceof ApiError && e.kind === "offline") addEventListener("online", retry, { once: true });
  return true;
}
