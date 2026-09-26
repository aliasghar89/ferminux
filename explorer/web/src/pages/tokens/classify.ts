/* Which token standard an address the explorer's index hasn't catalogued answers to, from the raw eth_call
   results (0x hex, or null when the call reverted or failed). No imports, so scripts/chain-token.test.mjs runs
   it in Node against live answers from rpc.ferminux.net.
   - FRC-721 when the FRC-165 check passes: supportsInterface(0x80ac58cd) answers exactly true and
     supportsInterface(0xffffffff) answers exactly false (the index lists an FRC-721 only after its first Transfer);
   - otherwise, only for an address the contract book calls a token: decimals() in 0..77 → FRC-20;
   - otherwise null: not read as a token, and the page keeps its 404. */
export type TokenStd = "FRC-721" | "FRC-20";

const word = (h: string | null): bigint | null => (h && /^0x[0-9a-fA-F]{64}/.test(h) ? BigInt(h.slice(0, 66)) : null);
/** One ABI bool, exactly 32 bytes: anything longer or other than 0/1 is some other function's answer. */
const bool = (h: string | null): boolean | null => {
  if (!h || !/^0x[0-9a-fA-F]{64}$/.test(h)) return null;
  const v = BigInt(h);
  return v === 1n ? true : v === 0n ? false : null;
};

/** The FRC-165 test for FRC-721: `probe` = supportsInterface(0x80ac58cd), `invalid` = supportsInterface(0xffffffff). */
export const supports721 = (probe: string | null, invalid: string | null): boolean => bool(probe) === true && bool(invalid) === false;

export function classify(probe: string | null, invalid: string | null, decimals: string | null, bookToken: boolean): { type: TokenStd; decimals: number | null } | null {
  if (supports721(probe, invalid)) return { type: "FRC-721", decimals: null };
  if (!bookToken) return null;
  const d = word(decimals);
  return d !== null && d <= 77n ? { type: "FRC-20", decimals: Number(d) } : null;
}
