// A small JSON-RPC client over fetch: single calls and batches, a timeout per request, and retries with
// exponential backoff on transport failures and 5xx/429 answers. A JSON-RPC error (the node understood the
// request and said no) is never retried here: the caller decides what it means.

export class RpcError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly data: unknown = null) {
    super(message);
    this.name = "RpcError";
  }
  /** "method not found / not available": the node does not offer this namespace. */
  get unsupported(): boolean {
    return this.code === -32601 || /method .*(not found|does not exist|not available|not supported)|unsupported method/i.test(this.message);
  }
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Results in request order; a failed entry is an RpcError instance (never thrown). */
  batch(calls: { method: string; params?: unknown[] }[]): Promise<unknown[]>;
}

export interface RpcOptions {
  timeoutMs?: number;
  retries?: number;
  /** base backoff in ms (doubles each retry) */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** max calls per HTTP batch */
  maxBatch?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Rpc implements RpcLike {
  private id = 0;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxBatch: number;

  constructor(readonly url: string, o: RpcOptions = {}) {
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.retries = o.retries ?? 4;
    this.backoffMs = o.backoffMs ?? 500;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? realSleep;
    this.maxBatch = o.maxBatch ?? 100;
  }

  private async post(body: unknown): Promise<unknown> {
    let last: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await this.sleep(Math.min(this.backoffMs * 2 ** (attempt - 1), 15_000));
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
        if (res.status === 429 || res.status >= 500) { last = new TransportError(`RPC HTTP ${res.status}`); continue; }
        if (!res.ok) throw new TransportError(`RPC HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (e instanceof TransportError && !/HTTP (429|5\d\d)/.test(e.message)) throw e;
        last = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(t);
      }
    }
    throw new TransportError(`RPC unreachable at ${this.url}: ${last?.message ?? "unknown error"}`);
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const r = (await this.post({ jsonrpc: "2.0", id: ++this.id, method, params })) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (r && r.error) throw new RpcError(r.error.message, r.error.code, r.error.data);
    if (!r || !("result" in r)) throw new TransportError(`RPC ${method}: malformed answer`);
    return r.result as T;
  }

  async batch(calls: { method: string; params?: unknown[] }[]): Promise<unknown[]> {
    const out: unknown[] = new Array(calls.length);
    for (let off = 0; off < calls.length; off += this.maxBatch) {
      const chunk = calls.slice(off, off + this.maxBatch);
      const ids = chunk.map(() => ++this.id);
      const body = chunk.map((c, i) => ({ jsonrpc: "2.0", id: ids[i], method: c.method, params: c.params ?? [] }));
      const res = (await this.post(body)) as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }[] | { error?: { code: number; message: string } };
      if (!Array.isArray(res)) {
        const err = (res as { error?: { code: number; message: string } })?.error;
        throw new RpcError(err?.message ?? "batch rejected", err?.code ?? null);
      }
      const byId = new Map(res.map((r) => [r.id, r]));
      chunk.forEach((c, i) => {
        const r = byId.get(ids[i]);
        out[off + i] = !r ? new RpcError(`${c.method}: no answer in batch`) : r.error ? new RpcError(r.error.message, r.error.code, r.error.data) : r.result;
      });
    }
    return out;
  }
}

export const hexToBig = (h: unknown): bigint => (typeof h === "string" && h.length ? BigInt(h) : 0n);
export const hexToNum = (h: unknown): number => Number(hexToBig(h));
export const toHex = (n: bigint | number): string => "0x" + BigInt(n).toString(16);
