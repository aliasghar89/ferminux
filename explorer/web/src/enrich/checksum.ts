/* EIP-55 address checksums without ethers: a compact Keccak-256 (Keccak-f[1600] on BigInt lanes). Decoded call
   data and topics give lower-case addresses; the chips should read like the index's checksummed ones. A few
   addresses per page, so BigInt speed is plenty. Checked against ethers' getAddress on 2,000 random addresses.
   Why not ethers: its shared chunk is only worth loading for the signer fallback, not to capitalise hex. */

const M = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets r[x][y]. */
const R = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M);

function permute(A: bigint[]) {
  const C = new Array<bigint>(5), B = new Array<bigint>(25);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[x + y] ^= d; }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M & B[((x + 2) % 5) + 5 * y]);
    A[0] ^= RC[r];
  }
}

/** Keccak-256 (the pre-standard padding Ethereum uses), as lower-case hex without 0x. */
export function keccak256(data: Uint8Array): string {
  const rate = 136;
  const len = Math.ceil((data.length + 1) / rate) * rate;
  const p = new Uint8Array(len);
  p.set(data); p[data.length] ^= 0x01; p[len - 1] ^= 0x80;
  const A = new Array<bigint>(25).fill(0n);
  for (let o = 0; o < len; o += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(p[o + i * 8 + b]);
      A[i] ^= lane;
    }
    permute(A);
  }
  let out = "";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out += Number((A[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

const memo = new Map<string, string>();
/** EIP-55 checksum; anything that isn't a 20-byte hex address comes back unchanged. */
export function checksum(a: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  const lower = a.slice(2).toLowerCase();
  const hit = memo.get(lower);
  if (hit) return hit;
  const h = keccak256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  memo.set(lower, out);
  return out;
}
