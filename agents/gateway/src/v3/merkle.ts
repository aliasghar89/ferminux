// Domain-tagged merkle tree — the construction MemoryAnchor.sol implements on
// chain, reproduced here byte-for-byte so a root built by the gateway is the
// root the contract accepts and `MemoryAnchor.verify(root, record, proof,
// index, count)` returns true for every proof this module emits.
//
//   leaf(h)    = keccak256(abi.encodePacked(uint8(0), h))   , h = keccak256(record bytes)
//   node(l, r) = keccak256(abi.encodePacked(uint8(1), l, r))
//   an odd node at a level is paired with itself and consumes NO proof element
//
// TWO MERKLE SCHEMES LIVE IN THIS CODEBASE AND THEY ARE NOT INTERCHANGEABLE.
// `v3/audit.ts` keeps the older untagged construction (leaf = keccak256(utf8(
// canonicalJson(line))), node = keccak256(concat(l, r))) that the published
// audit export format already commits to; it has no on-chain counterpart, so
// it is left exactly as shipped. Everything anchored on chain uses THIS module.
// Never fold an audit leaf with `memoryRoot`, or a memory leaf with `merkleRoot`.
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
export function memoryRoot(leaves: string[]): string {
  if (!leaves.length) throw new Error("memoryRoot: empty batch");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1] ?? l; // odd node pairs with itself
      next.push(node(l, r));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Sibling path for `index`, in the order MemoryAnchor.verifyLeaf consumes it.
 * A level whose last node is odd pairs that node with itself and contributes
 * NO element, which is why the verifier needs `count` to walk the same shape.
 */
export function memoryProof(leaves: string[], index: number): string[] {
  if (index < 0 || index >= leaves.length) throw new Error(`memoryProof: index ${index} out of range (${leaves.length})`);
  const proof: string[] = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const odd = level.length % 2 === 1;
    if (!(idx === level.length - 1 && odd)) proof.push(level[idx % 2 === 0 ? idx + 1 : idx - 1]!);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(node(level[i]!, level[i + 1] ?? level[i]!));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** The verifier a stranger runs — MemoryAnchor.verifyLeaf, in TypeScript. */
export function memoryVerify(root: string, leaf: string, proof: string[], index: number, count: number): boolean {
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
      const sibling = proof[p++]!;
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
