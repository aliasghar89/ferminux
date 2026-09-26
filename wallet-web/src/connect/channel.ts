// The connect window's side of the postMessage channel.
//
// The window learns which origin opened it from its URL hash — a claim, not a
// fact. It says READY to window.opener with that claim as targetOrigin, which
// the browser silently drops unless the opener really is that origin. After
// that, every request must come from window.opener AND carry event.origin ===
// the claimed origin; anything else is ignored before it is parsed. Answers go
// back to the requesting window with its exact origin as targetOrigin.

import { useCallback, useEffect, useRef, useState } from 'react';
import { PROTOCOL, parseDappMessage } from '../../../shared/fxwallet/protocol.ts';
import { ERR, toRpcError } from '../../../shared/fxwallet/errors.ts';
import { normalizeOrigin } from './sites.ts';

export interface IncomingRequest {
  id: string;
  /** Verified: the event.origin of the message, equal to the claimed origin. */
  origin: string;
  method: string;
  params: unknown;
  chainId: number;
  appName: string;
  source: MessageEventSource;
}

/** Read the claimed origin and app name from `#origin=…&app=…`. */
export function readHash(hash: string): { origin: string | null; app: string } {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  return { origin: normalizeOrigin(q.get('origin')), app: (q.get('app') ?? '').slice(0, 60) };
}

export interface OpenerChannel {
  /** The opener's origin as claimed by the URL; trusted only once a request arrives from it. */
  claimed: string | null;
  app: string;
  /** Opened by a dApp (window.opener present and an origin claimed). */
  hasOpener: boolean;
  /** The dApp tab went away: nothing left to answer to. */
  openerGone: boolean;
  queue: IncomingRequest[];
  /** How many requests this window has answered. */
  answered: number;
  resolve: (req: IncomingRequest, result: unknown) => void;
  reject: (req: IncomingRequest, error: unknown) => void;
  /** Tell the dApp this window is closing on its own, then close it. */
  close: () => void;
  /**
   * Continue at the wallet's other origin (no vault here): navigate this very
   * window there with the same hash. What it holds is NOT rejected on the way
   * out: the dApp re-sends it when the other origin says ready.
   */
  handOff: (url: string) => void;
}

export function useOpenerChannel(): OpenerChannel {
  const [{ origin: claimed, app }] = useState(() => readHash(window.location.hash));
  const [hasOpener] = useState(() => claimed !== null && window.opener !== null && window.opener !== window);
  const [queue, setQueue] = useState<IncomingRequest[]>([]);
  const [answered, setAnswered] = useState(0);
  const [openerGone, setOpenerGone] = useState(false);
  const seen = useRef(new Set<string>());
  const handingOff = useRef(false);
  const queueRef = useRef<IncomingRequest[]>([]);
  queueRef.current = queue;

  useEffect(() => {
    if (!hasOpener || !claimed) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.opener || event.origin !== claimed) return;
      const msg = parseDappMessage(event.data);
      if (!msg || msg.type !== 'request') return;
      const source = event.source as Window;
      source.postMessage({ protocol: PROTOCOL, type: 'ack', id: msg.id }, event.origin);
      if (seen.current.has(msg.id)) return; // re-sent after a reload of the dApp side
      seen.current.add(msg.id);
      setQueue((q) => [
        ...q,
        { id: msg.id, origin: event.origin, method: msg.method, params: msg.params, chainId: msg.chainId, appName: msg.appName, source },
      ]);
    };
    window.addEventListener('message', onMessage);
    // The browser drops this unless the opener's real origin is `claimed`.
    window.opener.postMessage({ protocol: PROTOCOL, type: 'ready' }, claimed);
    const watch = window.setInterval(() => {
      if (!window.opener || window.opener.closed) setOpenerGone(true);
    }, 1000);
    // Closing the window (or navigating it away) is a rejection of whatever it still holds.
    const onHide = () => {
      if (handingOff.current) return;
      for (const req of queueRef.current) {
        try {
          req.source.postMessage(
            { protocol: PROTOCOL, type: 'response', id: req.id, error: { code: ERR.USER_REJECTED, message: 'You closed Ferminux Wallet before approving. Nothing was signed.' } },
            { targetOrigin: req.origin },
          );
        } catch {
          /* opener gone */
        }
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onHide);
      window.clearInterval(watch);
    };
  }, [hasOpener, claimed]);

  const answer = useCallback((req: IncomingRequest, payload: { result?: unknown; error?: unknown }) => {
    const message: Record<string, unknown> = { protocol: PROTOCOL, type: 'response', id: req.id };
    if ('error' in payload) message.error = toRpcError(payload.error);
    else message.result = payload.result === undefined ? null : payload.result;
    try {
      req.source.postMessage(message, { targetOrigin: req.origin });
    } catch {
      /* the dApp tab is gone; nothing to tell */
    }
    setQueue((q) => q.filter((r) => r.id !== req.id));
    setAnswered((n) => n + 1);
  }, []);

  const resolve = useCallback((req: IncomingRequest, result: unknown) => answer(req, { result }), [answer]);
  const reject = useCallback((req: IncomingRequest, error: unknown) => answer(req, { error }), [answer]);

  const close = useCallback(() => {
    if (claimed && window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({ protocol: PROTOCOL, type: 'closing' }, claimed);
      } catch {
        /* ignore */
      }
    }
    window.close();
  }, [claimed]);

  const handOff = useCallback((url: string) => {
    handingOff.current = true;
    window.location.replace(url);
  }, []);

  return { claimed, app, hasOpener, openerGone, queue, answered, resolve, reject, close, handOff };
}
