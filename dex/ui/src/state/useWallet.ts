import { useCallback, useEffect, useState } from 'react';
import { CHAIN_ID } from '../config.ts';
import { connectWallet, injected, onWalletEvents, readableError, switchToFerminux, type WalletState } from '../lib/wallet.ts';

export interface WalletSession {
  wallet: WalletState | null;
  address: string | null;
  /** Wallet is connected but pointed at another chain — signing is blocked. */
  wrongChain: boolean;
  hasInjected: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  disconnect: () => void;
}

/**
 * Injected-wallet session. Read-only browsing never depends on this: the page
 * works with no wallet at all, and only the action buttons care.
 */
export function useWallet(): WalletSession {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // MetaMask (and most extensions) set window.ethereum ASYNCHRONOUSLY — often
  // after React has already mounted. Reading it once at first render therefore
  // decides "no wallet" a fraction of a second too early and never recovers,
  // leaving the Connect button dead for a user who plainly has MetaMask
  // installed. Seed from the immediate value, then keep looking: extensions
  // announce themselves with `ethereum#initialized` (EIP-1193) and with an
  // `eip6963:announceProvider` event (EIP-6963, how modern MetaMask advertises
  // itself alongside other wallets), and we poll briefly as a last resort for
  // anything that does neither.
  const [hasInjected, setHasInjected] = useState(() => Boolean(injected()));

  useEffect(() => {
    if (hasInjected) return;
    let cancelled = false;
    const found = () => {
      if (!cancelled && injected()) setHasInjected(true);
    };

    window.addEventListener('ethereum#initialized', found, { once: true });
    window.addEventListener('eip6963:announceProvider', found);
    // ask any EIP-6963 wallet to announce itself right now
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Fallback poll: 3 seconds is far longer than any extension needs, and it
    // stops on its own so an idle page is not left with a live timer.
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (injected()) {
        found();
        window.clearInterval(timer);
      } else if (Date.now() - started > 3000) {
        window.clearInterval(timer);
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('ethereum#initialized', found);
      window.removeEventListener('eip6963:announceProvider', found);
    };
  }, [hasInjected]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      setWallet(await connectWallet());
    } catch (err) {
      setError(readableError(err));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      await switchToFerminux();
      setWallet(await connectWallet());
    } catch (err) {
      setError(readableError(err));
    }
  }, []);

  const disconnect = useCallback(() => {
    setWallet(null);
    setError(null);
  }, []);

  // A wallet can change account or chain under the app at any moment; both
  // invalidate the signer, so re-read rather than keep a stale one.
  useEffect(() => {
    if (!wallet) return;
    return onWalletEvents({
      accountsChanged: (accounts) => {
        if (!accounts?.length) setWallet(null);
        else void connect();
      },
      chainChanged: () => {
        void connect();
      },
    });
  }, [wallet, connect]);

  return {
    wallet,
    address: wallet?.address ?? null,
    wrongChain: wallet !== null && wallet.chainId !== CHAIN_ID,
    hasInjected,
    connecting,
    error,
    connect,
    switchChain,
    disconnect,
  };
}
