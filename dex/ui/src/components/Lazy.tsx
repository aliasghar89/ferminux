// Code that loads on demand: every page but Swap, the pay-in card, the FMX
// price chart beside the swap card, the bridge panel and the phone hand-off QR.
// The first Swap screen downloads only what it draws; the rest arrives as each
// is first shown, and is fetched while the browser is idle after the first
// screen so switching pages does not wait on the network.
//
// A chunk that fails to load (offline, or a tab left open across a deploy that
// replaced the files) shows a notice with a reload, never a blank page.
import { Component, Suspense, lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { Notice, Skeleton, Spinner } from './ui.tsx';

type Loader<M> = () => Promise<M>;

/** A component exported as `name` from an on-demand module, typed as the component itself. */
export function lazyNamed<M, K extends keyof M>(load: Loader<M>, name: K): M[K] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return lazy(() => load().then((m) => ({ default: m[name] as unknown as ComponentType<any> }))) as unknown as M[K];
}

function once<M>(load: Loader<M>): Loader<M> {
  let p: Promise<M> | null = null;
  return () => {
    p ??= load().catch((err) => {
      p = null; // a failed fetch can be retried
      throw err;
    });
    return p;
  };
}

// The modules, each fetched at most once. Vite turns every import() into its own chunk.
export const loadPools = once(() => import('../views/PoolsView.tsx'));
export const loadLiquidity = once(() => import('../views/LiquidityView.tsx'));
export const loadCharts = once(() => import('../views/ChartsView.tsx'));
export const loadActivity = once(() => import('../views/ActivityView.tsx'));
export const loadBridge = once(() => import('../views/BridgePanel.tsx'));
export const loadPayCard = once(() => import('../views/PayCard.tsx'));
export const loadHandoff = once(() => import('./MobileHandoff.tsx'));

/** Fetch the pages and the pay-in card once the browser is idle, so a tab switch is instant. */
export function usePrefetchViews(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const run = () => {
      for (const load of [loadPools, loadCharts, loadLiquidity, loadActivity, loadPayCard]) load().catch(() => {});
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(run, { timeout: 5000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(run, 2500);
    return () => window.clearTimeout(id);
  }, [enabled]);
}

class ChunkBoundary extends Component<{ children: ReactNode; what: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Notice kind="warn" role="alert" title={`The ${this.props.what} could not be shown`}>
        This part of the page is downloaded when it is first shown. If the connection dropped, or the site was updated while this tab was
        open, reloading fixes it.{' '}
        <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </Notice>
    );
  }
}

/** A page body that loads on demand: a card-shaped placeholder while it downloads. */
export function LazyPage({ children, what }: { children: ReactNode; what: string }) {
  return (
    <ChunkBoundary what={what}>
      <Suspense
        fallback={
          <div className="page">
            <section className="card card-pad" aria-busy="true" data-testid="page-loading">
              <Spinner label={`Loading the ${what}`} /> <Skeleton width="40%" />
            </section>
          </div>
        }
      >
        {children}
      </Suspense>
    </ChunkBoundary>
  );
}

/** A part of a page that loads on demand, holding `height` px while it downloads so nothing below jumps. */
export function LazyPart({ children, what, height = 0 }: { children: ReactNode; what: string; height?: number }) {
  return (
    <ChunkBoundary what={what}>
      <Suspense fallback={height > 0 ? <section className="card" aria-busy="true" style={{ minHeight: height }} /> : null}>{children}</Suspense>
    </ChunkBoundary>
  );
}
