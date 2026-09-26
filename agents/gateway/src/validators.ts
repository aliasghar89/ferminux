// Validator waitlist, behind ferminux.net/validators/. The validator programme (a 2,000 FMX deposit per seat; a
// node that checks every block and signs a checkpoint about every 23 minutes) is in development and has no
// deposit contract yet, so the gateway only records who wants a seat and, with their consent, how to reach them.
//
//   GET  /api/validators/waitlist/challenge  ?address=&platform=&seats=&contact=&consent=
//        200 {message, nonce, expires}: the exact EIP-191 text the address's key signs (valid 10 minutes)
//   POST /api/validators/waitlist          {address, platform, seats, contact?, consent?, nonce, expires, sig}
//        201 {ok, status:"added", total} · 200 {ok, status:"already", total} (the first signed entry stands)
//        200 {ok, status:"verified", total}: a signed entry replaced an unsigned one from before signatures
//   GET  /api/validators/waitlist/count    public totals only: {total, seats, byPlatform, verified}
//   GET  /api/validators/waitlist/export   operators only: a signed GET (action validators.export) from an address
//        in VALIDATOR_OPERATOR_ADDRESSES. No fallback to any other operator list: the export carries contacts, so
//        it stays off (503) until someone names the addresses allowed to read them.
//
// Ownership: a sign-up carries a personal_sign (EIP-191) signature by the key of the address being listed, over
// a message that names every field, a nonce and an expiry (waitlistMessage). Nobody can list someone else's
// address, and a signature works once (the Commons replay guard). Rows from before signatures were required stay
// as they are, marked verified: false in the export; their address's own key can replace them with a signed entry.
// VALIDATOR_WAITLIST_SIGNATURES=optional accepts unsigned sign-ups again (stored unverified) for a rollout window.
//
// Privacy: a contact is stored only with consent, and only the operator export returns it. No public route
// echoes it back, not even for the address that submitted it: an address is public, so anyone could type it.
// A resubmission never overwrites a signed entry.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import type { Db } from "./db.js";
import { COMMONS_DOMAIN, COMMONS_TS_WINDOW_S, sha256Hex } from "./commons/sign.js";
import { HttpError, type CommonsContext } from "./commons/context.js";

export const VALIDATOR_PLATFORMS = ["windows", "linux", "both"] as const;
export type ValidatorPlatform = (typeof VALIDATOR_PLATFORMS)[number];
export const WAITLIST_MAX_SEATS = 10;
/** New sign-ups accepted per IP per hour (a resubmission of a listed address costs nothing). */
export const WAITLIST_PER_IP_PER_HOUR = 5;
/** Every POST to the route, valid or not, per IP per hour: bounds probing and typo storms. */
export const WAITLIST_POSTS_PER_IP_PER_HOUR = 30;
export const WAITLIST_MAX_ROWS = 100_000;
export const WAITLIST_CONTACT_MAX = 254;
/** The signed-GET action the operator export verifies (same canonical message as the Commons, own action). */
export const VALIDATOR_EXPORT_ACTION = "validators.export";
/** A sign-up signature is good for at most this long after it is made (the challenge sets exactly this). */
export const WAITLIST_SIG_TTL_S = 600;
export const WAITLIST_SIGN_TITLE = "Ferminux validator waitlist";

export function migrateValidators(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS validator_waitlist (
      address TEXT PRIMARY KEY,
      addressChecksum TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('windows','linux','both')),
      seats INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 10),
      contact TEXT,
      contactKind TEXT CHECK (contactKind IN ('email','telegram')),
      consent INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validator_waitlist_created ON validator_waitlist(createdAt);
  `);
  // Signatures (2026-09-26): rows from before keep sig NULL, which the export reports as verified: false.
  const cols = new Set((db.prepare("PRAGMA table_info(validator_waitlist)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("sig")) db.exec("ALTER TABLE validator_waitlist ADD COLUMN sig TEXT");
  if (!cols.has("signedAt")) db.exec("ALTER TABLE validator_waitlist ADD COLUMN signedAt INTEGER");
}

/** A 0x address in any case. Mixed case must carry a valid checksum (it catches a mistyped character); all-lower
 *  or all-upper is taken as typed. Returns the checksummed form. */
export function parseWaitlistAddress(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "address is required: your 0x… FMX address", "bad_address");
  const s = v.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new HttpError(400, "address must be 0x followed by 40 hex characters", "bad_address");
  const hex = s.slice(2);
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  let out: string;
  try {
    out = getAddress(mixed ? s : s.toLowerCase());
  } catch {
    throw new HttpError(400, "address checksum does not match: check it for a mistyped character, or send it in lowercase", "bad_checksum");
  }
  if (/^0x0{40}$/i.test(out)) throw new HttpError(400, "the zero address cannot hold a seat", "bad_address");
  return out;
}

export function parsePlatform(v: unknown): ValidatorPlatform {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!(VALIDATOR_PLATFORMS as readonly string[]).includes(s)) throw new HttpError(400, `platform must be one of: ${VALIDATOR_PLATFORMS.join(", ")}`, "bad_platform");
  return s as ValidatorPlatform;
}

export function parseSeats(v: unknown): number {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > WAITLIST_MAX_SEATS) {
    throw new HttpError(400, `seats must be a whole number from 1 to ${WAITLIST_MAX_SEATS}`, "bad_seats");
  }
  return n;
}

/** An e-mail address or a Telegram handle ("@name", "name", "t.me/name"); null when empty. */
export function parseContact(v: unknown): { contact: string; kind: "email" | "telegram" } | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "contact must be a string", "bad_contact");
  const s = v.trim();
  if (!s) return null;
  if (s.length > WAITLIST_CONTACT_MAX) throw new HttpError(400, `contact is too long: max ${WAITLIST_CONTACT_MAX} characters`, "bad_contact");
  if (/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(s)) {
    const at = s.lastIndexOf("@");
    return { contact: `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`, kind: "email" };
  }
  const tg = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(s) ?? /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(s);
  if (tg) return { contact: `@${tg[1]}`, kind: "telegram" };
  throw new HttpError(400, "contact must be an e-mail address or a Telegram handle such as @name", "bad_contact");
}

const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1" || v === "on";

export interface WaitlistEntry {
  address: string;
  platform: ValidatorPlatform;
  seats: number;
  contact: string | null;
  contactKind: "email" | "telegram" | null;
  consent: boolean;
}

/** Validates a sign-up body. A contact needs the consent box; without a contact the box may stay empty. */
export function parseWaitlistBody(body: Record<string, unknown>): WaitlistEntry {
  const address = parseWaitlistAddress(body.address);
  const platform = parsePlatform(body.platform);
  const seats = parseSeats(body.seats);
  const c = parseContact(body.contact);
  const consent = truthy(body.consent);
  if (c && !consent) throw new HttpError(400, "tick the consent box to leave a contact, or leave the contact empty", "consent_required");
  return { address, platform, seats, contact: c?.contact ?? null, contactKind: c?.kind ?? null, consent };
}

export interface WaitlistSignature {
  nonce: string;
  expires: number;
  sig: string;
}

/**
 * The exact text the key of `address` signs with personal_sign (EIP-191). Every field is in it, so a signature
 * cannot be reused for other seats or another contact; the nonce and expiry make it single-use and short-lived.
 * Values are the normalised ones (checksummed address, lowercase platform, contact as parseContact returns it),
 * which is what GET /api/validators/waitlist/challenge prints.
 */
export function waitlistMessage(e: WaitlistEntry, nonce: string, expires: number): string {
  return [
    WAITLIST_SIGN_TITLE,
    "Sign to put this address on the waitlist for validator seats. Signing is free and sends no transaction.",
    "site: ferminux.net",
    `address: ${e.address}`,
    `platform: ${e.platform}`,
    `seats: ${e.seats}`,
    `contact: ${e.contact ?? "none"}`,
    `consent: ${e.consent ? "yes" : "no"}`,
    `nonce: ${nonce}`,
    `expires: ${expires}`,
  ].join("\n");
}

/** The signature fields of a sign-up, or null when none were sent. Shape errors are 400s; nothing is verified here. */
export function parseWaitlistSignature(body: Record<string, unknown>): WaitlistSignature | null {
  const { nonce, expires, sig } = body;
  if (nonce === undefined && expires === undefined && sig === undefined) return null;
  if (typeof nonce !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) throw new HttpError(400, "nonce must be 16 to 64 hex characters (take it from GET /api/validators/waitlist/challenge)", "bad_nonce");
  const exp = typeof expires === "string" && /^\d+$/.test(expires) ? Number(expires) : expires;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) throw new HttpError(400, "expires must be unix seconds", "bad_expires");
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "sig must be a 65-byte 0x hex EIP-191 signature", "bad_sig");
  return { nonce: nonce.toLowerCase(), expires: exp, sig };
}

/** Checks that the key of `entry.address` signed waitlistMessage(entry, nonce, expires) and that it has not expired. */
export function verifyWaitlistSignature(entry: WaitlistEntry, s: WaitlistSignature, nowS: number): void {
  if (s.expires <= nowS) throw new HttpError(401, "the signature has expired: ask for a new challenge and sign again", "sig_expired");
  if (s.expires > nowS + WAITLIST_SIG_TTL_S + 60) throw new HttpError(401, `expires must be at most ${WAITLIST_SIG_TTL_S} s ahead`, "bad_expires");
  let rec: string;
  try {
    rec = verifyMessage(waitlistMessage(entry, s.nonce, s.expires), s.sig);
  } catch {
    throw new HttpError(401, "the signature could not be recovered", "bad_sig");
  }
  if (rec !== entry.address) {
    throw new HttpError(401, `the signature is not from ${entry.address}: sign the challenge text, unchanged, with the key of the address you are listing`, "sig_mismatch");
  }
}

/** VALIDATOR_WAITLIST_SIGNATURES: "required" (default) or "optional" (unsigned sign-ups stored unverified). */
export function waitlistSignaturesRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VALIDATOR_WAITLIST_SIGNATURES ?? "").trim().toLowerCase() !== "optional";
}

function addressList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}
/** Who may export the list (contacts included): VALIDATOR_OPERATOR_ADDRESSES only. Empty = export disabled.
 *  Deliberately not KB_OPERATOR_ADDRESSES: a key trusted to edit network pages is not thereby trusted with PII. */
export function validatorOperatorsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return addressList(env.VALIDATOR_OPERATOR_ADDRESSES);
}

/** The Commons canonical message with a raw body line (sha256 of the literal string). */
function exportMessage(address: string, ts: number, raw: string): string {
  return [COMMONS_DOMAIN, `action: ${VALIDATOR_EXPORT_ACTION}`, `address: ${address}`, `ts: ${ts}`, `body: ${sha256Hex(raw)}`].join("\n");
}

/** A signed GET: X-Ferminux-Address / -Ts / -Sig headers (or ?address=&ts=&sig=), body line sha256("") or sha256("{}"). */
export function verifyExportRequest(req: Pick<FastifyRequest, "headers" | "query">, nowS: number): { address: string; sig: string } {
  const h = req.headers;
  const q = (req.query ?? {}) as Record<string, unknown>;
  const pick = (header: string, key: string) => {
    const v = h[header];
    if (typeof v === "string" && v) return v;
    return typeof q[key] === "string" ? (q[key] as string) : undefined;
  };
  const rawAddr = pick("x-ferminux-address", "address"), rawTs = pick("x-ferminux-ts", "ts"), sig = pick("x-ferminux-sig", "sig");
  if (!rawAddr || !rawTs || !sig) throw new HttpError(401, "unauthorized: sign the request (X-Ferminux-Address / X-Ferminux-Ts / X-Ferminux-Sig, action validators.export)", "bad_sig");
  let address: string;
  try {
    address = getAddress(rawAddr);
  } catch {
    throw new HttpError(401, "unauthorized: address must be a valid 0x address", "bad_address");
  }
  const ts = Number(rawTs);
  if (!Number.isInteger(ts)) throw new HttpError(401, "unauthorized: ts must be unix seconds", "bad_ts");
  if (Math.abs(nowS - ts) > COMMONS_TS_WINDOW_S) throw new HttpError(401, `unauthorized: ts is outside the ±${COMMONS_TS_WINDOW_S}s window (server now=${nowS})`, "stale_ts");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(401, "unauthorized: sig must be a 65-byte 0x hex EIP-191 signature", "bad_sig");
  for (const raw of ["", "{}"]) {
    let rec: string;
    try {
      rec = verifyMessage(exportMessage(address, ts, raw), sig);
    } catch {
      throw new HttpError(401, "unauthorized: signature could not be recovered", "bad_sig");
    }
    if (rec === address) return { address, sig };
  }
  throw new HttpError(401, "unauthorized: signature does not match address (action validators.export, body line sha256 of \"\")", "sig_mismatch");
}

interface Row {
  address: string;
  addressChecksum: string;
  platform: ValidatorPlatform;
  seats: number;
  contact: string | null;
  contactKind: "email" | "telegram" | null;
  consent: number;
  createdAt: number;
  sig: string | null;
  signedAt: number | null;
}

export interface WaitlistCounts {
  total: number;
  seats: number;
  byPlatform: Record<ValidatorPlatform, number>;
  /** entries signed by the key of their address (rows from before signatures were required are not) */
  verified: number;
}

export function waitlistCounts(db: Db): WaitlistCounts {
  const rows = db.prepare("SELECT platform, COUNT(*) AS n, COALESCE(SUM(seats), 0) AS s FROM validator_waitlist GROUP BY platform").all() as Array<{ platform: ValidatorPlatform; n: number; s: number }>;
  const byPlatform: Record<ValidatorPlatform, number> = { windows: 0, linux: 0, both: 0 };
  let total = 0, seats = 0;
  for (const r of rows) {
    if (r.platform in byPlatform) byPlatform[r.platform] = r.n;
    total += r.n;
    seats += r.s;
  }
  const verified = (db.prepare("SELECT COUNT(*) AS c FROM validator_waitlist WHERE sig IS NOT NULL").get() as { c: number }).c;
  return { total, seats, byPlatform, verified };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // a leading = + - @ would run as a formula in a spreadsheet; quote everything and neutralise those
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export interface ValidatorRoutesOptions {
  db: Db;
  commons: CommonsContext;
  /** operator addresses (lowercase or any case); default from the environment */
  operators?: string[];
  /** new sign-ups per IP per hour (default WAITLIST_PER_IP_PER_HOUR, env VALIDATOR_WAITLIST_PER_IP_PER_HOUR) */
  perIpPerHour?: number;
  /** refuse unsigned sign-ups (default true; env VALIDATOR_WAITLIST_SIGNATURES=optional turns it off) */
  requireSignature?: boolean;
}

export function registerValidatorRoutes(app: FastifyInstance, opts: ValidatorRoutesOptions): void {
  const { db, commons } = opts;
  const operators = new Set((opts.operators ?? validatorOperatorsFromEnv()).map((a) => a.toLowerCase()));
  const envCap = Number(process.env.VALIDATOR_WAITLIST_PER_IP_PER_HOUR);
  const perIp = opts.perIpPerHour ?? (envCap > 0 ? envCap : WAITLIST_PER_IP_PER_HOUR);
  const requireSig = opts.requireSignature ?? waitlistSignaturesRequired();
  const insert = db.prepare("INSERT OR IGNORE INTO validator_waitlist (address, addressChecksum, platform, seats, contact, contactKind, consent, createdAt, sig, signedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // only an unsigned row is ever replaced, and only by a signed entry from its own address
  const claim = db.prepare("UPDATE validator_waitlist SET platform = ?, seats = ?, contact = ?, contactKind = ?, consent = ?, sig = ?, signedAt = ? WHERE address = ? AND sig IS NULL");
  const existing = db.prepare("SELECT sig FROM validator_waitlist WHERE address = ?");
  const rowCount = db.prepare("SELECT COUNT(*) AS c FROM validator_waitlist");
  /** accepted sign-ups per IP, unix-ms timestamps inside the last hour */
  const accepted = new Map<string, number[]>();
  const HOUR = 3_600_000;

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/validators/waitlist/challenge", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const entry = parseWaitlistBody(req.query as Record<string, unknown>);
      const nonce = randomBytes(16).toString("hex");
      const expires = commons.nowS() + WAITLIST_SIG_TTL_S;
      reply.header("cache-control", "no-store");
      return {
        message: waitlistMessage(entry, nonce, expires),
        nonce,
        expires,
        address: entry.address,
        sign: "personal_sign (EIP-191) this message, unchanged, with the key of `address`; then POST /api/validators/waitlist with the same fields plus nonce, expires and sig",
      };
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.post("/api/validators/waitlist", { config: { rateLimit: { max: WAITLIST_POSTS_PER_IP_PER_HOUR, timeWindow: "1 hour" } } }, async (req, reply) => {
    try {
      const body = commons.parseJson(req);
      const entry = parseWaitlistBody(body);
      const signed = parseWaitlistSignature(body);
      if (!signed && requireSig) {
        throw new HttpError(401, "sign the sign-up with the key of this address: GET /api/validators/waitlist/challenge with the same fields returns the text to sign, then POST it back with nonce, expires and sig", "signature_required");
      }
      if (signed) verifyWaitlistSignature(entry, signed, commons.nowS());
      const ip = String(req.ip || "?");
      const t = commons.now();
      const recent = (accepted.get(ip) ?? []).filter((x) => t - x < HOUR);
      const known = existing.get(entry.address.toLowerCase()) as { sig: string | null } | undefined;
      if (known) {
        // the address's own key replaces an unsigned row from before signatures were required; nothing else does
        if (signed && known.sig === null) {
          commons.commitWrite(entry.address, { sig: signed.sig }); // single-use: the Commons replay guard
          const r = claim.run(entry.platform, entry.seats, entry.contact, entry.contactKind, entry.consent ? 1 : 0, signed.sig, commons.nowS(), entry.address.toLowerCase());
          if (r.changes === 1) return reply.code(200).send({ ok: true, status: "verified", total: waitlistCounts(db).total });
        }
        return reply.code(200).send({ ok: true, status: "already", total: waitlistCounts(db).total });
      }
      // limits first, so a refused sign-up does not use up its signature
      if (recent.length >= perIp) {
        reply.header("retry-after", String(Math.max(1, Math.ceil((recent[0] + HOUR - t) / 1000))));
        throw new HttpError(429, `too many sign-ups from your network: at most ${perIp} per hour`, "ip_rate_limited");
      }
      if ((rowCount.get() as { c: number }).c >= WAITLIST_MAX_ROWS) throw new HttpError(507, "the waitlist is full for now; try again later", "waitlist_full");
      if (signed) commons.commitWrite(entry.address, { sig: signed.sig }); // single-use: the Commons replay guard
      const r = insert.run(entry.address.toLowerCase(), entry.address, entry.platform, entry.seats, entry.contact, entry.contactKind, entry.consent ? 1 : 0, commons.nowS(), signed?.sig ?? null, signed ? commons.nowS() : null);
      if (r.changes === 0) return reply.code(200).send({ ok: true, status: "already", total: waitlistCounts(db).total });
      recent.push(t);
      accepted.set(ip, recent);
      if (accepted.size > 20_000) for (const [k, v] of accepted) if (!v.some((x) => t - x < HOUR)) accepted.delete(k);
      return reply.code(201).send({ ok: true, status: "added", total: waitlistCounts(db).total });
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get("/api/validators/waitlist/count", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=30");
    return { ...waitlistCounts(db), programme: "in development", page: "https://ferminux.net/validators/" };
  });

  app.get<{ Querystring: { format?: string } }>("/api/validators/waitlist/export", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      if (!operators.size) throw new HttpError(503, "export disabled: no operator addresses configured (VALIDATOR_OPERATOR_ADDRESSES)", "disabled");
      // checked before the signature is spent: a typo in ?format must not cost the operator a fresh signature
      const format = req.query.format ?? "json";
      if (format !== "json" && format !== "csv") throw new HttpError(400, "format must be json (default) or csv", "bad_format");
      const { address, sig } = verifyExportRequest(req, commons.nowS());
      if (!operators.has(address.toLowerCase())) throw new HttpError(403, `${address} is not a validator-programme operator`, "not_operator");
      commons.commitWrite(address, { sig }); // replay guard: an export signature is single-use
      const rows = db.prepare("SELECT * FROM validator_waitlist ORDER BY createdAt ASC, address ASC").all() as Row[];
      const items = rows.map((r) => ({ address: r.addressChecksum, platform: r.platform, seats: r.seats, contact: r.contact, contactKind: r.contactKind, consent: r.consent === 1, createdAt: r.createdAt, verified: r.sig !== null, signedAt: r.signedAt ?? null }));
      reply.header("cache-control", "no-store");
      if (format === "csv") {
        // new columns go last, so a spreadsheet built on the old seven keeps working
        const head = ["address", "platform", "seats", "contact", "contactKind", "consent", "createdAt", "verified", "signedAt"];
        const lines = [head.join(","), ...items.map((i) => head.map((k) => csvCell((i as Record<string, unknown>)[k])).join(","))];
        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header("content-disposition", 'attachment; filename="validator-waitlist.csv"');
        return `${lines.join("\n")}\n`;
      }
      return { ...waitlistCounts(db), exportedBy: address, exportedAt: commons.nowS(), items };
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });
}
