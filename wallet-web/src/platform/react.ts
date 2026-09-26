// React hooks over the platform bridge (./index.ts). Every hook is inert on
// the web build, so views call them unconditionally.

import { useEffect, useRef, useState } from 'react';
import {
  biometric,
  isNativeApp,
  onBackButton,
  onDeepLink,
  setSecureScreen,
  type BiometricStatus,
  type DeepLink,
} from './index.ts';
import type { WalletConnectApi } from '../state/useWalletConnect.ts';

/** Keep screenshots / recents / screen recording off this screen while `active`. */
export function useSecureScreen(active = true): void {
  useEffect(() => {
    if (!active) return;
    void setSecureScreen(true);
    return () => {
      void setSecureScreen(false);
    };
  }, [active]);
}

/**
 * Handle the Android back button while `active`; return true to consume it.
 * The newest handler runs first, so a nested screen's handler wins.
 */
export function useBackButton(handler: () => boolean | void, active = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return onBackButton(() => ref.current());
  }, [active]);
}

/** Receive deep links (the launch link is replayed to the first subscriber). */
export function useDeepLinks(handler: (link: DeepLink) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onDeepLink((l) => ref.current(l)), []);
}

export interface BiometricState {
  /** null until the device has been asked. */
  status: BiometricStatus | null;
  enabled: boolean;
  refresh: () => void;
}

export function useBiometric(): BiometricState {
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const [enabled, setEnabled] = useState(() => biometric.isEnabled());
  const [tick, setTick] = useState(0);
  useEffect(() => biometric.onChange(setEnabled), []);
  useEffect(() => {
    if (!isNativeApp()) return;
    let alive = true;
    void biometric.status().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [tick]);
  return { status, enabled, refresh: () => setTick((t) => t + 1) };
}

/**
 * WalletConnect links (wc:…, ferminuxwallet://wc?uri=…, https://wallet.ferminux.net/wc?uri=…)
 * pair with the site; the proposal then shows like one from a pasted code.
 * While locked, the proposal waits and appears after unlocking (WcController).
 * `onNotice` gets a line the UI can show when a link cannot be used.
 */
export function useWalletConnectLinks(wc: WalletConnectApi, onNotice: (text: string) => void): void {
  const wcRef = useRef(wc);
  wcRef.current = wc;
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  useDeepLinks((link) => {
    const api = wcRef.current;
    if (link.kind === 'open') return;
    if (!api.configured) {
      noticeRef.current('WalletConnect isn’t set up on this build, so the site’s link can’t be used here.');
      return;
    }
    void (async () => {
      const c = await api.start();
      if (!c) {
        noticeRef.current(api.error ?? 'WalletConnect could not start. Check the connection and try the link again.');
        return;
      }
      if (link.kind !== 'wc-pair') return; // a request link: the request arrives over the relay by itself
      try {
        await c.pair(link.uri);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The same code opened twice (a dApp retrying its link): the first pairing is already on its way.
        if (/already exists|pairing.*exist/i.test(msg)) return;
        noticeRef.current(`The site’s WalletConnect link could not be used: ${msg}`);
      }
    })();
  });
}
