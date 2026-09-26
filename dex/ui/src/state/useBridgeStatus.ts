// Poll the bridge relayer's liveness report for the Bridge panel.
//
// Uses the bridge app's parser and freshness rule (@bridge/lib/liveness.ts) so
// both apps read the document the same way. The bridge app's own hook is not
// reused because its module imports the bridge app's config, which would pull
// that app's six-chain host list into this bundle (see vite.config.ts).
//
// Every failure (network, CORS, non-2xx, bad JSON, wrong shape, stale) yields
// `status: null` with a short error. The panel treats that as "cannot confirm"
// and offers no send.
import { useEffect, useState } from 'react';
import { isStatusFresh, parseRelayerStatus, type RelayerStatus } from '@bridge/lib/liveness.ts';

export interface BridgeStatusState {
  status: RelayerStatus | null;
  error: string | null;
  /** False until the first attempt has finished either way. */
  settled: boolean;
}

const POLL_MS = 15_000;
const TIMEOUT_MS = 6_000;

export function useBridgeStatus(url: string, enabled: boolean): BridgeStatusState {
  const [state, setState] = useState<BridgeStatusState>({ status: null, error: null, settled: false });

  useEffect(() => {
    if (!enabled) return;
    if (!url) {
      setState({ status: null, error: 'no status URL configured', settled: true });
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`status report HTTP ${res.status}`);
        const parsed = parseRelayerStatus(await res.json());
        if (!parsed) throw new Error('unrecognised status report');
        if (!alive) return;
        setState(
          isStatusFresh(parsed, Date.now())
            ? { status: parsed, error: null, settled: true }
            : { status: null, error: 'the status report is stale', settled: true },
        );
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({
          status: null,
          error: /abort/i.test(msg) ? 'status report timed out' : `status report unavailable: ${msg}`,
          settled: true,
        });
      } finally {
        clearTimeout(abort);
      }
      if (alive) timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [url, enabled]);

  return state;
}
