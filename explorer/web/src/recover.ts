/* LAZY chunk (ethers): local Clique seal recovery, used only when the node's clique_* namespace fails or a
   page wants to check the node's answer. Ported from scripts/clique-signer.test.mjs `signerOf()`, which
   passed 25/25 against the node on 2026-09-24 (API.md §5). Import it with `await import("./recover")`. */
import { encodeRlp, keccak256, recoverAddress, Signature, toBeArray, getAddress, dataSlice, dataLength } from "ethers";
import type { RawBlock } from "./rpc";
import { POSA_BLOCK } from "./known";

const SEAL = 65; // r(32) || s(32) || v(1), v in {0,1}
/** Minimal big-endian bytes for an RLP integer (0 -> empty string), from a JSON-RPC hex quantity. */
const q = (hex: string) => toBeArray(BigInt(hex));

/** The address that sealed an authority block, recovered from the seal at the end of extraData.
 *  Returns null for proof-of-work blocks (< 160,000): there the header `miner` is the real producer. */
export function signerOf(h: RawBlock): string | null {
  if (Number(BigInt(h.number)) < POSA_BLOCK) return null;
  const n = dataLength(h.extraData);
  if (n < SEAL) throw new Error(`extraData is ${n} bytes, no seal`);
  const fields: (string | Uint8Array)[] = [
    h.parentHash, h.sha3Uncles, h.miner, h.stateRoot, h.transactionsRoot, h.receiptsRoot, h.logsBloom,
    q(h.difficulty), q(h.number), q(h.gasLimit), q(h.gasUsed), q(h.timestamp),
    dataSlice(h.extraData, 0, n - SEAL), // vanity (and on checkpoints the signer list), without the seal
    h.mixHash, h.nonce,
  ];
  if (h.baseFeePerGas != null) fields.push(q(h.baseFeePerGas)); // present on every Ferminux block
  const sealHash = keccak256(encodeRlp(fields));
  const seal = dataSlice(h.extraData, n - SEAL);
  const v = parseInt(dataSlice(seal, 64), 16);
  const sig = Signature.from({ r: dataSlice(seal, 0, 32), s: dataSlice(seal, 32, 64), v: v < 27 ? v + 27 : v });
  return getAddress(recoverAddress(sealHash, sig));
}

/** EIP-55 checksum for an address the RPC returned in lower case. */
export const checksum = (a: string) => getAddress(a);
