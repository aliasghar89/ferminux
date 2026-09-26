// connect.html inside an iframe: an invisible status responder, never UI (a
// framed wallet screen could be overlaid and clickjacked).
//
// A dApp that remembered a connection embeds this frame and asks "does the
// wallet still approve me?". The answer is only authoritative when the frame
// can see the wallet's real storage, i.e. when the dApp is on the wallet's own
// site (every *.ferminux.net app): browsers give a cross-site frame a
// partitioned, empty localStorage, and "empty" must not read as "revoked".
// While the frame lives, a revoke in any wallet tab reaches it as a storage
// event and is pushed to the dApp at once.

import { PROTOCOL, parseDappMessage, type StatusMessage } from '../../../shared/fxwallet/protocol.ts';
import { approvedAccounts, findSite, isSameSite, loadSites, normalizeOrigin, onSitesChange, saveSites, withoutSite } from './sites.ts';

/**
 * The vault's storage key, restated so the frame does not pull in the vault
 * module (and its crypto). tests/connect.test.mjs fails if it drifts from
 * VAULT_KEY in src/lib/vault.ts.
 */
export const FRAME_VAULT_KEY = 'ferminux.wallet.vault.v2';

/**
 * Addresses in the stored vault: public metadata. (The connect window itself
 * goes through loadVault(), which also upgrades a v1 install, before any site
 * can have been approved.)
 */
function vaultAddresses(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(FRAME_VAULT_KEY) ?? 'null') as { accounts?: { address?: unknown }[] } | null;
    return (v?.accounts ?? []).map((a) => a?.address).filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a));
  } catch {
    return [];
  }
}

async function sharesWalletStorage(parentOrigin: string): Promise<boolean> {
  if (!isSameSite(parentOrigin, window.location.origin)) return false;
  const d = document as Document & { hasStorageAccess?: () => Promise<boolean> };
  if (typeof d.hasStorageAccess !== 'function') return true;
  try {
    return await d.hasStorageAccess();
  } catch {
    return false;
  }
}

export function runStatusFrame(): void {
  let parentOrigin: string | null = null;
  let authoritative = false;
  // Every message waits on the one storage-access check, so a "forget" that
  // arrives right behind the first "status" is not judged before it resolves.
  let checked: Promise<void> | null = null;

  const status = (): StatusMessage => {
    if (!parentOrigin || !authoritative) return { protocol: PROTOCOL, type: 'status', authoritative: false, approved: false, accounts: [] };
    const accounts = approvedAccounts(findSite(loadSites(), parentOrigin), vaultAddresses());
    return { protocol: PROTOCOL, type: 'status', authoritative: true, approved: accounts.length > 0, accounts };
  };
  const post = () => {
    if (parentOrigin) window.parent.postMessage(status(), parentOrigin);
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const origin = normalizeOrigin(event.origin);
    if (!origin) return;
    // One frame answers one parent: a later message from another origin is ignored.
    if (parentOrigin !== null && origin !== parentOrigin) return;
    const msg = parseDappMessage(event.data);
    if (!msg || msg.type === 'request') return;
    if (parentOrigin === null) {
      parentOrigin = origin;
      checked = sharesWalletStorage(origin).then((yes) => {
        authoritative = yes;
      });
    }
    void (async () => {
      await checked;
      // "Disconnect" in the dApp removes only that dApp's own approval.
      if (msg.type === 'forget' && authoritative) saveSites(withoutSite(loadSites(), origin));
      post();
    })();
  });
  onSitesChange(post);
  // This module loads after the frame's `load` event may already have fired,
  // so a question asked then was never heard: say we are listening now. The
  // message carries nothing, so any parent may receive it.
  window.parent.postMessage({ protocol: PROTOCOL, type: 'ready' }, '*');
}
