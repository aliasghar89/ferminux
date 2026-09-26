// The validator waitlist form's checks, mirrored from the gateway (agents/gateway/src/validators.ts) so a
// mistake is caught before a request is spent: the gateway allows 5 new sign-ups per IP per hour.
// A sign-up is signed (EIP-191 personal_sign) by the key of the address it lists: the page asks the gateway
// for the challenge text, rebuilds that text here from the fields it is sending, and signs only when the two
// are identical, so the wallet is never asked to sign anything but this sign-up.
// Only ethers' getAddress is imported, so test/validatorForm.test.mjs runs it under plain Node.
import { getAddress } from "ethers";

export const PLATFORMS = ["windows", "linux", "both"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const MAX_SEATS = 10;

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

/** 0x + 40 hex in any case. Mixed case must carry a valid checksum (it catches a mistyped character). */
export function checkAddress(raw: string): Check<string> {
  const s = raw.trim();
  if (!s) return { ok: false, error: "Enter the FMX address that will own the seat." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: "An address is 0x followed by 40 characters (0-9, a-f)." };
  const hex = s.slice(2);
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  let out: string;
  try { out = getAddress(mixed ? s : s.toLowerCase()); } catch { return { ok: false, error: "The capital letters do not match this address's checksum. Check for a mistyped character, or paste it in lowercase." }; }
  if (/^0x0{40}$/i.test(out)) return { ok: false, error: "The zero address cannot hold a seat." };
  return { ok: true, value: out };
}

export function checkSeats(raw: string | number): Check<number> {
  const n = typeof raw === "number" ? raw : /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) return { ok: false, error: `Choose 1 to ${MAX_SEATS} seats.` };
  return { ok: true, value: n };
}

/** An e-mail address or a Telegram handle (@name, name, t.me/name); empty is fine (null). */
export function checkContact(raw: string): Check<string | null> {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (s.length > 254) return { ok: false, error: "That is too long for an e-mail address or a Telegram handle." };
  // the gateway lowercases the domain (parseContact), and the signed text carries its form
  if (/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(s)) { const at = s.lastIndexOf("@"); return { ok: true, value: `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}` }; }
  const tg = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(s) ?? /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(s);
  if (tg) return { ok: true, value: `@${tg[1]}` };
  return { ok: false, error: "Enter an e-mail address, or a Telegram handle such as @name (5 to 32 letters, digits or _)." };
}

export interface WaitlistForm { address: string; platform: string; seats: string | number; contact: string; consent: boolean }
export interface WaitlistBody { address: string; platform: Platform; seats: number; contact?: string; consent: boolean }

/** Every field's error at once (keyed by field), or the body to POST. */
export function checkForm(f: WaitlistForm): { ok: true; body: WaitlistBody } | { ok: false; errors: Partial<Record<keyof WaitlistForm, string>> } {
  const errors: Partial<Record<keyof WaitlistForm, string>> = {};
  const a = checkAddress(f.address);
  if (!a.ok) errors.address = a.error;
  const platform = (PLATFORMS as readonly string[]).includes(f.platform) ? (f.platform as Platform) : null;
  if (!platform) errors.platform = "Choose Windows, Linux or both.";
  const seats = checkSeats(f.seats);
  if (!seats.ok) errors.seats = seats.error;
  const c = checkContact(f.contact);
  if (!c.ok) errors.contact = c.error;
  else if (c.value && !f.consent) errors.consent = "Tick this box to leave a contact, or clear the contact field.";
  if (Object.keys(errors).length || !a.ok || !seats.ok || !c.ok || !platform) return { ok: false, errors };
  return { ok: true, body: { address: a.value, platform, seats: seats.value, ...(c.value ? { contact: c.value } : {}), consent: !!(c.value && f.consent) } };
}

/* ---- signing (the gateway's waitlistMessage, line for line) ---- */
export const WAITLIST_SIGN_TITLE = "Ferminux validator waitlist";

/** The exact text the listed address's key signs: every field, a nonce and an expiry (unix seconds). */
export function waitlistMessage(b: WaitlistBody, nonce: string, expires: number): string {
  return [
    WAITLIST_SIGN_TITLE,
    "Sign to put this address on the waitlist for validator seats. Signing is free and sends no transaction.",
    "site: ferminux.net",
    `address: ${b.address}`,
    `platform: ${b.platform}`,
    `seats: ${b.seats}`,
    `contact: ${b.contact ?? "none"}`,
    `consent: ${b.consent ? "yes" : "no"}`,
    `nonce: ${nonce}`,
    `expires: ${expires}`,
  ].join("\n");
}

/** GET /api/validators/waitlist/challenge?… for this body. */
export function challengeQuery(b: WaitlistBody): string {
  const q = new URLSearchParams({ address: b.address, platform: b.platform, seats: String(b.seats), consent: String(b.consent) });
  if (b.contact) q.set("contact", b.contact);
  return q.toString();
}

export interface Challenge { message: string; nonce: string; expires: number }

/**
 * The text to sign, or why not: the gateway's challenge must be exactly the sign-up this page is sending (the
 * same fields, a hex nonce, an expiry in the next 15 minutes). Anything else is refused before the wallet sees it.
 */
export function checkChallenge(b: WaitlistBody, c: unknown, nowS: number): { ok: true; message: string; nonce: string; expires: number } | { ok: false; error: string } {
  const ch = c as Partial<Challenge> | null;
  const nonce = typeof ch?.nonce === "string" && /^[0-9a-fA-F]{16,64}$/.test(ch.nonce) ? ch.nonce : null;
  const expires = typeof ch?.expires === "number" && Number.isSafeInteger(ch.expires) ? ch.expires : null;
  if (!nonce || expires === null || typeof ch?.message !== "string") return { ok: false, error: "The gateway sent an unreadable challenge. Nothing was signed; please try again." };
  if (expires <= nowS || expires > nowS + 900) return { ok: false, error: "The gateway's challenge has the wrong expiry (check this device's clock). Nothing was signed." };
  const message = waitlistMessage(b, nonce, expires);
  if (message !== ch.message) return { ok: false, error: "The gateway asked to sign a different text from the sign-up this page is sending. Nothing was signed." };
  return { ok: true, message, nonce, expires };
}
