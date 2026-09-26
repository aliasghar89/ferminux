// One icon set for the DEX, drawn on the Ferminux Wallet's grid (24 units,
// 1.7 stroke, round caps) so the two apps read as one product. Inline SVG:
// nothing is fetched. Every icon is decorative (aria-hidden); the control that
// holds it carries the accessible name.

import type { ReactNode } from 'react';

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={'ic' + (className ? ' ' + className : '')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { className?: string };

/** Two opposed arrows: Swap. */
export const IconSwap = (p: P) => (
  <Svg {...p}>
    <path d="M7 4v14M3.5 7.5 7 4l3.5 3.5" />
    <path d="M17 20V6M20.5 16.5 17 20l-3.5-3.5" />
  </Svg>
);
/** Stacked layers: Pools. */
export const IconPools = (p: P) => (
  <Svg {...p}>
    <path d="m12 4 8.5 4.5L12 13 3.5 8.5z" />
    <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
  </Svg>
);
/** A drop with a plus: Liquidity. */
export const IconLiquidity = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5c3.2 3.9 6 7.3 6 10.5a6 6 0 0 1-12 0c0-3.2 2.8-6.6 6-10.5Z" />
    <path d="M12 11v6M9 14h6" />
  </Svg>
);
/** A line over axes: Charts. */
export const IconChart = (p: P) => (
  <Svg {...p}>
    <path d="M4 4v16h16" />
    <path d="m7.5 14.5 3.5-4 3 2.5 5-6" />
  </Svg>
);
/** Lines with a clock hand: Activity. */
export const IconActivity = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);
export const IconArrowDown = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M15 6 9 12l6 6" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M14 5h5v5M19 5l-8 8" />
    <path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);
export const IconUnlock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.7-1.4" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconMinus = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4.5M12 17h.01" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconWallet = (p: P) => (
  <Svg {...p}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="4" y="8" width="16" height="11" rx="2.2" />
    <path d="M16 13.5h.01" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Svg>
);
export const IconWrap = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="15" height="15" rx="7.5" />
    <path d="M9 12h6M12 9v6" />
  </Svg>
);
export const IconKey = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </Svg>
);
export const IconPower = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5v8" />
    <path d="M7 6.5a7 7 0 1 0 10 0" />
  </Svg>
);
