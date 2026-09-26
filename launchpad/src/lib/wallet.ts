// ---------------------------------------------------------------------------
// EIP-1193 wallet helpers. Browser-only module. The provider comes from
// connector.ts (Ferminux Wallet, an injected wallet, or WalletConnect);
// window.ethereum stays the default for the one-click "Add Ferminux Network".
// ---------------------------------------------------------------------------

import { BrowserProvider } from "ethers";
import {
  FERMINUX_ADD_CHAIN_PARAMS,
  ensureFerminuxChain,
  type EnsureChainOptions,
} from "../../../shared/fxwallet/network.ts";

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
  return typeof window !== "undefined" ? window.ethereum : undefined;
}

export interface WalletState {
  provider: BrowserProvider;
  address: string;
  chainId: number;
}

/** Provider + address + chain for an authorised wallet (no prompt when the site is already approved). */
export async function connectWallet(eth: Eip1193Provider | undefined = injected()): Promise<WalletState> {
  if (!eth) throw new Error("No wallet connected.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("Wallet returned no accounts.");
  const provider = new BrowserProvider(eth as never);
  const network = await provider.getNetwork();
  return { provider, address: accounts[0], chainId: Number(network.chainId) };
}

/** One-click "Add Ferminux Network" via wallet_addEthereumChain. */
export async function addFerminuxNetwork(eth: Eip1193Provider | undefined = injected()): Promise<void> {
  if (!eth) throw new Error("No injected wallet found. Install MetaMask.");
  await eth.request({
    method: "wallet_addEthereumChain",
    params: [FERMINUX_ADD_CHAIN_PARAMS],
  });
}

/**
 * Put the wallet on chain 3961: switch, add the network when the wallet does
 * not know it, and over WalletConnect wait until the session carries it
 * (shared/fxwallet/network.ts). Throws a ChainSetupError whose message says
 * what to do, with the details to add the network by hand.
 */
export async function switchToFerminux(
  eth: Eip1193Provider | undefined = injected(),
  opts?: EnsureChainOptions,
): Promise<void> {
  if (!eth) throw new Error("No wallet connected.");
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
  const onAccounts = (...args: unknown[]) =>
    handlers.accountsChanged?.(args[0] as string[]);
  const onChain = (...args: unknown[]) =>
    handlers.chainChanged?.(args[0] as string);
  if (handlers.accountsChanged) eth.on("accountsChanged", onAccounts);
  if (handlers.chainChanged) eth.on("chainChanged", onChain);
  return () => {
    if (handlers.accountsChanged) eth.removeListener?.("accountsChanged", onAccounts);
    if (handlers.chainChanged) eth.removeListener?.("chainChanged", onChain);
  };
}
