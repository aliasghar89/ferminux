// ---------------------------------------------------------------------------
// The wallet side of paying on another network: put the wallet on that
// network, check it is still there (and still the paying account) right before
// sending, send the quote's one transfer, and nothing else.
//
// This is shared/fxwallet/network.ts's ensureFerminuxChain generalised to any
// of the seven paying networks (that one only ever targets 3961), and the
// DEX's ferminuxSigner guard (lib/wallet.ts) generalised to the paying chain:
// eth_sendTransaction carries no chain id, so a wallet that moved to another
// network between the switch and the send would sign the transfer there, to a
// contract address that means something else, or nothing, on that chain.
//
// Pure: the EIP-1193 provider is passed in; tests drive it with a script.
// ---------------------------------------------------------------------------

import { isPendingRequest, isUserRejection, sessionHasChain } from '../../../../shared/fxwallet/network.ts';
import { parseChainId } from '../../../../shared/fxwallet/chains.ts';
import { buildPayTx, isTxHash, payChain, sameAddress, type PayChain, type PayQuote, type PayTx } from './payin.ts';

export interface PayProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export class PayWalletError extends Error {
  /** Nothing can have been sent: the wallet refused, or a check stopped before it was asked. */
  readonly notSent: boolean;
  constructor(message: string, notSent: boolean) {
    super(message);
    this.name = 'PayWalletError';
    this.notSent = notSent;
  }
}

export async function readWalletChain(provider: PayProvider): Promise<number | null> {
  try {
    return parseChainId(await provider.request({ method: 'eth_chainId' }));
  } catch {
    return null;
  }
}

async function readAccount(provider: PayProvider): Promise<string | null> {
  try {
    const accounts = (await provider.request({ method: 'eth_accounts' })) as unknown;
    return Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean, ms: number, every = 250): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= until) return false;
    await sleep(every);
  }
}

/** EIP-3085 parameters for a paying network: its public endpoint and explorer. */
export function addChainParams(c: PayChain) {
  return {
    chainId: c.chainIdHex,
    chainName: c.name,
    nativeCurrency: { name: c.native.name, symbol: c.native.symbol, decimals: c.native.decimals },
    rpcUrls: c.rpcUrls.slice(0, 1),
    blockExplorerUrls: [c.explorer],
  };
}

export interface EnsurePayChainOptions {
  onStep?: (step: 'switch' | 'add') => void;
  /** How long to wait for the wallet to report the chain after it accepted (ms). */
  settleMs?: number;
}

/**
 * Put the wallet on `c`: switch; when the wallet does not know the network,
 * add it and switch; then wait until the wallet (and a WalletConnect session)
 * reports it. Throws a PayWalletError the page can show as it is.
 */
export async function ensurePayChain(provider: PayProvider, c: PayChain, opts: EnsurePayChainOptions = {}): Promise<void> {
  const settleMs = opts.settleMs ?? 8000;
  const onChain = async () => (await readWalletChain(provider)) === c.chainId;
  const inSession = () => sessionHasChain(provider, c.chainId);
  const refused = () => new PayWalletError(`Your wallet was not switched to ${c.name}, so nothing was sent.`, true);
  const pending = () => new PayWalletError('Your wallet is already showing a request. Open it, approve or dismiss that request, then try again.', true);

  if ((await onChain()) && inSession()) return;

  let switched = false;
  try {
    opts.onStep?.('switch');
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.chainIdHex }] });
    switched = true;
  } catch (e) {
    if (isUserRejection(e)) throw refused();
    if (isPendingRequest(e)) throw pending();
    // 4902 and its cousins: the wallet does not know the network yet.
  }
  if (!switched) {
    try {
      opts.onStep?.('add');
      await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(c)] });
    } catch (e) {
      if (isUserRejection(e)) throw refused();
      if (isPendingRequest(e)) throw pending();
      throw new PayWalletError(`Your wallet could not add ${c.name} from this page. Add it in the wallet, switch to it, then try again.`, true);
    }
    if (!(await waitFor(onChain, Math.min(2500, settleMs)))) {
      try {
        opts.onStep?.('switch');
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.chainIdHex }] });
      } catch (e) {
        if (isUserRejection(e)) throw refused();
        if (isPendingRequest(e)) throw pending();
      }
    }
  }
  if (!(await waitFor(onChain, settleMs))) {
    throw new PayWalletError(`Your wallet has not switched to ${c.name}. Switch to it in the wallet and try again.`, true);
  }
  if (!(await waitFor(inSession, settleMs))) {
    throw new PayWalletError(`Your wallet switched to ${c.name} but did not share it with this page. Disconnect, connect again, and approve ${c.name} when asked.`, true);
  }
}

/**
 * The last check before the wallet is asked to send: it must be on the
 * quote's network right now, and on the account the quote names as payer
 * (the pay-in matches the deposit to the quote only from that sender).
 */
export async function assertReadyToPay(provider: PayProvider, q: Pick<PayQuote, 'chain' | 'from'>): Promise<void> {
  const c = payChain(q.chain);
  if (!c) throw new PayWalletError('That network is not offered.', true);
  const chainId = await readWalletChain(provider);
  if (chainId === null) throw new PayWalletError('Could not read which network your wallet is on. Nothing was sent; try again.', true);
  if (chainId !== c.chainId) {
    throw new PayWalletError(`Your wallet is on chain ${chainId}, not ${c.name} (${c.chainId}). Nothing was sent; switch to ${c.name} and try again.`, true);
  }
  if (!sessionHasChain(provider, c.chainId)) throw new PayWalletError(`Your wallet has not shared ${c.name} with this page. Nothing was sent.`, true);
  const account = await readAccount(provider);
  if (!account || !sameAddress(account, q.from)) {
    throw new PayWalletError(
      `This quote is for payment from ${q.from}, and your wallet is now on ${account ?? 'no account'}. Nothing was sent: switch back to that account, or get a new quote.`,
      true,
    );
  }
}

/**
 * Send the quote's transfer and return its hash. The transaction is exactly
 * buildPayTx(quote): no gas fields, so the wallet prices the fee on that
 * network itself.
 */
export async function sendPayment(provider: PayProvider, q: PayQuote): Promise<{ hash: string; tx: PayTx }> {
  const tx = buildPayTx(q);
  await assertReadyToPay(provider, q);
  let hash: unknown;
  try {
    hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
  } catch (e) {
    if (isUserRejection(e)) throw new PayWalletError('You rejected the transfer in your wallet. Nothing was sent.', true);
    throw e;
  }
  if (!isTxHash(hash)) throw new PayWalletError('Your wallet did not return a transaction hash. Check its activity before trying again.', false);
  return { hash, tx };
}
