/* Reveals the "Validators" nav links once ValidatorHub is configured (config.ts). index.html ships them
   `hidden` (data-validators-link) so a build with no hub renders byte-for-byte what it did before this
   lane existed; called once from main.ts, before the router starts. */
import { VALIDATORS_ENABLED } from "./config";

export function initValidatorsNav(): void {
  if (!VALIDATORS_ENABLED) return;
  document.querySelectorAll<HTMLElement>("[data-validators-link]").forEach((el) => { el.hidden = false; });
}
