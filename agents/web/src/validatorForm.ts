// The validator waitlist form's checks, mirrored from the gateway (agents/gateway/src/validators.ts) so a
// mistake is caught before a request is spent: the gateway allows 5 new sign-ups per IP per hour.
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
  if (/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(s)) return { ok: true, value: s };
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
