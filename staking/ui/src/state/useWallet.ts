// Wallet session — honest ways to sign:
//   1. a connected wallet: Ferminux Wallet (web, no extension), an injected
//      EIP-1193 wallet, or WalletConnect when configured — switched/added to
//      chain 3961 (see lib/connector.ts), or
//   2. a session key imported from a private key or encrypted JSON keystore
//      (the file wallet-web exports), held in MEMORY ONLY — never stored.
// Reads always go through the app's own RPC provider; only signing differs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserProvider, type Provider, type Signer } from 'ethers';
import type { Eip1193Provider, WalletChoice, WalletKind } from '../../../../shared/fxwallet/connector.ts';
import { CHAIN_ID } from '../config.ts';
import { walletFromPrivateKey, walletFromKeystore, sessionSigner, type SessionKey } from '../lib/keys.ts';
import { connector } from '../lib/connector.ts';
import { ChainSetupError, ensureFerminuxChain } from '../../../../shared/fxwallet/network.ts';

export interface WalletState {
  address: string | null;
  /** 'session' = imported key; anything else = a connected wallet of that kind. */
  kind: WalletKind | 'session' | null;
  /** An injected wallet exists in this browser at all. */
  hasInjected: boolean;
  /** Ferminux Wallet, then injected wallets, then WalletConnect when configured. */
  choices: WalletChoice[];
  connecting: boolean;
  error: string | null;
  /** Connect with one choice; resolves true when connected. Call it from the click. */
  connectWith: (id: string) => Promise<boolean>;
  /** The first injected wallet (kept for callers of the old API). */
  connectInjected: () => Promise<void>;
  importPrivateKey: (pk: string) => void;
  importKeystore: (json: string, password: string, onProgress?: (f: number) => void) => Promise<void>;
  disconnect: () => void;
  /** Signer bound to chain 3961; throws when not connected. */
  getSigner: (readProvider: Provider) => Promise<Signer>;
}

/**
 * Put a connected wallet on chain 3961: switch, add the network when the
 * wallet does not know it, and over WalletConnect wait until the session
 * carries it (shared/fxwallet/network.ts).
 */
async function ensureFerminux(eth: Eip1193Provider): Promise<void> {
  await ensureFerminuxChain(eth);
}

function friendly(e: unknown): string {
  // Written for people already, with the details to add the network by hand.
  if (e instanceof ChainSetupError) return e.message;
  const err = e as { code?: number; message?: string };
  const msg = err?.message ?? String(e);
  if (err?.code === 4001 || /rejected/i.test(msg)) return 'Connection rejected in the wallet.';
  return `Could not connect: ${msg}`;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<WalletKind | 'session' | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<WalletChoice[]>(() => connector.choices());
  const sessionKey = useRef<SessionKey | null>(null);
  const hasInjected = choices.some((c) => c.kind === 'injected');

  // Follow the connected wallet: account switches, chain changes, disconnects.
  useEffect(() => {
    const sync = () => {
      setChoices(connector.choices());
      if (sessionKey.current) return; // a session key wins
      const conn = connector.current();
      setAddress(conn?.accounts[0] ?? null);
      setKind(conn?.choice.kind ?? null);
      if (conn && conn.chainId !== CHAIN_ID && conn.chainId !== 0) {
        setError(`Wallet switched to another chain — switch back to Ferminux (${CHAIN_ID}).`);
      } else {
        setError(null);
      }
    };
    const unsubscribe = connector.subscribe(sync);
    // A wallet this site used before reconnects without a prompt.
    void connector.restore().then(sync);
    return unsubscribe;
  }, []);

  const disconnect = useCallback(() => {
    sessionKey.current = null;
    void connector.disconnect();
    setAddress(null);
    setKind(null);
    setError(null);
  }, []);

  const connectWith = useCallback(async (id: string): Promise<boolean> => {
    setConnecting(true);
    setError(null);
    try {
      // First call is synchronous inside the click: it opens the wallet window.
      const conn = await connector.connect(id);
      await ensureFerminux(conn.provider);
      sessionKey.current = null;
      setAddress(conn.accounts[0] ?? null);
      setKind(conn.choice.kind);
      return true;
    } catch (e) {
      setError(friendly(e));
      return false;
    } finally {
      setConnecting(false);
    }
  }, []);

  const connectInjected = useCallback(async () => {
    const first = connector.choices().find((c) => c.kind === 'injected');
    if (!first) {
      setError('No injected wallet found in this browser.');
      return;
    }
    await connectWith(first.id);
  }, [connectWith]);

  const importPrivateKey = useCallback((pk: string) => {
    const key = walletFromPrivateKey(pk); // throws with a plain message on bad input
    sessionKey.current = key;
    setAddress(key.address);
    setKind('session');
    setError(null);
  }, []);

  const importKeystore = useCallback(async (json: string, password: string, onProgress?: (f: number) => void) => {
    const key = await walletFromKeystore(json, password, onProgress);
    sessionKey.current = key;
    setAddress(key.address);
    setKind('session');
    setError(null);
  }, []);

  const getSigner = useCallback(
    async (readProvider: Provider): Promise<Signer> => {
      if (kind === 'session' && sessionKey.current) return sessionSigner(sessionKey.current, readProvider);
      const conn = connector.current();
      if (kind && kind !== 'session' && conn) {
        const chainId = (await conn.provider.request({ method: 'eth_chainId' })) as string;
        if (BigInt(chainId) !== BigInt(CHAIN_ID)) {
          throw new Error(`Wallet is on another chain — switch to Ferminux (${CHAIN_ID}) and retry.`);
        }
        const browser = new BrowserProvider(conn.provider as never, CHAIN_ID);
        return browser.getSigner();
      }
      throw new Error('No wallet connected.');
    },
    [kind],
  );

  return {
    address,
    kind,
    hasInjected,
    choices,
    connecting,
    error,
    connectWith,
    connectInjected,
    importPrivateKey,
    importKeystore,
    disconnect,
    getSigner,
  };
}
