// Injected-wallet discovery: EIP-6963 announcements (MetaMask, Rabby,
// Coinbase, Brave, …), plus a plain window.ethereum for wallets that predate
// 6963. Ferminux Wallet announces itself on the page too (see provider.ts) and
// is filtered out here: the picker lists it first, on its own.

import { FERMINUX_WALLET_RDNS, type Eip6963ProviderInfo } from './provider.ts';

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface InjectedWallet {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/** rdns given to a bare window.ethereum that never announced itself. */
export const LEGACY_RDNS = 'injected.window-ethereum';

/** Name a pre-6963 injected provider by the flags wallets set on it. */
export function legacyWalletName(eth: Record<string, unknown> | null | undefined): string {
  if (!eth) return 'Browser wallet';
  if (eth.isRabby) return 'Rabby';
  if (eth.isCoinbaseWallet) return 'Coinbase Wallet';
  if (eth.isTrust || eth.isTrustWallet) return 'Trust Wallet';
  if (eth.isBraveWallet) return 'Brave Wallet';
  if (eth.isOkxWallet || eth.isOKExWallet) return 'OKX Wallet';
  if (eth.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

function validInfo(info: unknown): info is Eip6963ProviderInfo {
  const i = info as Partial<Eip6963ProviderInfo> | null;
  return !!i && typeof i.uuid === 'string' && typeof i.name === 'string' && typeof i.icon === 'string' && typeof i.rdns === 'string';
}

/**
 * Collect injected wallets and report the list whenever it changes. Late
 * announcers (extensions that inject after first paint) are picked up for as
 * long as the returned stop function has not been called.
 */
export function watchInjectedWallets(onChange: (wallets: InjectedWallet[]) => void): () => void {
  const w = globalThis as unknown as Window & { ethereum?: Record<string, unknown> & Eip1193Provider };
  if (typeof w.addEventListener !== 'function') return () => {};
  const byRdns = new Map<string, InjectedWallet>();
  let legacy: InjectedWallet | null = null;

  const list = (): InjectedWallet[] => {
    const out = [...byRdns.values()];
    if (legacy && out.length === 0) out.push(legacy);
    return out;
  };
  const publish = () => onChange(list());

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent).detail as { info?: unknown; provider?: Eip1193Provider } | undefined;
    if (!detail || !validInfo(detail.info) || typeof detail.provider?.request !== 'function') return;
    if (detail.info.rdns === FERMINUX_WALLET_RDNS) return;
    const key = detail.info.rdns || detail.info.uuid;
    if (byRdns.has(key)) return;
    byRdns.set(key, { info: { ...detail.info }, provider: detail.provider });
    publish();
  };

  const checkLegacy = () => {
    const eth = w.ethereum;
    if (!eth || typeof eth.request !== 'function' || eth.isFerminuxWallet) return;
    if (legacy?.provider === eth) return;
    legacy = { info: { uuid: 'legacy', name: legacyWalletName(eth), icon: '', rdns: LEGACY_RDNS }, provider: eth };
    publish();
  };

  w.addEventListener('eip6963:announceProvider', onAnnounce);
  w.addEventListener('ethereum#initialized', checkLegacy);
  w.dispatchEvent(new Event('eip6963:requestProvider'));
  checkLegacy();
  // Extensions that neither announce nor fire ethereum#initialized: look again shortly.
  const started = Date.now();
  const timer = setInterval(() => {
    checkLegacy();
    if (Date.now() - started > 3000) clearInterval(timer);
  }, 250);
  publish();

  return () => {
    clearInterval(timer);
    w.removeEventListener('eip6963:announceProvider', onAnnounce);
    w.removeEventListener('ethereum#initialized', checkLegacy);
  };
}
