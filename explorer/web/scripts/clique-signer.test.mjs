// Recover the Clique signer of a Ferminux block from its header, with ethers v6,
// and check it against the node's own clique_getSigner.
//
//   node scripts/clique-signer.test.mjs            # needs `ethers` resolvable (npm i in explorer/web)
//
// The recovery (signerOf) is the part the explorer ships; the rest is the test.
import { encodeRlp, keccak256, recoverAddress, Signature, toBeArray, getAddress, dataSlice, dataLength, ZeroAddress } from "ethers";

export const POSA_BLOCK = 160000; // first authority block; below it blocks were produced by proof-of-work
const SEAL = 65;                  // r(32) || s(32) || v(1), v in {0,1}

/** Minimal big-endian bytes for an RLP integer (0 -> empty string), from a JSON-RPC hex quantity. */
const q = (hex) => toBeArray(BigInt(hex));

/**
 * The address that sealed an authority block, recovered from the 65-byte seal at the end of
 * extraData. `h` is the raw eth_getBlockByNumber / eth_getBlockByHash result (hex fields).
 * Returns null for proof-of-work blocks (number < POSA_BLOCK): there the header `miner` is real.
 */
export function signerOf(h) {
  if (Number(BigInt(h.number)) < POSA_BLOCK) return null;
  const n = dataLength(h.extraData);
  if (n < SEAL) throw new Error(`extraData is ${n} bytes, no seal`);
  const fields = [
    h.parentHash, h.sha3Uncles, h.miner, h.stateRoot, h.transactionsRoot, h.receiptsRoot, h.logsBloom,
    q(h.difficulty), q(h.number), q(h.gasLimit), q(h.gasUsed), q(h.timestamp),
    dataSlice(h.extraData, 0, n - SEAL), // everything but the seal (vanity, and on checkpoints the signer list)
    h.mixHash, h.nonce,
  ];
  if (h.baseFeePerGas != null) fields.push(q(h.baseFeePerGas)); // London: present on every Ferminux block
  const sealHash = keccak256(encodeRlp(fields));
  const seal = dataSlice(h.extraData, n - SEAL);
  const v = parseInt(dataSlice(seal, 64), 16);
  const sig = Signature.from({ r: dataSlice(seal, 0, 32), s: dataSlice(seal, 32, 64), v: v < 27 ? v + 27 : v });
  return getAddress(recoverAddress(sealHash, sig));
}

// ---------------------------------------------------------------- test ----
const RPC = process.env.FMX_RPC || "https://rpc.ferminux.net";
let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const head = Number(BigInt(await rpc("eth_blockNumber")));
  // latest few, a block with transactions, the first authority block, epoch checkpoints (carry the signer list), random samples
  const nums = [head, head - 1, head - 2, head - 3, head - 4, 389886, 362339, POSA_BLOCK, POSA_BLOCK + 1, 180000, 210000, 390000];
  for (let i = 0; i < 12; i++) nums.push(POSA_BLOCK + Math.floor(Math.random() * (head - POSA_BLOCK)));
  let ok = 0, bad = 0;
  for (const n of nums) {
    const hex = "0x" + n.toString(16);
    const h = await rpc("eth_getBlockByNumber", [hex, false]);
    const mine = signerOf(h);
    const node = getAddress(await rpc("clique_getSigner", [hex]));
    const pass = mine === node && h.miner === ZeroAddress;
    pass ? ok++ : bad++;
    console.log(`${pass ? "PASS" : "FAIL"} #${n} extra=${dataLength(h.extraData)}B miner=${h.miner.slice(0, 6)}… recovered=${mine} node=${node}`);
  }
  // proof-of-work block: no seal, the real producer is header.miner
  const pow = await rpc("eth_getBlockByNumber", ["0x" + (82711).toString(16), false]);
  const powPass = signerOf(pow) === null && pow.miner !== ZeroAddress && dataLength(pow.extraData) < SEAL;
  powPass ? ok++ : bad++;
  console.log(`${powPass ? "PASS" : "FAIL"} #82711 proof-of-work: extra=${dataLength(pow.extraData)}B, signerOf=null, miner=${pow.miner}`);
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}
