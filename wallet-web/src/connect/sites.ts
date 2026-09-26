// Connected sites: the origins the user approved in the connect window, and
// which account each one may see. Public metadata only (origins, addresses,
// times) — the same trust level as the vault's address list.
//
// The pure functions take and return arrays so the Node tests exercise the
// exact bytes; the storage wrappers below them are the only browser code.
// No ethers here on purpose: the status frame imports this module and must
// stay a few kilobytes. Addresses arrive checksummed from the vault.

export const SITES_KEY = 'ferminux.wallet.connect.sites.v1';
const SITES_VERSION = 1;
/** Same-tab change notification (the storage event only reaches other tabs). */
const SITES_EVENT = 'ferminux:connected-sites';

export interface ConnectedSite {
  /** scheme://host[:port] exactly as the browser reported it in event.origin. */
  origin: string;
  /** What the site calls itself. Display only — the origin is what was approved. */
  name: string;
  /** Addresses (as the vault stores them, checksummed) this site may see and ask to sign for. */
  accounts: string[];
  connectedAt: number;
  lastUsedAt: number;
}

/** Only http(s) origins, in canonical form; anything else is not a site we can answer. */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw === 'null') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

/** An origin a person can trust at a glance: https, or a local development host. */
export function isSecureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

function validAddress(a: unknown): string | null {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a : null;
}

export function parseSites(raw: string | null): ConnectedSite[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const obj = data as { version?: unknown; sites?: unknown };
  if (!obj || obj.version !== SITES_VERSION || !Array.isArray(obj.sites)) return [];
  const out: ConnectedSite[] = [];
  for (const item of obj.sites) {
    const s = item as Record<string, unknown>;
    const origin = normalizeOrigin(s?.origin);
    if (!origin || out.some((x) => x.origin === origin)) continue;
    const accounts = Array.isArray(s.accounts) ? s.accounts.map(validAddress).filter((a): a is string => a !== null) : [];
    if (accounts.length === 0) continue;
    out.push({
      origin,
      name: typeof s.name === 'string' ? s.name.slice(0, 60) : '',
      accounts: [...new Set(accounts)],
      connectedAt: typeof s.connectedAt === 'number' ? s.connectedAt : 0,
      lastUsedAt: typeof s.lastUsedAt === 'number' ? s.lastUsedAt : 0,
    });
  }
  return out;
}

export function serializeSites(sites: ConnectedSite[]): string {
  return JSON.stringify({ version: SITES_VERSION, sites });
}

export function findSite(sites: ConnectedSite[], origin: string): ConnectedSite | undefined {
  return sites.find((s) => s.origin === origin);
}

/** Approve (or re-approve) `origin` for `accounts`. Newest first. */
export function withSite(sites: ConnectedSite[], origin: string, name: string, accounts: string[], now: number): ConnectedSite[] {
  const prev = findSite(sites, origin);
  const next: ConnectedSite = {
    origin,
    name: name.slice(0, 60),
    accounts: [...new Set(accounts.map(validAddress).filter((a): a is string => a !== null))],
    connectedAt: prev?.connectedAt ?? now,
    lastUsedAt: now,
  };
  return [next, ...sites.filter((s) => s.origin !== origin)];
}

export function withoutSite(sites: ConnectedSite[], origin: string): ConnectedSite[] {
  return sites.filter((s) => s.origin !== origin);
}

export function touched(sites: ConnectedSite[], origin: string, now: number): ConnectedSite[] {
  return sites.map((s) => (s.origin === origin ? { ...s, lastUsedAt: now } : s));
}

/** The accounts `origin` may use that this device can still sign for. */
export function approvedAccounts(site: ConnectedSite | undefined, available: string[]): string[] {
  if (!site) return [];
  const have = new Set(available.map((a) => a.toLowerCase()));
  return site.accounts.filter((a) => have.has(a.toLowerCase()));
}

/**
 * Whether a frame of this page embedded by `parentOrigin` shares the wallet's
 * storage. Browsers partition storage by top-level *site* (scheme + registrable
 * domain): a *.ferminux.net dApp sees the real list, anyone else an empty one —
 * and an empty list must not be reported as "revoked".
 */
export function registrableDomain(hostname: string): string {
  if (hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) return hostname;
  return hostname.split('.').slice(-2).join('.');
}

export function isSameSite(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && registrableDomain(ua.hostname) === registrableDomain(ub.hostname);
  } catch {
    return false;
  }
}

/** "5 min ago" for the sites list. */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Storage (browser only)                                              */
/* ------------------------------------------------------------------ */

export function loadSites(): ConnectedSite[] {
  try {
    return parseSites(window.localStorage.getItem(SITES_KEY));
  } catch {
    return [];
  }
}

export function saveSites(sites: ConnectedSite[]): void {
  try {
    if (sites.length === 0) window.localStorage.removeItem(SITES_KEY);
    else window.localStorage.setItem(SITES_KEY, serializeSites(sites));
  } catch {
    /* storage blocked: the approval lasts for this window only */
  }
  try {
    window.dispatchEvent(new Event(SITES_EVENT));
  } catch {
    /* no window */
  }
}

export function revokeSite(origin: string): void {
  saveSites(withoutSite(loadSites(), origin));
}

/** Call `listener` whenever the list changes, in this tab or another. */
export function onSitesChange(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SITES_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SITES_EVENT, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SITES_EVENT, listener);
  };
}
