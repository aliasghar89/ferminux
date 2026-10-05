// Outbound-request guard: every URL the gateway fetches on behalf of a user
// (webhooks, agent endpoints, tool probes, DM forwarding, the /a/<slug>/invoke
// proxy) is attacker-controlled. `assertPublicUrl` rejects anything that
// resolves to loopback / private / link-local / metadata / multicast space,
// and `safeFetch` re-checks after each redirect (redirects are followed
// manually, at most 3, never to a private target) and caps the response body.
// The connection goes to the very addresses that were checked (see pinnedFetch).
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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

/** A checked answer for a URL's host: the connection must go to one of these and nowhere else. */
export interface PinnedAddress {
  address: string;
  family: number;
}

/**
 * Resolves the hostname once and rejects when any answer is private. Checking is only half of it: a plain fetch()
 * resolves the name again to connect, and an attacker's DNS can answer public for the check and 169.254.169.254
 * for the connection (DNS rebinding). Hence the answers are returned, for pinnedFetch to connect to.
 */
export async function resolvePublicUrl(raw: string, name = "url"): Promise<{ url: URL; addresses: PinnedAddress[] }> {
  const u = checkPublicUrlSync(raw, name);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { url: u, addresses: [{ address: host, family: isIP(host) }] };
  let addrs: PinnedAddress[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, `${name}: host ${host} does not resolve`, "unresolvable_url");
  }
  if (!addrs.length) throw new HttpError(502, `${name}: host ${host} does not resolve`, "unresolvable_url");
  if (!allowPrivate() && addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, `${name} resolves to a private address`, "private_url");
  return { url: u, addresses: addrs.map((a) => ({ address: a.address, family: a.family })) };
}

/** Resolves the hostname and rejects when any answer is private. Validation only: a connection must use resolvePublicUrl's answers. */
export async function assertPublicUrl(raw: string, name = "url"): Promise<URL> {
  if (allowPrivate()) return checkPublicUrlSync(raw, name);
  return (await resolvePublicUrl(raw, name)).url;
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** node:http response → fetch Response (body streamed, gzip/deflate/br decoded the way fetch() would). */
function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.destroy();
    throw new Error(`unexpected HTTP status ${status}`);
  }
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    } catch {
      // a header a Headers object cannot hold: dropped, as fetch() would refuse it
    }
  }
  if (method === "HEAD" || NULL_BODY_STATUS.has(status)) {
    res.resume();
    return new Response(null, { status, headers });
  }
  const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder = enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "deflate" ? createInflate() : enc === "br" ? createBrotliDecompress() : null;
  const stream: Readable = decoder ? pipeline(res, decoder, () => undefined) : res;
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
}

function requestBody(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("safeFetch: request body must be a string or bytes");
}

/**
 * One HTTP(S) exchange that connects only to `pinned`, the addresses resolvePublicUrl checked. The hostname stays
 * in the URL, so the Host header, TLS SNI and certificate verification all still use the name; only the lookup
 * that picks the socket address is answered from `pinned`. A fresh connection every time (no pooled socket from
 * an earlier resolution). Redirects come back as responses; safeFetch decides whether to follow them.
 */
function pinnedFetch(url: URL, pinned: PinnedAddress[], init: { method: string; headers?: RequestInit["headers"]; body?: RequestInit["body"]; signal: AbortSignal }): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? undefined).forEach((v, k) => {
      headers[k] = v;
    });
    const body = requestBody(init.body);
    const pinnedLookup = (_host: string, opts: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
      if (typeof opts === "object" && opts?.all) cb(null, pinned);
      else cb(null, pinned[0]!.address, pinned[0]!.family);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: init.method, headers, lookup: pinnedLookup as never, agent: false, signal: init.signal }, (res) => {
      try {
        resolve(toResponse(res, init.method));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
    req.end(body);
  });
}

export interface SafeFetchOptions extends RequestInit {
  /** abort after this many ms (default 10 s) — the whole exchange, body included */
  timeoutMs?: number;
  /** max response bytes read by `readCapped` (callers that stream must cap themselves) */
  maxBytes?: number;
  /** skip the public-host check (in-cluster upstreams the operator configured) */
  trusted?: boolean;
  /**
   * A stand-in transport (tests). The default — and global fetch() passed explicitly — connects through
   * pinnedFetch to the checked addresses; a stand-in still gets every hop checked but does its own connecting.
   */
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
 * `res` with a body that keeps the deadline armed until it ends, errors or is cancelled. pinnedFetch's node:http
 * socket has no idle timeout of its own (fetch()'s had 300 s), so a server that sent its headers and then stalled
 * held the reader, and the socket, for ever. A body nobody reads is cut off when the deadline fires.
 */
function armedUntilRead(res: Response, release: () => void): Response {
  if (!res.body) {
    release();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * fetch() that only talks to public hosts, follows at most 3 redirects (each
 * re-checked; 307/308 keep the method+body, 301/302/303 become GET without a
 * body) and never forwards the request headers across an origin change. Every
 * hop is resolved once and connected to the addresses that passed the check.
 * `timeoutMs` covers reading the body as well as getting the headers.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, trusted = false, fetchImpl = fetch, maxBytes: _m, ...init } = opts;
  const pin = !trusted && fetchImpl === globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onOuterAbort);
  const release = () => {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onOuterAbort);
  };
  try {
    let current = url;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let headers = init.headers;
    for (let hop = 0; ; hop++) {
      let res: Response;
      if (pin) {
        // every hop, redirects included: resolve once, check, and connect to exactly what was checked
        const { url: target, addresses } = await resolvePublicUrl(current);
        res = await pinnedFetch(target, addresses, { method, headers, body, signal: controller.signal });
      } else {
        if (!trusted) await assertPublicUrl(current);
        res = await fetchImpl(current, { ...init, method, body, headers, redirect: "manual", signal: controller.signal });
      }
      const loc = res.headers.get("location");
      if (!(res.status >= 300 && res.status < 400 && loc)) return armedUntilRead(res, release);
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
  } catch (err) {
    release();
    throw err;
  }
}
