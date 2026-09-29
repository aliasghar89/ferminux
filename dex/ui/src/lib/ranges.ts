// Chart ranges shared by the Charts page and a pool's page: the segmented
// control's options and where each range starts. Its own module so a pool's
// page does not pull the Charts page in with it (the pages load on demand).

import { DAY } from './market.ts';

export type Range = '1D' | '7D' | '30D' | 'ALL';
export const RANGES: ReadonlyArray<readonly [Range, string]> = [
  ['1D', '24H'],
  ['7D', '7D'],
  ['30D', '30D'],
  ['ALL', 'All'],
];

export function rangeStart(range: Range, now: number, first: number | null): number {
  if (range === '1D') return now - DAY;
  if (range === '7D') return now - 7 * DAY;
  if (range === '30D') return now - 30 * DAY;
  // Everything there is, from the first recorded point, never less than an hour.
  if (first === null) return now - 30 * DAY;
  const span = Math.max(3600, now - first);
  return now - Math.ceil(span * 1.04);
}
