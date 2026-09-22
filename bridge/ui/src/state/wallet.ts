// Injected-wallet (EIP-1193) connection and network switching.
//
// BROWSER-ONLY on purpose: everything that touches window lives here, so the
// whole src/lib layer stays importable under plain Node for the test suites.

import { BrowserProvider, getAddress } from 'ethers';
import { useCallback, useEffect, useRef, useState } from 'react';
import { addChainParams, chainById, type ChainConfig } from '../config.ts';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function injected(): Eip1193Provider | undefined {
  return typeof window !== 'undefined' ? window.ethereum : undefined;
}

export type WalletStatus = 'unavailable' | 'disconnected' | 'connecting' | 'connected';

export interface WalletState {
  status: WalletStatus;
  address: string | null;
  chainId: number | null;
  chain: ChainConfig | undefined;
  provider: BrowserProvider | null;
  error: string | null;
  connect: () => Promise<void>;
  switchTo: (chain: ChainConfig) => Promise<void>;
  clearError: () => void;
}

/** Turn a wallet's rejection into something a human can act on. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { code?: number | string; message?: string; shortMessage?: string };
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'Request rejected in your wallet.';
  if (e?.code === -32002) return 'Your wallet already has a pending request — open it and respond.';
  const raw = e?.shortMessage || e?.message || 'Wallet request failed.';
  const cut = raw.split(/\s*\(action=|\s*\[ See:/)[0];
  return cut.length > 200 ? `${cut.slice(0, 200)}…` : cut;
}

/**
 * Switch the wallet to `chain`; if the wallet does not know the chain yet
 * (error 4902), add it first with the public RPC and explorer from the config.
 */
export async function switchNetwork(chain: ChainConfig): Promise<void> {
  const eth = injected();
  if (!eth) throw new Error('No injected wallet found.');
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
  } catch (err) {
    const code = (err as { code?: number; data?: { originalError?: { code?: number } } })?.code;
    const nested = (err as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
    if (code === 4902 || nested === 4902) {
      await eth.request({ method: 'wallet_addEthereumChain', params: [addChainParams(chain)] });
      // Some wallets add without switching; ask again, ignoring a second refusal.
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
      } catch {
        /* the add dialog already put the user on the chain, or they declined */
      }
      return;
    }
    throw err;
  }
}

export function useWallet(): WalletState {
  const [status, setStatus] = useState<WalletStatus>(() => (injected() ? 'disconnected' : 'unavailable'));
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerRef = useRef<BrowserProvider | null>(null);
  const [providerEpoch, setProviderEpoch] = useState(0);

  // A fresh BrowserProvider per chain change: ethers pins the network on the
  // first call, and a stale one would sign against the previous chain id.
  const provider = (() => {
    const eth = injected();
    if (!eth || status !== 'connected') return null;
    if (!providerRef.current) providerRef.current = new BrowserProvider(eth as never);
    return providerRef.current;
  })();
  void providerEpoch;

  const readChain = useCallback(async () => {
    const eth = injected();
    if (!eth) return;
    try {
      const hex = (await eth.request({ method: 'eth_chainId' })) as string;
      setChainId(Number(BigInt(hex)));
    } catch {
      setChainId(null);
    }
  }, []);

  // Restore an already-authorized connection without prompting.
  useEffect(() => {
    const eth = injected();
    if (!eth) return;
    let alive = true;
    void (async () => {
      try {
        const accounts = (await eth.request({ method: 'eth_accounts' })) as string[];
        if (!alive || !accounts?.length) return;
        setAddress(getAddress(accounts[0]));
        setStatus('connected');
        await readChain();
      } catch {
        /* wallet locked or refused — stay disconnected, no error shown */
      }
    })();
    return () => {
      alive = false;
    };
  }, [readChain]);

  // Account / chain change listeners.
  useEffect(() => {
    const eth = injected();
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (!accounts?.length) {
        setAddress(null);
        setStatus('disconnected');
        providerRef.current = null;
        return;
      }
      setAddress(getAddress(accounts[0]));
      setStatus('connected');
    };
    const onChain = (...args: unknown[]) => {
      const hex = args[0] as string;
      setChainId(Number(BigInt(hex)));
      providerRef.current = null; // force a new provider bound to the new chain
      setProviderEpoch((n) => n + 1);
    };
    eth.on('accountsChanged', onAccounts);
    eth.on('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const eth = injected();
    if (!eth) {
      setStatus('unavailable');
      setError('No injected wallet found. Install a browser wallet, then reload this page.');
      return;
    }
    setStatus('connecting');
    setError(null);
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      if (!accounts?.length) throw new Error('Your wallet returned no accounts.');
      setAddress(getAddress(accounts[0]));
      setStatus('connected');
      await readChain();
    } catch (err) {
      setStatus('disconnected');
      setError(walletErrorMessage(err));
    }
  }, [readChain]);

  const switchTo = useCallback(
    async (chain: ChainConfig) => {
      setError(null);
      try {
        await switchNetwork(chain);
        await readChain();
      } catch (err) {
        setError(walletErrorMessage(err));
      }
    },
    [readChain],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    address,
    chainId,
    chain: chainId === null ? undefined : chainById(chainId),
    provider,
    error,
    connect,
    switchTo,
    clearError,
  };
}
