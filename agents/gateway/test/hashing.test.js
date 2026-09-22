// Unit tests for the pure helpers: payload hashing and indexer chunking.
// Runs against the built output (dist/), so `npm run build` must happen first.
import test from "node:test";
import assert from "node:assert/strict";
import { hashPayload } from "../dist/payloads.js";
import { chunkRange } from "../dist/indexer.js";

test("hashPayload: keccak256 of empty bytes matches the well-known constant", () => {
  const hash = hashPayload(new Uint8Array());
  assert.equal(hash, "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

test("hashPayload: is deterministic for the same bytes", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
  const a = hashPayload(bytes);
  const b = hashPayload(bytes);
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("hashPayload: different bytes hash differently", () => {
  const a = hashPayload(new TextEncoder().encode("a"));
  const b = hashPayload(new TextEncoder().encode("b"));
  assert.notEqual(a, b);
});

test("chunkRange: splits an inclusive range into <= chunkSize windows", () => {
  assert.deepEqual(chunkRange(0, 4999, 2000), [
    [0, 1999],
    [2000, 3999],
    [4000, 4999],
  ]);
});

test("chunkRange: single block still produces one chunk", () => {
  assert.deepEqual(chunkRange(10, 10, 2000), [[10, 10]]);
});

test("chunkRange: fromBlock > toBlock yields no chunks", () => {
  assert.deepEqual(chunkRange(10, 5, 2000), []);
});

test("chunkRange: exact multiple of chunkSize has no trailing short chunk", () => {
  assert.deepEqual(chunkRange(0, 3999, 2000), [
    [0, 1999],
    [2000, 3999],
  ]);
});

test("chunkRange: throws on non-positive chunkSize", () => {
  assert.throws(() => chunkRange(0, 10, 0));
});
