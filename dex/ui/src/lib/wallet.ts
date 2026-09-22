// ---------------------------------------------------------------------------
// Injected-wallet (EIP-1193) helpers. THE ONLY browser-only module in src/lib.
//
// Everything that touches contracts takes an ethers ContractRunner, so the
// signer can equally be a MetaMask account here or a plain Wallet in the e2e
// suite — the data layer cannot tell the difference, which is exactly why the
// e2e can exercise the production code paths.
// ---------------------------------------------------------------------------

import { BrowserProvider, type JsonRpcSigner } from 'ethers';
import { ADD_CHAIN_PARAMS, CHAIN_ID_HEX } from '../config.ts';

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

export interface WalletState {
  provider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  chainId: number;
}

export async function connectWallet(): Promise<WalletState> {
  const eth = injected();
  if (!eth) throw new Error('No browser wallet found. Install MetaMask, or open this page in a wallet browser.');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('The wallet returned no accounts.');
  const provider = new BrowserProvider(eth as never);
  const network = await provider.getNetwork();
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress(), chainId: Number(network.chainId) };
}

/** One-click "Add Ferminux Network" via wallet_addEthereumChain. */
export async function addFerminuxNetwork(): Promise<void> {
  const eth = injected();
  if (!eth) throw new Error('No browser wallet found.');
  await eth.request({ method: 'wallet_addEthereumChain', params: [ADD_CHAIN_PARAMS] });
}

/** Switch to chain 3961; if the wallet does not know it yet, add it first. */
export async function switchToFerminux(): Promise<void> {
  const eth = injected();
  if (!eth) throw new Error('No browser wallet found.');
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (err) {
    // 4902 = chain unknown to the wallet
    if ((err as { code?: number })?.code === 4902) {
      await addFerminuxNetwork();
      return;
    }
    throw err;
  }
}

export function onWalletEvents(handlers: {
  accountsChanged?: (accounts: string[]) => void;
  chainChanged?: (chainIdHex: string) => void;
}): () => void {
  const eth = injected();
  if (!eth?.on) return () => {};
  const onAccounts = (...args: unknown[]) => handlers.accountsChanged?.(args[0] as string[]);
  const onChain = (...args: unknown[]) => handlers.chainChanged?.(args[0] as string);
  if (handlers.accountsChanged) eth.on('accountsChanged', onAccounts);
  if (handlers.chainChanged) eth.on('chainChanged', onChain);
  return () => {
    if (handlers.accountsChanged) eth.removeListener?.('accountsChanged', onAccounts);
    if (handlers.chainChanged) eth.removeListener?.('chainChanged', onChain);
  };
}

/** Turn a thrown wallet/contract error into one line a human can act on. */
export function readableError(err: unknown): string {
  const e = err as { code?: number | string; shortMessage?: string; reason?: string; message?: string; info?: { error?: { message?: string } } };
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'You rejected the request in your wallet.';
  const reason = e?.reason ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message;
  if (!reason) return 'The transaction failed.';
  // Router/pair reverts arrive as "execution reverted: ROUTER: …" — keep the
  // contract's own words, they are written for exactly this purpose.
  const match = /(?:ROUTER|PAIR|LIB|LOCKER|TH|FACTORY|WFMX): [^"']+/.exec(reason);
  return match ? match[0] : reason.slice(0, 240);
}
