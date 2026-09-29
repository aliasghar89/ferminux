// ---------------------------------------------------------------------------
// EIP-1193 wallet helpers. Browser-only module. The provider comes from
// connector.ts (Ferminux Wallet, an injected wallet, or WalletConnect);
// window.ethereum stays the default for the one-click "Add Ferminux Network".
// ---------------------------------------------------------------------------

import { BrowserProvider, type JsonRpcSigner } from "ethers";
import { CHAIN_ID } from "../config.ts";
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

/**
 * The signer, but only while the wallet is on chain 3961 right now.
 *
 * `wrongChain` is the page's view of the wallet, and a chain switch reaches it
 * asynchronously (the rebuild after chainChanged lands some time later).
 * eth_sendTransaction carries no chain id, so a wallet that moved to another
 * network would sign the launch there and send the fee to whatever lives at
 * the factory address on that chain. The launch asks the wallet first, as
 * every DEX transaction does (dex/ui/src/lib/wallet.ts).
 */
export async function ferminuxSigner(state: WalletState): Promise<JsonRpcSigner> {
  let chainId: number;
  try {
    chainId = Number(BigInt((await state.provider.send("eth_chainId", [])) as string));
  } catch {
    throw new Error("Could not read which network your wallet is on. Try again.");
  }
  if (chainId !== CHAIN_ID) {
    throw new Error(
      `Your wallet is on chain ${chainId}, not Ferminux (${CHAIN_ID}). Switch to Ferminux, then try again.`,
    );
  }
  return state.provider.getSigner();
}

/** One-click "Add Ferminux Network" via wallet_addEthereumChain. */
export async function addFerminuxNetwork(eth: Eip1193Provider | undefined = injected()): Promise<void> {
  if (!eth) throw new Error("No browser wallet found in this browser.");
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
