// Display hygiene for text that other people control: token symbols, NFT
// metadata, dApp names, signing requests. Pure, no browser globals.
//
// Control characters, zero-width marks and bidi overrides let a hostile string
// look like something else ("USDC" that is not, an address whose tail is
// visually reversed), so they are removed before anything is shown.

const RANGES: Array<[number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x2028, 0x2029], // line/paragraph separators
  [0x202a, 0x202e], // bidi embeddings/overrides
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function classOf(ranges: Array<[number, number]>): string {
  const esc = (n: number) => '\\u' + n.toString(16).padStart(4, '0');
  return '[' + ranges.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('') + ']';
}

/** Every character stripped by cleanText. */
export const INVISIBLE_RE = new RegExp(classOf(RANGES), 'g');

/**
 * Invisible/bidi characters that never belong in a readable message; tab, LF
 * and CR are allowed there, so they are not in this class.
 */
export const UNREADABLE_RE = new RegExp(
  classOf([
    [0x0000, 0x0008],
    [0x000b, 0x000c],
    [0x000e, 0x001f],
    [0x007f, 0x007f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]),
);

/** Strip invisible characters, collapse whitespace, trim, cap the length (with an ellipsis). */
export function cleanText(raw: unknown, max: number, ellipsis = true): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return ellipsis ? s.slice(0, max).trimEnd() + '…' : s.slice(0, max).trimEnd();
}
