import { useEffect, useRef } from 'react';
import { createIdleTracker } from '../lib/idle.ts';

/** What counts as someone using the wallet. */
const ACTIVITY: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

/**
 * Call `onIdle` once `idleMs` pass without a tap, click or key press while
 * `active`. Besides a timer, the deadline is checked whenever the page comes
 * back (visible again, focused, resumed from a frozen state, restored from
 * the back/forward cache) and before any input is counted: see lib/idle.ts.
 * Inputs are seen in the capture phase, so an overdue lock lands before the
 * input reaches the wallet's own handlers.
 */
export function useIdleLock(active: boolean, idleMs: number, onIdle: () => void, events: (keyof WindowEventMap)[] = ACTIVITY): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const eventKey = events.join(',');

  useEffect(() => {
    if (!active) return;
    const tracker = createIdleTracker(idleMs, () => onIdleRef.current());
    const activity = () => tracker.activity();
    const check = () => tracker.check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') tracker.check();
    };
    const opts = { capture: true, passive: true } as const;
    const list = eventKey.split(',') as (keyof WindowEventMap)[];
    for (const ev of list) window.addEventListener(ev, activity, opts);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', onVisible);
    // Page Lifecycle (a frozen tab thawing) and Capacitor (the app returning from the background).
    document.addEventListener('resume', check);
    const timer = window.setInterval(check, Math.min(15_000, idleMs / 4));
    return () => {
      for (const ev of list) window.removeEventListener(ev, activity, opts);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('resume', check);
      window.clearInterval(timer);
    };
  }, [active, idleMs, eventKey]);
}
