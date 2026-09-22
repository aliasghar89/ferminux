import { useEffect, useState } from 'react';

/**
 * A ticking clock. The 24 h cap bucket drains continuously on chain, so the
 * remaining-capacity figure has to move between RPC polls or it lies.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
