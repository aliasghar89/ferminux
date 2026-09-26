import { useCallback, useState } from 'react';
import {
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_SLIPPAGE_BPS,
  MAX_DEADLINE_MINUTES,
  MAX_HOPS,
  MAX_SLIPPAGE_BPS,
} from '../config.ts';

/**
 * Trade settings, shared by Swap and Liquidity and remembered in this browser
 * (a convenience only: nothing here is needed to trade, and an unreadable
 * store simply falls back to the defaults).
 */
export interface TradeSettings {
  slippageBps: number;
  deadlineMinutes: number;
  /** Longest route the swap may take, 1 (direct pools only) to MAX_HOPS. */
  maxHops: number;
  /** Approve the router for every unit instead of the exact trade amount. Off by default. */
  unlimitedApprovals: boolean;
}

export const DEFAULT_SETTINGS: TradeSettings = {
  slippageBps: DEFAULT_SLIPPAGE_BPS,
  deadlineMinutes: DEFAULT_DEADLINE_MINUTES,
  maxHops: MAX_HOPS,
  unlimitedApprovals: false,
};

const KEY = 'ferminux-dex.settings.v2';

function sanitize(raw: Partial<TradeSettings> | null): TradeSettings {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  return {
    slippageBps: Number.isInteger(s.slippageBps) && s.slippageBps >= 0 && s.slippageBps <= MAX_SLIPPAGE_BPS ? s.slippageBps : DEFAULT_SLIPPAGE_BPS,
    deadlineMinutes:
      Number.isFinite(s.deadlineMinutes) && s.deadlineMinutes >= 1 && s.deadlineMinutes <= MAX_DEADLINE_MINUTES ? Math.round(s.deadlineMinutes) : DEFAULT_DEADLINE_MINUTES,
    maxHops: Number.isInteger(s.maxHops) && s.maxHops >= 1 && s.maxHops <= MAX_HOPS ? s.maxHops : MAX_HOPS,
    unlimitedApprovals: s.unlimitedApprovals === true,
  };
}

function load(): TradeSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    return sanitize(raw ? (JSON.parse(raw) as Partial<TradeSettings>) : null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings(): [TradeSettings, (next: TradeSettings) => void] {
  const [settings, setSettings] = useState<TradeSettings>(load);
  const update = useCallback((next: TradeSettings) => {
    const clean = sanitize(next);
    setSettings(clean);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(clean));
    } catch {
      /* session-only */
    }
  }, []);
  return [settings, update];
}
