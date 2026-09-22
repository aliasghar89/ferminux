// Outbound-request guard: every URL the gateway fetches on behalf of a user
// (webhooks, agent endpoints, tool probes, DM forwarding, the /a/<slug>/invoke
// proxy) is attacker-controlled. `assertPublicUrl` rejects anything that
// resolves to loopback / private / link-local / metadata / multicast space,
// and `safeFetch` re-checks after each redirect (redirects are followed
// manually, at most 3, never to a private target) and caps the response body.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./commons/context.js";

export const SAFE_FETCH_MAX_REDIRECTS = 3;
/** ALLOW_PRIVATE_FETCH=1 (dev/test only) lets the gateway reach localhost / in-cluster endpoints. Read per call so tests can flip it. */
export const allowPrivate = (): boolean => process.env.ALLOW_PRIVATE_FETCH === "1";

function v4Private(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // "this" net, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** true for loopback, private, link-local, metadata, multicast, unspecified and IPv4-mapped equivalents. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
    return v4Private(a, b, c);
  }
  if (kind === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::" || s === "::1") return true;
    const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) ?? /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(s);
    if (mapped) {
      if (mapped[2]) {
        const hi = parseInt(mapped[1]!, 16);
        const lo = parseInt(mapped[2], 16);
        return v4Private(hi >> 8, hi & 0xff, lo >> 8);
      }
      return isPrivateIp(mapped[1]!);
    }
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true; // link-local fe80::/10
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique local fc00::/7
    if (s.startsWith("ff")) return true; // multicast
    if (s.startsWith("2001:db8")) return true; // documentation
    if (s.startsWith("64:ff9b")) return true; // NAT64 well-known prefix (maps IPv4 — treat as untrusted)
    return false;
  }
  return true; // not an IP literal
}

/** Sync checks only (scheme, literal hosts, .local/.internal names) — for request validation before storing a URL. */
export function checkPublicUrlSync(raw: string, name = "url"): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, `${name} must be an absolute URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, `${name} must be an http(s) URL`);
  if (u.username || u.password) throw new HttpError(400, `${name} must not carry credentials`);
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa") || host === "metadata.google.internal") {
    throw new HttpError(400, `${name} must point at a public host`, "private_url");
  }
  if (/^\d+$/.test(host) || /^0x/i.test(host)) throw new HttpError(400, `${name} must use a hostname or dotted IPv4 literal`, "private_url");
  if (isIP(host) && isPrivateIp(host)) throw new HttpError(400, `${name} must point at a public address`, "private_url");
  return u;
}

/** Resolves the hostname and rejects when any answer is private (resolve-and-check; the connection then reuses the resolver cache). */
export async function assertPublicUrl(raw: string, name = "url"): Promise<URL> {
  const u = checkPublicUrlSync(raw, name);
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return u;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, `${name}: host ${host} does not resolve`, "unresolvable_url");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, `${name} resolves to a private address`, "private_url");
  return u;
}

export interface SafeFetchOptions extends RequestInit {
  /** abort after this many ms (default 10 s) */
  timeoutMs?: number;
  /** max response bytes read by `readCapped` (callers that stream must cap themselves) */
  maxBytes?: number;
  /** skip the public-host check (in-cluster upstreams the operator configured) */
  trusted?: boolean;
  fetchImpl?: typeof fetch;
}

/** Reads a body with a byte cap; throws once the cap is exceeded (the rest is cancelled). */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * fetch() that only talks to public hosts, follows at most 3 redirects (each
 * re-checked; 307/308 keep the method+body, 301/302/303 become GET without a
 * body) and never forwards the request headers across an origin change.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, trusted = false, fetchImpl = fetch, maxBytes: _m, ...init } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onOuterAbort);
  try {
    let current = url;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let headers = init.headers;
    for (let hop = 0; ; hop++) {
      if (!trusted) await assertPublicUrl(current);
      const res = await fetchImpl(current, { ...init, method, body, headers, redirect: "manual", signal: controller.signal });
      const loc = res.headers.get("location");
      if (!(res.status >= 300 && res.status < 400 && loc)) return res;
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      if (hop >= SAFE_FETCH_MAX_REDIRECTS) throw new Error(`too many redirects (${SAFE_FETCH_MAX_REDIRECTS})`);
      const next = new URL(loc, current);
      if (next.origin !== new URL(current).origin) headers = undefined; // never leak headers/secrets to another origin
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        method = "GET";
        body = undefined;
      }
      current = next.toString();
    }
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onOuterAbort);
  }
}
