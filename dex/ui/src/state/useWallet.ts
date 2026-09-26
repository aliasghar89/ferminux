import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAIN_ID } from '../config.ts';
import type { WalletChoice, WalletKind } from '../../../../shared/fxwallet/connector.ts';
import { connector } from '../lib/connector.ts';
import { connectWallet, injected, readableError, switchToFerminux, type Eip1193Provider, type WalletState } from '../lib/wallet.ts';

export interface WalletSession {
  wallet: WalletState | null;
  address: string | null;
  /** Wallet is connected but pointed at another chain — signing is blocked. */
  wrongChain: boolean;
  /** An injected (extension / in-app browser) wallet exists; without one the chooser offers the phone hand-off. */
  hasInjected: boolean;
  connecting: boolean;
  /** What the wallet is being asked right now ("Approve adding Ferminux…"), or null. */
  status: string | null;
  error: string | null;
  /** Ferminux Wallet, then injected wallets, then WalletConnect when configured. */
  choices: WalletChoice[];
  /** Which kind of wallet is connected. */
  kind: WalletKind | null;
  /** The connected EIP-1193 provider (for chain switches outside the DEX's own chain). */
  eip1193: Eip1193Provider | null;
  chooserOpen: boolean;
  /** Open the wallet chooser. */
  connect: () => void;
  /** Connect with one choice — call it from the click, so the Ferminux Wallet window may open. */
  connectWith: (id: string) => void;
  closeChooser: () => void;
  switchChain: () => Promise<void>;
  disconnect: () => void;
}

/**
 * Wallet session. Read-only browsing never depends on this: the page works
 * with no wallet at all, and only the action buttons care.
 */
export function useWallet(): WalletSession {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<WalletChoice[]>(() => connector.choices());
  const [chooserOpen, setChooserOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Extensions announce themselves after first render (EIP-6963, or a late
  // window.ethereum); the connector keeps listening and re-publishes.
  const [hasInjected, setHasInjected] = useState(() => Boolean(injected()) || connector.choices().some((c) => c.kind === 'injected'));

  // An account switch and a chain switch can arrive back to back: each starts a rebuild, and only the newest
  // may land. An older one that resolves last would put back the previous account (and sign as it).
  const rebuildSeq = useRef(0);
  /** Signer + network for `provider`, set only if no newer rebuild started meanwhile. Throws the wallet's error. */
  const land = useCallback(async (provider: Eip1193Provider): Promise<void> => {
    const seq = ++rebuildSeq.current;
    const next = await connectWallet(provider);
    if (seq === rebuildSeq.current) setWallet(next);
  }, []);
  const rebuild = useCallback(async () => {
    const conn = connector.current();
    if (!conn) {
      ++rebuildSeq.current;
      setWallet(null);
      return;
    }
    const seq = rebuildSeq.current + 1;
    try {
      await land(conn.provider);
    } catch (err) {
      if (seq !== rebuildSeq.current) return;
      setWallet(null);
      setError(readableError(err));
    }
  }, [land]);

  // Choices, account and chain changes, disconnects — all come through the connector.
  useEffect(() => {
    const sync = () => {
      const list = connector.choices();
      setChoices(list);
      setHasInjected(Boolean(injected()) || list.some((c) => c.kind === 'injected'));
    };
    sync();
    let last = connector.current();
    const unsubscribe = connector.subscribe(() => {
      sync();
      const now = connector.current();
      if (now !== last) {
        last = now;
        void rebuild();
      }
    });
    // A wallet this site used before reconnects without a prompt.
    void connector.restore().then((conn) => {
      if (conn) {
        last = conn;
        void rebuild();
      }
    });
    return unsubscribe;
  }, [rebuild]);

  const connect = useCallback(() => {
    setError(null);
    setChooserOpen(true);
  }, []);

  const connectWith = useCallback(
    (id: string) => {
      setConnecting(true);
      setError(null);
      setStatus(null);
      // Synchronous call inside the click: this is what opens the wallet window.
      const pending = connector.connect(id);
      void pending
        .then(async (conn) => {
          await land(conn.provider);
          setChooserOpen(false);
          // A phone wallet over WalletConnect rarely knows Ferminux yet, and
          // there is no network menu on this page to fix that from: ask it
          // to switch (adding the network) straight away. A refusal leaves the
          // wallet connected, with the reason and the switch button.
          if (conn.choice.kind === 'walletconnect' && conn.chainId !== CHAIN_ID) {
            try {
              await switchToFerminux(conn.provider, {
                onStep: (step) =>
                  setStatus(step === 'add' ? 'Approve adding Ferminux in your wallet app.' : 'Approve switching to Ferminux in your wallet app.'),
              });
              await land(conn.provider);
            } catch (err) {
              setError(readableError(err));
            }
          }
        })
        .catch((err) => setError(readableError(err)))
        .finally(() => {
          setConnecting(false);
          setStatus(null);
        });
    },
    [land],
  );

  const switchChain = useCallback(async () => {
    setError(null);
    const conn = connector.current();
    try {
      await switchToFerminux(conn?.provider, {
        onStep: (step) => setStatus(step === 'add' ? 'Approve adding Ferminux in your wallet.' : 'Approve switching to Ferminux in your wallet.'),
      });
      await rebuild();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setStatus(null);
    }
  }, [rebuild]);

  const disconnect = useCallback(() => {
    void connector.disconnect();
    ++rebuildSeq.current; // a rebuild still in flight must not bring the wallet back
    setWallet(null);
    setError(null);
  }, []);

  const current = connector.current();
  return {
    wallet,
    address: wallet?.address ?? null,
    wrongChain: wallet !== null && wallet.chainId !== CHAIN_ID,
    hasInjected,
    connecting,
    status,
    error,
    choices,
    kind: wallet ? (current?.choice.kind ?? null) : null,
    eip1193: wallet ? (current?.provider ?? null) : null,
    chooserOpen,
    connect,
    connectWith,
    closeChooser: () => setChooserOpen(false),
    switchChain,
    disconnect,
  };
}
