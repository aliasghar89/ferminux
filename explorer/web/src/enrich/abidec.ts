/* A small, strict ABI decoder (Solidity ABI spec: head/tail encoding) for the types the Ferminux contracts use:
   uintN/intN, address, bool, bytesN, bytes, string, T[], T[k] and tuples, nested. No keccak, no parser: the
   selectors and topic hashes are precomputed in abi.data.ts. Every read is bounds-checked; any inconsistency
   throws, and the caller shows the raw data with "Not decoded" instead of a guess. */
import type { AbiParam, AbiFrag } from "./abi.data";

export type V =
  | { k: "int"; v: bigint }
  | { k: "addr"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "bytes"; v: string }
  | { k: "str"; v: string }
  | { k: "arr"; v: V[] }
  | { k: "tuple"; v: Arg[] }
  | { k: "hashed"; v: string };
/** One decoded argument: name, canonical type, value; `i` when it came from a topic. */
export interface Arg { n: string; t: string; v: V; i?: boolean }

const MAX_LEN = 4096; // array / byte lengths beyond this are not a real call on this chain: refuse
const fail = (why: string): never => { throw new Error(`abi: ${why}`); };

class Reader {
  constructor(readonly h: string) {}
  get size() { return this.h.length / 2; }
  word(pos: number): string {
    if (pos < 0 || (pos + 32) * 2 > this.h.length) fail(`read past end at ${pos}`);
    return this.h.slice(pos * 2, pos * 2 + 64);
  }
  big(pos: number) { return BigInt("0x" + this.word(pos)); }
  num(pos: number) {
    const b = this.big(pos);
    if (b > BigInt(this.size)) fail(`offset ${b} beyond data`);
    return Number(b);
  }
  slice(pos: number, len: number) {
    if (pos < 0 || (pos + len) * 2 > this.h.length) fail("bytes past end");
    return this.h.slice(pos * 2, (pos + len) * 2);
  }
}

interface T { base: string; dims: (number | null)[]; c?: AbiParam[] }
function parse(p: AbiParam): T {
  const m = p.t.match(/^([a-z0-9]+)((?:\[\d*\])*)$/);
  if (!m) fail(`type ${p.t}`);
  const dims = (m![2].match(/\[\d*\]/g) ?? []).map((d) => (d === "[]" ? null : Number(d.slice(1, -1))));
  return { base: m![1], dims, c: p.c };
}
/** The element type of an array type (drops the LAST dimension). */
const child = (t: T): T => ({ base: t.base, dims: t.dims.slice(0, -1), c: t.c });
function dynamic(t: T): boolean {
  if (t.dims.length) { const last = t.dims[t.dims.length - 1]; return last === null || dynamic(child(t)); }
  if (t.base === "string" || t.base === "bytes") return true;
  if (t.base === "tuple") return (t.c ?? []).some((c) => dynamic(parse(c)));
  return false;
}
function headSize(t: T): number {
  if (dynamic(t)) return 32;
  if (t.dims.length) return (t.dims[t.dims.length - 1] as number) * headSize(child(t));
  if (t.base === "tuple") return (t.c ?? []).reduce((s, c) => s + headSize(parse(c)), 0);
  return 32;
}
const typeName = (t: T): string => (t.base === "tuple" ? `(${(t.c ?? []).map((c) => typeName(parse(c))).join(",")})` : t.base) + t.dims.map((d) => (d === null ? "[]" : `[${d}]`)).join("");

function elementary(r: Reader, base: string, pos: number): V {
  const w = r.word(pos);
  if (base.startsWith("uint")) return { k: "int", v: BigInt("0x" + w) };
  if (base.startsWith("int")) { const bits = Number(base.slice(3) || 256); let x = BigInt("0x" + w); if (x >> 255n) x -= 1n << 256n; if (bits < 256 && (x >= 1n << BigInt(bits - 1) || x < -(1n << BigInt(bits - 1)))) fail("int out of range"); return { k: "int", v: x }; }
  if (base === "address") { if (!/^0{24}/.test(w)) fail("dirty address"); return { k: "addr", v: "0x" + w.slice(24) }; }
  if (base === "bool") { const b = BigInt("0x" + w); if (b > 1n) fail("bool"); return { k: "bool", v: b === 1n }; }
  const m = base.match(/^bytes(\d+)$/);
  if (m) { const n = Number(m[1]); if (!n || n > 32) fail(base); return { k: "bytes", v: "0x" + w.slice(0, n * 2) }; }
  return fail(`unknown type ${base}`);
}

/** Decode one value whose encoding starts at absolute byte `pos`. */
function one(r: Reader, t: T, pos: number): V {
  if (t.dims.length) {
    const last = t.dims[t.dims.length - 1];
    const el = child(t);
    let n: number, start: number;
    if (last === null) { n = r.num(pos); start = pos + 32; } else { n = last; start = pos; }
    if (n > MAX_LEN) fail("array too long");
    return { k: "arr", v: seq(r, Array.from({ length: n }, () => el), start) };
  }
  if (t.base === "string" || t.base === "bytes") {
    const len = r.num(pos);
    if (len > MAX_LEN * 32) fail("bytes too long");
    const hex = r.slice(pos + 32, len);
    if (t.base === "bytes") return { k: "bytes", v: "0x" + hex };
    return { k: "str", v: utf8(hex) };
  }
  if (t.base === "tuple") return { k: "tuple", v: tuple(r, t.c ?? [], pos) };
  return elementary(r, t.base, pos);
}
/** A sequence of values encoded as a tuple starting at `base` (array elements). */
function seq(r: Reader, ts: T[], base: number): V[] {
  let off = base;
  return ts.map((t) => {
    const v = dynamic(t) ? one(r, t, base + r.num(off)) : one(r, t, off);
    off += headSize(t);
    return v;
  });
}
function tuple(r: Reader, ps: AbiParam[], base: number): Arg[] {
  const ts = ps.map(parse);
  const vs = seq(r, ts, base);
  return ps.map((p, i) => ({ n: p.n, t: typeName(ts[i]), v: vs[i] }));
}

export function utf8(hex: string): string {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8", { fatal: false }).decode(b);
}
const clean = (hex: string) => {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  if (h.length % 2 || /[^0-9a-f]/.test(h)) fail("not hex");
  return h;
};

/** Decode call data (after the 4-byte selector) with a function fragment. */
export function decodeCall(f: AbiFrag, input: string): Arg[] {
  const h = clean(input).slice(8);
  return tuple(new Reader(h), f.p, 0);
}

/** Decode an event: indexed params from topics[1..], the rest from data. Dynamic indexed values are hashes. */
export function decodeEvent(f: AbiFrag, topics: string[], data: string): Arg[] {
  const idx = f.p.filter((p) => p.i);
  if (idx.length !== topics.length - 1) fail("topic count");
  const rest = tuple(new Reader(clean(data)), f.p.filter((p) => !p.i), 0);
  let ti = 1, di = 0;
  return f.p.map((p) => {
    if (!p.i) return rest[di++];
    const t = parse(p);
    const topic = clean(topics[ti++]);
    if (topic.length !== 64) fail("topic size");
    const v: V = dynamic(t) || t.base === "tuple" || t.dims.length ? { k: "hashed", v: "0x" + topic } : one(new Reader(topic), t, 0);
    return { n: p.n, t: typeName(t), v, i: true };
  });
}

/** Signature text for display: "deliver(uint256 jobId, bytes32 outputHash, string outputURI)". */
export const signature = (f: AbiFrag) => `${f.n}(${f.p.map((p) => `${typeName(parse(p))}${p.i ? " indexed" : ""}${p.n ? " " + p.n : ""}`).join(", ")})`;
