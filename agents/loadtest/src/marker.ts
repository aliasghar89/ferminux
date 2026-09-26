// The load-test marker. EVERY transaction this service signs carries it in its data field, so anyone can
// tell a load-test transaction from organic traffic with nothing but the transaction itself:
//
//   0x 46 58 4c 54 01
//      F  X  L  T  version
//
// A native FMX transfer to an account with no code ignores its data, so the marker costs gas only
// (intrinsic calldata gas, see gas.ts) and never changes what the transfer does.

/** The 4 marker bytes, "FXLT", as a lower-case 0x-hex prefix. */
export const MARKER_PREFIX = "0x46584c54";
/** Marker format version (the 5th byte). */
export const MARKER_VERSION = 1;
/** The full data field of every load-test transaction. */
export const MARKER_DATA = "0x46584c5401";
/** The same, as bytes (for gas math). */
export const MARKER_BYTES = Uint8Array.from([0x46, 0x58, 0x4c, 0x54, MARKER_VERSION]);

/** True when a transaction's input starts with the FXLT marker (any version). */
export function isMarked(input: string | null | undefined): boolean {
  return typeof input === "string" && input.toLowerCase().startsWith(MARKER_PREFIX);
}

/** The marker version of an input, or null when the input is not marked. */
export function markerVersion(input: string | null | undefined): number | null {
  if (!isMarked(input)) return null;
  const hex = input!.slice(10, 12);
  return hex.length === 2 ? parseInt(hex, 16) : null;
}
