// FRC-100 domain-tagged merkle tree — the construction MemoryAnchor.sol
// implements on chain, reproduced here byte-for-byte so an SDK-built root is
// the root the contract accepts and `MemoryAnchor.verify(root, record, proof,
// index, count)` returns true for every proof this module emits.
//
//   leaf(h)    = keccak256(abi.encodePacked(uint8(0), h))   , h = keccak256(record bytes)
//   node(l, r) = keccak256(abi.encodePacked(uint8(1), l, r))
//   an odd node at a level is paired with itself and consumes NO proof element
//
// KEEP IN SYNC: an identical copy lives in agents/gateway/src/v3/merkle.ts.
//
// TWO MERKLE SCHEMES LIVE IN THIS CODEBASE AND THEY ARE NOT INTERCHANGEABLE.
// `v3/cv.ts` (and the gateway's `v3/audit.ts`) keep the older untagged
// construction — leaf = keccak256(utf8(canonicalJson(claim))), node =
// keccak256(concat(l, r)), an odd node paired with itself and CONSUMING a proof
// element — because the published AI-CV and audit-export formats already commit
// to it and neither has an on-chain counterpart. Everything anchored through
// MemoryAnchor uses THIS module. Never fold a CV leaf with `memoryRoot`, or a
// memory leaf with `cvMerkleRoot`.
import { concat, keccak256, toUtf8Bytes } from "ethers";

export const LEAF_TAG = "0x00";
export const NODE_TAG = "0x01";
export const ZERO_HASH = `0x${"0".repeat(64)}`;

/** leaf = keccak256(0x00 ‖ recordHash) — MemoryAnchor.leafOf. */
export function memoryLeaf(recordHash: string): string {
  return keccak256(concat([LEAF_TAG, recordHash]));
}

/** keccak256 of the record's UTF-8 bytes, then the leaf tag — MemoryAnchor.recordLeaf. */
export function memoryRecordLeaf(recordBytes: string): string {
  return memoryLeaf(keccak256(toUtf8Bytes(recordBytes)));
}

function node(l: string, r: string): string {
  return keccak256(concat([NODE_TAG, l, r]));
}

/** Root over `leaves` in order — MemoryAnchor.computeRoot. Throws on an empty batch (the contract reverts EmptyBatch). */
export function memoryRoot(leaves: readonly string[]): string {
  if (!leaves.length) throw new Error("Ferminux: memoryRoot over an empty batch");
  let level: string[] = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = level[i + 1] ?? l; // odd node pairs with itself
      next.push(node(l, r));
    }
    level = next;
  }
  return level[0];
}

/**
 * Sibling path for `index`, in the order MemoryAnchor.verifyLeaf consumes it.
 * A level whose last node is odd pairs that node with itself and contributes
 * NO element, which is why the verifier needs `count` to walk the same shape.
 */
export function memoryProof(leaves: readonly string[], index: number): string[] {
  if (index < 0 || index >= leaves.length) throw new Error(`Ferminux: memoryProof index ${index} out of range (${leaves.length})`);
  const proof: string[] = [];
  let level: string[] = [...leaves];
  let idx = index;
  while (level.length > 1) {
    const odd = level.length % 2 === 1;
    if (!(idx === level.length - 1 && odd)) proof.push(level[idx % 2 === 0 ? idx + 1 : idx - 1]);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(node(level[i], level[i + 1] ?? level[i]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * The verifier a stranger runs — MemoryAnchor.verifyLeaf, in TypeScript. Pure:
 * no RPC, no gateway. `count` pins the tree's exact shape, which is what closes
 * the duplicate-leaf ambiguity a domain tag alone cannot.
 */
export function memoryVerify(root: string, leaf: string, proof: readonly string[], index: number, count: number): boolean {
  if (!root || root === ZERO_HASH || count === 0 || index >= count) return false;
  let computed = leaf;
  let idx = index;
  let levelSize = count;
  let p = 0;
  while (levelSize > 1) {
    if (idx === levelSize - 1 && levelSize % 2 === 1) {
      computed = node(computed, computed);
    } else {
      if (p === proof.length) return false;
      const sibling = proof[p++];
      computed = idx % 2 === 0 ? node(computed, sibling) : node(sibling, computed);
    }
    idx = Math.floor(idx / 2);
    levelSize = Math.floor((levelSize + 1) / 2);
  }
  // leftover proof elements are a forgery attempt, not a valid proof
  return p === proof.length && computed.toLowerCase() === root.toLowerCase();
}

export const MEMORY_MERKLE_SPEC = {
  leaf: "keccak256(abi.encodePacked(uint8(0), keccak256(record bytes)))",
  node: "keccak256(abi.encodePacked(uint8(1), left, right))",
  odd: "an odd node at a level is paired with itself and consumes no proof element",
  count: "the leaf count is anchored on chain and pins the tree shape — a verifier MUST pass it",
  contract: "MemoryAnchor.verify(root, record, proof, index, count)",
} as const;
