// The idle auto-lock's rule, without React or browser globals (the Node tests
// drive it with a fake clock; state/useIdleLock.ts wires it to the page).
//
// The deadline is judged BEFORE an input counts as activity. A tab or the app
// frozen in the background runs no timers, so the check that should have
// locked it hours ago has not run yet when it comes back: if the first touch
// were simply recorded as activity, it would cancel that overdue lock and
// hand whoever holds the device a fresh idle period with every key loaded.

export interface IdleTracker {
  /** A tap, click, key press: renews the deadline only if it has not passed. */
  activity(): void;
  /** A timer tick, or the page coming back (visible, focused, resumed). */
  check(): void;
}

export function createIdleTracker(idleMs: number, onIdle: () => void, now: () => number = Date.now): IdleTracker {
  let last = now();
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onIdle();
  };
  const expired = () => now() - last >= idleMs;
  return {
    activity() {
      if (fired) return;
      if (expired()) fire();
      else last = now();
    },
    check() {
      if (!fired && expired()) fire();
    },
  };
}
