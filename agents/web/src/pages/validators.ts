// /validators/ — the validator programme while it is in development: what a seat is, the planned terms, and a
// waitlist. Two live reads: the authorised signer set (clique_getSigners, so the page never hard-codes a count
// that the chain can contradict) and the waitlist's public totals (GET /api/validators/waitlist/count). The form
// posts to POST /api/validators/waitlist; the gateway stores one entry per address and never shows a contact.
import { initChrome, $, $$ } from "../ui";
import { esc, int, short } from "../format";
import { config } from "../config";
import { rpc } from "../chainread";
import { onWallet } from "../wallet";
import { checkForm, type WaitlistForm } from "../validatorForm";

initChrome();

const PLATFORM_NAME: Record<string, string> = { windows: "Windows", linux: "Linux", both: "Windows and Linux" };
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/* ---- the signer set, read from the node (the consensus page reads it the same way) ---- */
async function loadSigners() {
  const el = $("#v-signers"); if (!el) return;
  try {
    const signers = await rpc<string[]>("clique_getSigners");
    if (!Array.isArray(signers) || !signers.length) throw new Error("empty");
    el.innerHTML = `${int(signers.length)} right now, <a class="link-inline" href="/consensus.html#signers">listed on the consensus page</a>`;
  } catch { /* keep the static pointer to the consensus page */ }
}

/* ---- the waitlist's public totals ---- */
async function loadCount() {
  const v = $("#v-count"), split = $("#wl-split");
  try {
    const r = await fetch(`${config.gateway}/validators/waitlist/count`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const c = (await r.json()) as { total?: number; seats?: number; byPlatform?: Record<string, number> };
    const total = Number(c.total) || 0, seats = Number(c.seats) || 0, by = c.byPlatform ?? {};
    if (v) v.textContent = plural(total, "sign-up");
    if (split) split.textContent = total
      ? `${plural(total, "address", "addresses")} on the waitlist, ${plural(seats, "seat")} planned · Windows ${int(by.windows ?? 0)} · Linux ${int(by.linux ?? 0)} · both ${int(by.both ?? 0)}`
      : "Nobody has joined yet: be the first.";
  } catch {
    if (v) v.textContent = "—";
    if (split) split.textContent = "";
  }
}

/* ---- the form ---- */
const form = $<HTMLFormElement>("#wl-form")!;
const fields = { address: $<HTMLInputElement>("#wl-address")!, seats: $<HTMLSelectElement>("#wl-seats")!, contact: $<HTMLInputElement>("#wl-contact")!, consent: $<HTMLInputElement>("#wl-consent")! };
const status = $("#wl-status")!;
const submit = $<HTMLButtonElement>("#wl-submit")!;

function values(): WaitlistForm {
  const platform = form.querySelector<HTMLInputElement>('input[name="platform"]:checked')?.value ?? "";
  return { address: fields.address.value, platform, seats: fields.seats.value, contact: fields.contact.value, consent: fields.consent.checked };
}
function showErrors(errors: Partial<Record<keyof WaitlistForm, string>>) {
  const map: Record<keyof WaitlistForm, { err: string; input: HTMLElement | null }> = {
    address: { err: "#wl-address-err", input: fields.address },
    platform: { err: "#wl-platform-err", input: null },
    seats: { err: "#wl-seats-err", input: fields.seats },
    contact: { err: "#wl-contact-err", input: fields.contact },
    consent: { err: "#wl-consent-err", input: fields.consent },
  };
  let first: HTMLElement | null = null;
  for (const [k, m] of Object.entries(map) as [keyof WaitlistForm, (typeof map)[keyof WaitlistForm]][]) {
    const e = $(m.err); const msg = errors[k];
    if (e) { e.textContent = msg ?? ""; e.hidden = !msg; }
    if (m.input) { if (msg) m.input.setAttribute("aria-invalid", "true"); else m.input.removeAttribute("aria-invalid"); }
    if (msg && !first) first = m.input ?? form.querySelector<HTMLElement>('input[name="platform"]');
  }
  return first;
}
/** Server errors name a field by code; anything else goes in the status line. */
const FIELD_OF: Record<string, keyof WaitlistForm> = { bad_address: "address", bad_checksum: "address", bad_platform: "platform", bad_seats: "seats", bad_contact: "contact", consent_required: "consent" };

function done(state: "added" | "already", body: { address: string; platform: string; seats: number; contact?: string }) {
  form.hidden = true;
  const box = $("#wl-done")!, t = $("#wl-done-t")!, p = $("#wl-done-p")!;
  t.textContent = state === "added" ? "You are on the waitlist" : "This address is already on the waitlist";
  const what = `${esc(short(body.address, 4))} · ${plural(body.seats, "seat")} · ${esc(PLATFORM_NAME[body.platform] ?? body.platform)}`;
  p.innerHTML = state === "added"
    ? `<span class="mono">${what}</span><br>${body.contact ? `We will write to ${esc(body.contact)} when the public test network opens.` : "You left no contact, so watch this page: the test network and the downloads will be announced here."}`
    : "The first entry for an address stands, so nothing was changed. To change it, write to support@ferminux.com from the contact you gave.";
  box.hidden = false;
  box.focus();
  loadCount();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  status.textContent = "";
  const checked = checkForm(values());
  if (!checked.ok) { showErrors(checked.errors)?.focus(); return; }
  showErrors({});
  submit.disabled = true; submit.textContent = "Joining…";
  try {
    const r = await fetch(`${config.gateway}/validators/waitlist`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(checked.body), signal: AbortSignal.timeout(15000) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string; code?: string };
    if (r.ok && j.ok && (j.status === "added" || j.status === "already")) { done(j.status, checked.body); return; }
    const field = j.code ? FIELD_OF[j.code] : undefined;
    if (field) showErrors({ [field]: j.error ?? "Check this field." })?.focus();
    else status.textContent = r.status === 429 ? "Too many sign-ups from your network in the last hour. Please try again later." : j.error ? `Could not join: ${j.error}` : `Could not join (error ${r.status}). Please try again.`;
  } catch {
    status.textContent = "The gateway could not be reached. Check your connection and try again.";
  } finally {
    submit.disabled = false; submit.textContent = "Join the waitlist";
  }
});
// clear a field's error as soon as it is edited
for (const el of [fields.address, fields.seats, fields.contact, fields.consent]) el.addEventListener("input", () => { el.removeAttribute("aria-invalid"); const err = $(`#${el.id}-err`); if (err) err.hidden = true; });
$$<HTMLInputElement>('input[name="platform"]').forEach((r) => r.addEventListener("change", () => { const err = $("#wl-platform-err"); if (err) err.hidden = true; }));
// typing a contact ticks nothing on its own: consent stays the reader's choice
$("#wl-again")?.addEventListener("click", () => {
  form.reset(); form.hidden = false; $("#wl-done")!.hidden = true; fields.address.focus();
});

/* ---- a connected wallet can fill the address (never silently: the reader presses the button) ---- */
const useBtn = $<HTMLButtonElement>("#wl-use-wallet")!;
let walletAddr: string | null = null;
onWallet((s) => { walletAddr = s.address ?? null; useBtn.hidden = !walletAddr; });
useBtn.addEventListener("click", () => { if (!walletAddr) return; fields.address.value = walletAddr; fields.address.dispatchEvent(new Event("input")); fields.address.focus(); });

loadSigners();
loadCount();
