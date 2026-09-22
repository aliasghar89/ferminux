// Poll the relayer's liveness report (see lib/liveness.ts and RELAYER_STATUS_URL).
//
// Any failure — network, non-2xx, bad JSON, wrong shape — yields `status: null`
// plus a short error, and the rest of the app renders exactly as it did before
// this report existed. A document older than STATUS_MAX_AGE_MS is discarded the
// same way: an out-of-date "all clear" is worse than no report.

import { useEffect, useState } from 'react';
import { RELAYER_STATUS_URL, STATUS_POLL_MS } from '../config.ts';
import { isStatusFresh, parseRelayerStatus, type RelayerStatus } from '../lib/liveness.ts';

export interface RelayerStatusState {
  status: RelayerStatus | null;
  /** Unix ms of the last successful read, or null. */
  fetchedAt: number | null;
  /** Why there is no usable report, for the small footer line. */
  error: string | null;
  /** False until the first attempt has completed either way. */
  settled: boolean;
}

export async function fetchRelayerStatus(url: string, timeoutMs = 6000): Promise<RelayerStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseRelayerStatus(await res.json());
    if (!parsed) throw new Error('unrecognised status document');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export function useRelayerStatus(url: string = RELAYER_STATUS_URL, pollMs: number = STATUS_POLL_MS): RelayerStatusState {
  const [state, setState] = useState<RelayerStatusState>({ status: null, fetchedAt: null, error: null, settled: false });

  useEffect(() => {
    if (!url) {
      setState({ status: null, fetchedAt: null, error: 'no status URL configured', settled: true });
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const status = await fetchRelayerStatus(url);
        if (!alive) return;
        const now = Date.now();
        if (!isStatusFresh(status, now)) {
          setState({ status: null, fetchedAt: now, error: 'liveness report is stale', settled: true });
        } else {
          setState({ status, fetchedAt: now, error: null, settled: true });
        }
      } catch (err) {
        if (!alive) return;
        setState((s) => ({
          status: null,
          fetchedAt: s.fetchedAt,
          error: err instanceof Error ? err.message : String(err),
          settled: true,
        }));
      }
      if (alive) timer = setTimeout(() => void tick(), pollMs);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [url, pollMs]);

  return state;
}
