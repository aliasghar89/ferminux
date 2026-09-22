// Deterministic address identicons, computed locally.
// No browser globals, no network, no canvas, no dependency: the address alone
// decides the picture, so the same account always looks the same on every
// device and nothing is fetched from an avatar service.
//
// Jazzicon-style in spirit (seeded shapes + a palette), but flat and muted to
// stay inside the institutional look: no gradients, no neon, one saturated
// tone per account against the surface colour.

export const IDENTICON_GRID = 5;

/**
 * Muted, dark-UI-safe palette. Deliberately desaturated — an identicon is a
 * recognition aid beside a label, not a decoration competing with the amber
 * accent.
 */
export const IDENTICON_PALETTE: readonly string[] = [
  '#c98f3a', // ochre
  '#8a9db5', // steel
  '#6f9b86', // sage
  '#a8798f', // mauve
  '#7f8ab8', // periwinkle
  '#b08560', // clay
  '#6d9bb0', // slate blue
  '#9b9464', // olive
  '#a5757a', // brick
  '#7d94a0', // pewter
  '#8f86a8', // amethyst
  '#5f9a94', // teal
] as const;

export const IDENTICON_BACKGROUND = '#e9e9e6';

export interface IdenticonSpec {
  /** Row-major 5×5 flags, mirrored left/right. */
  cells: boolean[];
  /** Which of the filled cells carries the second colour (−1 = none). */
  spotIndex: number;
  color: string;
  spotColor: string;
  background: string;
}

/**
 * xorshift32 seeded from the address bytes. Small, exactly reproducible in
 * every JS engine (all arithmetic stays inside 32-bit ints).
 */
function seedFrom(address: string): number {
  const hex = address.trim().toLowerCase().replace(/^0x/, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < hex.length; i += 1) {
    h ^= hex.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 0x9e3779b9 : h;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Build the identicon for an address. Case-insensitive: the checksummed and
 * lower-cased forms of one address produce the same picture.
 */
export function identicon(address: string): IdenticonSpec {
  const rnd = makeRandom(seedFrom(address));
  const colorIdx = Math.floor(rnd() * IDENTICON_PALETTE.length) % IDENTICON_PALETTE.length;
  let spotIdx = Math.floor(rnd() * IDENTICON_PALETTE.length) % IDENTICON_PALETTE.length;
  if (spotIdx === colorIdx) spotIdx = (spotIdx + 5) % IDENTICON_PALETTE.length;

  const half = Math.ceil(IDENTICON_GRID / 2); // 3 generated columns, 2 mirrored
  const cells: boolean[] = new Array(IDENTICON_GRID * IDENTICON_GRID).fill(false);
  for (let row = 0; row < IDENTICON_GRID; row += 1) {
    for (let col = 0; col < half; col += 1) {
      const on = rnd() > 0.5;
      cells[row * IDENTICON_GRID + col] = on;
      cells[row * IDENTICON_GRID + (IDENTICON_GRID - 1 - col)] = on;
    }
  }

  // Guarantee a readable figure: a blank or fully filled grid is no identicon.
  const filled = cells.reduce<number[]>((acc, on, i) => (on ? [...acc, i] : acc), []);
  if (filled.length === 0) {
    const centre = Math.floor((IDENTICON_GRID * IDENTICON_GRID) / 2);
    cells[centre] = true;
    filled.push(centre);
  } else if (filled.length === cells.length) {
    cells[0] = false;
    cells[IDENTICON_GRID - 1] = false;
    filled.splice(filled.indexOf(0), 1);
    filled.splice(filled.indexOf(IDENTICON_GRID - 1), 1);
  }

  const spotIndex = filled[Math.floor(rnd() * filled.length) % filled.length] ?? -1;

  return {
    cells,
    spotIndex,
    color: IDENTICON_PALETTE[colorIdx],
    spotColor: IDENTICON_PALETTE[spotIdx],
    background: IDENTICON_BACKGROUND,
  };
}
