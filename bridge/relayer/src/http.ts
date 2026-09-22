// The operator/peer HTTP surface. Small on purpose.
//
//   GET /health       liveness + readiness. 200 when this node can do its job,
//                     503 when it cannot. Never authenticated — a health check
//                     that needs a secret is a health check nobody wires up.
//                     It does no store work and touches no chain.
//   GET /metrics      Prometheus text.
//   GET /status       full JSON status: chains, endpoints, cursors, counts.
//   GET /signatures   validator only. ?transferId=0x… -> this node's attestation.
//   GET /transfers    debug listing, ?status=&limit=.
//
// There are no POST routes and no mutating routes at all. A validator's HTTP
// surface cannot be made to sign anything: signing is driven exclusively by what
// the node itself observed on chain. The submitter "requesting" a signature is a
// GET — if the validator has not independently confirmed that transfer, the
// answer is 404 and no amount of asking changes it.
//
// What IS enforced here, because "read-only" is not the same as "harmless":
//   * every route except /health needs the bearer token, and config.ts refuses
//     to start a network-reachable bind without one — /status and /transfers
//     describe every in-flight transfer, sender and recipient included
//   * a per-client token bucket, including on /health, so an unauthenticated
//     caller cannot spend this process's CPU and sockets keeping a validator
//     from serving signatures to the submitter
//   * hard caps on the request line, the header block and the connection count,
//     and a flat refusal of any request that carries a body

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RateLimitConfig } from './config.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';

/** Longest `GET /path?query` this service will even parse. */
export const MAX_REQUEST_LINE = 2_048;
/** Anything with a body is a client bug or a probe; there are no POST routes. */
export const MAX_REQUEST_BODY = 0;
/**
 * Callers holding the bearer token get this multiple of the configured budget.
 *
 * The threat being rate-limited is an anonymous flood; the submitter is not
 * that. It polls every validator for every in-flight transfer on every tick, so
 * a busy bridge legitimately produces bursts far above what an unauthenticated
 * caller should ever get — and throttling the submitter would stall signature
 * collection, which is the outage the rate limiter was added to prevent.
 */
export const AUTHENTICATED_RATE_MULTIPLIER = 10;

export interface HttpHandlers {
  health(): { ok: boolean; body: Record<string, unknown> };
  status(): Record<string, unknown>;
  signatures?(transferId: string): Record<string, unknown> | null;
  transfers?(status: string | null, limit: number): unknown[];
}

export interface HttpServerOptions {
  host: string;
  port: number;
  apiToken: string | null;
  rateLimit: RateLimitConfig;
  maxConnections: number;
  metrics: Metrics;
  handlers: HttpHandlers;
  log: Logger;
}

/**
 * Per-client token bucket. Refills continuously rather than on a window edge,
 * so there is no instant to sit on and spend the budget twice — the same shape
 * as the volume limiter, for the same reason.
 */
export class TokenBucketLimiter {
  private readonly burst: number;
  private readonly refillPerMs: number;
  private readonly maxClients: number;
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(cfg: RateLimitConfig) {
    this.burst = cfg.burst;
    this.refillPerMs = cfg.refillPerSecond / 1000;
    this.maxClients = cfg.maxClients;
  }

  /** True when the request may proceed; false when the client is over budget. */
  take(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Bound the table: a spoofed-source flood must not become a memory leak.
      if (this.buckets.size >= this.maxClients) this.evict(now);
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(now - bucket.updatedAt, 0);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Seconds until this client has a token again. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const missing = Math.max(1 - bucket.tokens, 0);
    return Math.max(Math.ceil(missing / this.refillPerMs / 1000), 1);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Drop everything that has refilled to full — they cost nothing to recreate. */
  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(now - bucket.updatedAt, 0);
      if (bucket.tokens + elapsed * this.refillPerMs >= this.burst) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxClients) this.buckets.clear();
  }
}

export class RelayerHttpServer {
  private readonly server: Server;
  private readonly opts: HttpServerOptions;
  private readonly log: Logger;
  /** Anonymous callers. The only unauthenticated route is /health. */
  private readonly anonLimiter: TokenBucketLimiter;
  /** Callers presenting the bearer token — chiefly the submitter. */
  private readonly authedLimiter: TokenBucketLimiter;
  private actualPort = 0;
  private throttled = 0;

  constructor(opts: HttpServerOptions) {
    this.opts = opts;
    this.log = opts.log.child({ component: 'http' });
    this.anonLimiter = new TokenBucketLimiter(opts.rateLimit);
    this.authedLimiter = new TokenBucketLimiter({
      burst: opts.rateLimit.burst * AUTHENTICATED_RATE_MULTIPLIER,
      refillPerSecond: opts.rateLimit.refillPerSecond * AUTHENTICATED_RATE_MULTIPLIER,
      maxClients: opts.rateLimit.maxClients,
    });
    this.server = createServer({ maxHeaderSize: 8_192 }, (req, res) => this.route(req, res));
    // Slowloris and socket exhaustion are the cheap ways to keep a validator
    // from answering the submitter. None of these routes needs a long life.
    this.server.maxConnections = opts.maxConnections;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.on('clientError', (_err, socket) => {
      if (socket && !(socket as { destroyed?: boolean }).destroyed) socket.destroy();
    });
    opts.metrics.describe('relayer_http_requests_total', 'HTTP requests served, by route and outcome');
  }

  get port(): number {
    return this.actualPort;
  }

  /** Requests rejected by the rate limiter since start. Exposed for tests. */
  get throttledCount(): number {
    return this.throttled;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.log.info('http listening', {
          host: this.opts.host,
          port: this.actualPort,
          authenticated: this.opts.apiToken !== null,
          rateLimit:
            `${this.opts.rateLimit.burst} burst / ${this.opts.rateLimit.refillPerSecond}/s per anonymous client, ` +
            `${AUTHENTICATED_RATE_MULTIPLIER}x that for token holders`,
        });
        if (this.opts.apiToken === null) {
          // config.ts already refused this on a network-reachable bind; say it
          // out loud anyway, because "loopback only" is a property of the host's
          // firewall as much as of this flag.
          this.log.warn('no http.apiToken set — /metrics, /status, /signatures and /transfers are UNAUTHENTICATED on this bind', {
            host: this.opts.host,
          });
        }
        resolve(this.actualPort);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.opts.apiToken) return true;
    const header = req.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Length-independent compare is overkill for a bearer token on a private
    // network, but constant-time costs nothing and removes the argument.
    return timingSafeEqual(supplied, this.opts.apiToken);
  }

  /** Rate-limit key: the peer address. No X-Forwarded-For — it is caller-controlled. */
  private clientKey(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? '/';

    if (rawUrl.length > MAX_REQUEST_LINE) {
      this.count('oversize', 'rejected');
      return send(res, 414, { error: 'request line too long' });
    }

    // Token bucket BEFORE any routing or store access, including on /health:
    // the resource being protected is this process's ability to answer at all.
    // The token check itself is a constant-time string compare, so deciding
    // WHICH bucket applies is cheaper than the limiter it feeds.
    const authed = this.authorized(req);
    const limiter = authed ? this.authedLimiter : this.anonLimiter;
    const key = this.clientKey(req);
    if (!limiter.take(key)) {
      this.throttled += 1;
      this.count('any', 'throttled');
      res.setHeader('retry-after', String(limiter.retryAfterSeconds(key)));
      return send(res, 429, { error: 'rate limit exceeded' });
    }

    if (req.method !== 'GET') {
      this.count('any', 'rejected');
      return send(res, 405, { error: 'method not allowed' });
    }

    // No route reads a body. Answer, then drop the socket rather than draining
    // an upload nothing will ever read — a chunked body has no declared size,
    // so "read it and then reject it" is an unbounded write into this process.
    const declared = Number(req.headers['content-length'] ?? 0);
    if ((Number.isFinite(declared) && declared > MAX_REQUEST_BODY) || req.headers['transfer-encoding']) {
      this.count('any', 'rejected');
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      res.end(JSON.stringify({ error: 'this API has no routes that accept a body' }), () => req.socket?.destroy());
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      this.count('any', 'rejected');
      return send(res, 400, { error: 'malformed request target' });
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      const { ok, body } = this.opts.handlers.health();
      this.count('health', ok ? 'ok' : 'unhealthy');
      return send(res, ok ? 200 : 503, body);
    }

    if (!authed) {
      this.count(path.slice(1) || 'root', 'unauthorized');
      return send(res, 401, { error: 'unauthorized' });
    }

    switch (path) {
      case '/metrics': {
        this.count('metrics', 'ok');
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        res.end(this.opts.metrics.render());
        return;
      }
      case '/status':
        this.count('status', 'ok');
        return send(res, 200, this.opts.handlers.status());
      case '/signatures': {
        if (!this.opts.handlers.signatures) return send(res, 404, { error: 'this node does not serve signatures' });
        const transferId = url.searchParams.get('transferId');
        if (!transferId || !/^0x[0-9a-fA-F]{64}$/.test(transferId)) {
          this.count('signatures', 'rejected');
          return send(res, 400, { error: 'transferId must be a 32-byte hex string' });
        }
        const found = this.opts.handlers.signatures(transferId);
        this.count('signatures', found ? 'ok' : 'missing');
        if (!found) return send(res, 404, { error: 'no signature', transferId });
        return send(res, 200, found);
      }
      case '/transfers': {
        if (!this.opts.handlers.transfers) return send(res, 404, { error: 'not available' });
        const statusParam = url.searchParams.get('status');
        const status = statusParam !== null && /^[a-z_]{1,32}$/.test(statusParam) ? statusParam : null;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 500);
        this.count('transfers', 'ok');
        return send(res, 200, { transfers: this.opts.handlers.transfers(status, limit) });
      }
      case '/':
        this.count('root', 'ok');
        return send(res, 200, { service: 'ferminux-bridge-relayer', routes: ['/health', '/metrics', '/status', '/signatures', '/transfers'] });
      default:
        this.count('unknown', 'rejected');
        return send(res, 404, { error: 'not found' });
    }
  }

  private count(route: string, outcome: string): void {
    this.opts.metrics.inc('relayer_http_requests_total', { route, outcome });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function timingSafeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
