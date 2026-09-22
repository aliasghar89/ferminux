import { keccak256 } from "ethers";
import type { Db } from "./db.js";

export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KiB

export interface StoredPayload {
  hash: string;
  contentType: string;
  bytes: Buffer;
  size: number;
  createdAt: number;
}

/** keccak256 of the exact bytes, 0x-prefixed hex. Pure — safe to unit test. */
export function hashPayload(bytes: Uint8Array): string {
  return keccak256(bytes);
}

export function storePayload(db: Db, bytes: Uint8Array, contentType: string): { hash: string; uri: string; size: number } {
  const hash = hashPayload(bytes);
  const size = bytes.byteLength;
  const createdAt = Date.now();
  const buf = Buffer.from(bytes);
  db.prepare(
    `INSERT INTO payloads (hash, contentType, bytes, size, createdAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO NOTHING`,
  ).run(hash, contentType || "application/octet-stream", buf, size, createdAt);
  return { hash, uri: `fmx://payload/${hash}`, size };
}

export function getPayload(db: Db, hash: string): StoredPayload | undefined {
  const row = db
    .prepare("SELECT hash, contentType, bytes, size, createdAt FROM payloads WHERE hash = ?")
    .get(hash) as
    | { hash: string; contentType: string; bytes: Buffer; size: number; createdAt: number }
    | undefined;
  return row;
}

/**
 * Content type the payload store SERVES. Payloads are user bytes served from
 * the gateway's own origin, so anything a browser would execute (html, xml,
 * svg, javascript) goes out as text/plain; unknown types as octet-stream.
 * Pair with X-Content-Type-Options: nosniff.
 */
export function servableContentType(stored: string): string {
  const ct = (stored || "").trim();
  const base = ct.split(";")[0]!.trim().toLowerCase();
  if (/^(text\/(html|xml|xsl|vnd\.wap)|application\/(xhtml|xml|.*\+xml|javascript|ecmascript|x-javascript|x-shockwave)|image\/svg)/.test(base)) return "text/plain; charset=utf-8";
  if (base === "application/json" || base === "application/x-ndjson" || base === "application/pdf" || base === "application/octet-stream") return ct;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(base)) return ct;
  if (base.startsWith("text/")) return ct;
  return "application/octet-stream";
}
