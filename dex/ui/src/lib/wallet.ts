// ---------------------------------------------------------------------------
// EIP-1193 wallet helpers. Browser-only (with connector.ts, which picks the
// provider: Ferminux Wallet, an injected wallet, or WalletConnect).
//
// Everything that touches contracts takes an ethers ContractRunner, so the
// signer can equally be a MetaMask account here or a plain Wallet in the e2e
// suite — the data layer cannot tell the difference, which is exactly why the
// e2e can exercise the production code paths.
// ---------------------------------------------------------------------------

import { BrowserProvider, type JsonRpcSigner } from 'ethers';
import {
  ChainSetupError,
  FERMINUX_ADD_CHAIN_PARAMS,
  ensureFerminuxChain,
  type EnsureChainOptions,
} from '../../../../shared/fxwallet/network.ts';

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

/**
 * Signer + network for an already-authorised provider. eth_requestAccounts is
 * answered without a prompt by a wallet that approved this site, so this is
 * also how the state is rebuilt after an account or chain change.
 */
export async function connectWallet(eth: Eip1193Provider | undefined = injected()): Promise<WalletState> {
  if (!eth) throw new Error('No wallet connected.');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('The wallet returned no accounts.');
  const provider = new BrowserProvider(eth as never);
  const network = await provider.getNetwork();
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress(), chainId: Number(network.chainId) };
}

/** One-click "Add Ferminux Network" via wallet_addEthereumChain. */
export async function addFerminuxNetwork(eth: Eip1193Provider | undefined = injected()): Promise<void> {
  if (!eth) throw new Error('No wallet connected.');
  await eth.request({ method: 'wallet_addEthereumChain', params: [FERMINUX_ADD_CHAIN_PARAMS] });
}

/**
 * Put the wallet on chain 3961: switch, add the network when the wallet does
 * not know it, and over WalletConnect wait until the session carries it
 * (shared/fxwallet/network.ts). Throws a ChainSetupError with a message that
 * says what to do, including the details to add the network by hand.
 */
export async function switchToFerminux(eth: Eip1193Provider | undefined = injected(), opts?: EnsureChainOptions): Promise<void> {
  if (!eth) throw new Error('No wallet connected.');
  await ensureFerminuxChain(eth, opts);
}

export function onWalletEvents(
  handlers: {
    accountsChanged?: (accounts: string[]) => void;
    chainChanged?: (chainIdHex: string) => void;
  },
  eth: Eip1193Provider | undefined = injected(),
): () => void {
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
  // Written for people already, and carries the network details: never cut.
  if (err instanceof ChainSetupError) return err.message;
  const e = err as { code?: number | string; shortMessage?: string; reason?: string; message?: string; info?: { error?: { message?: string } } };
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'You rejected the request in your wallet.';
  if (e?.code === 4100) return 'The wallet no longer lets this site use that account. Connect again.';
  const reason = e?.reason ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message;
  if (!reason) return 'The transaction failed.';
  // Router/pair reverts arrive as "execution reverted: ROUTER: …" — keep the
  // contract's own words, they are written for exactly this purpose.
  const match = /(?:ROUTER|PAIR|LIB|LOCKER|TH|FACTORY|WFMX): [^"']+/.exec(reason);
  return match ? match[0] : reason.slice(0, 240);
}
