// Platform bridge: the one place the UI asks "am I the Android / iOS app, and
// if so, do this natively".
//
// The same React code base ships as the web wallet (wallet.ferminux.net,
// ferminux.net/wallet/) and as the Ferminux Wallet app (Capacitor, app id
// net.ferminux.wallet). Every function here has a web behaviour, so the UI
// calls it unconditionally:
//
//   secureStore      Android Keystore / iOS Keychain backed key-value store (web: unavailable)
//   vaultMirror      synchronous view of the stored vault for state/storage.ts; on the app the
//                    encrypted vault lives in the Keystore/Keychain store, not in WebView storage
//   biometric        fingerprint / Face ID unlock: the vault password kept behind a
//                    biometric-bound Keystore key / Keychain item (web: unavailable)
//   scanQr           native QR scanner (web: throws ScanUnavailableError -> use the in-page scanner)
//   openExternal     system browser / custom tab (web: window.open)
//   onDeepLink       wc: / ferminuxwallet:// / https://wallet.ferminux.net/wc links (web: the page URL once)
//   setSecureScreen  FLAG_SECURE / iOS screenshot shield while a secret is on screen (web: no-op)
//   onBackButton     Android back button (web: never fires)
//   saveFile         keystore "download" (web: <a download>; app: share sheet)
//
// This module must stay importable under plain Node (no browser globals at
// import time, no Capacitor import): state/storage.ts imports it and the unit
// tests import storage's neighbours. The Capacitor code lives in ./native.ts
// and is loaded only in an app build (VITE_APP_NATIVE=1), so the web bundle
// contains none of it.

import { VAULT_KEY, LEGACY_KEYSTORE_KEY } from '../lib/vault.ts';
import { createDeduper, parseDeepLink, type DeepLink } from './deeplink.ts';
import type { NativeImpl } from './native.ts';

export type { DeepLink } from './deeplink.ts';
export { parseDeepLink, APP_SCHEME } from './deeplink.ts';

const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** Compile-time: this bundle is the app's (scripts/app-build.mjs sets VITE_APP_NATIVE=1). */
export const NATIVE_BUILD: boolean = env.VITE_APP_NATIVE === '1';

export type PlatformName = 'web' | 'android' | 'ios';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | null {
  const g = globalThis as { Capacitor?: CapacitorGlobal };
  return g.Capacitor ?? null;
}

/** True inside the Android / iOS app (and only in an app build). */
export function isNativeApp(): boolean {
  return NATIVE_BUILD && capacitorGlobal()?.isNativePlatform?.() === true;
}

export function platformName(): PlatformName {
  if (!isNativeApp()) return 'web';
  return capacitorGlobal()?.getPlatform?.() === 'ios' ? 'ios' : 'android';
}

/* ------------------------------------------------------------------ */
/* Native implementation (lazy)                                        */
/* ------------------------------------------------------------------ */

let nativeImpl: NativeImpl | null = null;
let nativeLoading: Promise<NativeImpl | null> | null = null;

function loadNative(): Promise<NativeImpl | null> {
  if (!isNativeApp()) return Promise.resolve(null);
  // Written out in full so Vite replaces it with a literal: in a web build the
  // branch below is dead and the native chunk (Capacitor plugins) is not emitted.
  if (import.meta.env.VITE_APP_NATIVE !== '1') return Promise.resolve(null);
  if (!nativeLoading) {
    nativeLoading = import('./native.ts').then(
      (m) => (nativeImpl = m.createNative(hooks)),
      (e: unknown) => {
        console.error('platform: native bridge failed to load', e);
        return null;
      },
    );
  }
  return nativeLoading;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let booted = false;

/**
 * Call once before the first render (main.tsx). On the web it resolves
 * immediately. In the app it loads the stored vault out of the
 * Keystore/Keychain store into vaultMirror (moving a vault an older build left
 * in WebView storage), and starts listening for deep links, the back button
 * and secret screens.
 */
export async function bootPlatform(): Promise<void> {
  if (booted) return;
  booted = true;
  if (!isNativeApp()) {
    captureWebDeepLink();
    return;
  }
  const n = await loadNative();
  if (!n) return;
  try {
    await n.boot(mirror);
  } catch (e) {
    console.error('platform: boot failed', e);
  }
}

/** The first screen has rendered: take the splash down. No-op on the web. */
export function markAppReady(): void {
  if (nativeImpl) void nativeImpl.hideSplash();
}

/* ------------------------------------------------------------------ */
/* Secure store                                                        */
/* ------------------------------------------------------------------ */

export const secureStore = {
  /** Keystore / Keychain storage exists here (the app). */
  available(): boolean {
    return isNativeApp();
  },
  async get(key: string): Promise<string | null> {
    const n = await loadNative();
    return n ? n.secureGet(key) : null;
  },
  async set(key: string, value: string): Promise<void> {
    const n = await loadNative();
    if (!n) throw new Error('Secure storage is only available in the Ferminux Wallet app.');
    await n.secureSet(key, value);
  },
  async remove(key: string): Promise<void> {
    const n = await loadNative();
    if (n) await n.secureRemove(key);
  },
};

/* ------------------------------------------------------------------ */
/* Vault mirror (synchronous, for state/storage.ts)                    */
/* ------------------------------------------------------------------ */

/** Storage keys that hold encrypted key material: on the app they never touch WebView storage. */
export const PROTECTED_KEYS: readonly string[] = [VAULT_KEY, LEGACY_KEYSTORE_KEY];

/** Filled by native.ts at boot. */
const mirror = {
  active: false,
  values: new Map<string, string>(),
};

export const vaultMirror = {
  /** True when this key is kept in the Keystore/Keychain store instead of localStorage. */
  handles(key: string): boolean {
    return mirror.active && PROTECTED_KEYS.includes(key);
  },
  get(key: string): string | null {
    return mirror.values.get(key) ?? null;
  },
  /** Returns false when the value could not be kept (never on the happy path). */
  set(key: string, value: string): boolean {
    mirror.values.set(key, value);
    if (nativeImpl) nativeImpl.persist(key, value);
    return true;
  },
  remove(key: string): void {
    mirror.values.delete(key);
    if (nativeImpl) nativeImpl.persist(key, null);
    // No vault, nothing for the stored password to unlock.
    if (key === VAULT_KEY) void biometric.disable();
  },
};

/* ------------------------------------------------------------------ */
/* Biometric unlock                                                    */
/* ------------------------------------------------------------------ */

export type BiometricKind = 'fingerprint' | 'face' | 'iris' | 'multiple' | 'none';

export interface BiometricStatus {
  /** Strong biometrics are enrolled and usable for a Keystore-bound secret. */
  available: boolean;
  kind: BiometricKind;
  /** "Fingerprint", "Face ID", "Touch ID", "Face unlock", "Biometrics". */
  label: string;
  /** Why it is not available, in words the UI can show. */
  reason: string | null;
}

/** The stored password can no longer be read: biometrics changed on the device, or it was removed. */
export class BiometricInvalidatedError extends Error {
  constructor(message = 'Biometrics on this device changed, so fingerprint unlock was turned off. Unlock with your password, then turn it on again.') {
    super(message);
    this.name = 'BiometricInvalidatedError';
  }
}

const UNAVAILABLE: BiometricStatus = { available: false, kind: 'none', label: 'Biometrics', reason: 'Only available in the Ferminux Wallet app.' };

let bioEnabled = false;
const bioListeners = new Set<(enabled: boolean) => void>();

function setBioEnabled(on: boolean) {
  if (bioEnabled === on) return;
  bioEnabled = on;
  for (const l of bioListeners) l(on);
}

export const biometric = {
  async status(): Promise<BiometricStatus> {
    const n = await loadNative();
    return n ? n.biometricStatus() : UNAVAILABLE;
  },
  /** Fingerprint / Face ID unlock is set up on this device (synchronous; known after boot). */
  isEnabled(): boolean {
    return bioEnabled;
  },
  onChange(listener: (enabled: boolean) => void): () => void {
    bioListeners.add(listener);
    return () => bioListeners.delete(listener);
  },
  /**
   * Keep `password` behind the device's biometrics. The caller must have
   * verified it against the stored vault first (vault.ts verifyVaultPassword):
   * a wrong password stored here would only ever fail later.
   * Android shows the biometric prompt now (the Keystore key is created bound to it).
   */
  async enable(password: string): Promise<void> {
    const n = await loadNative();
    if (!n) throw new Error(UNAVAILABLE.reason!);
    await n.biometricEnable(password);
    setBioEnabled(true);
  },
  async disable(): Promise<void> {
    const n = nativeImpl ?? (await loadNative());
    if (n) await n.biometricDisable().catch(() => undefined);
    setBioEnabled(false);
  },
  /**
   * Show the biometric prompt and return the stored password, or null when
   * the user cancelled / chose the password instead. Throws
   * BiometricInvalidatedError when the secret is gone (enrollment changed):
   * fingerprint unlock is then already switched off.
   */
  async unlock(): Promise<string | null> {
    const n = await loadNative();
    if (!n || !bioEnabled) return null;
    try {
      return await n.biometricUnlock();
    } catch (e) {
      if (e instanceof BiometricInvalidatedError) {
        await biometric.disable();
      }
      throw e;
    }
  },
};

/* ------------------------------------------------------------------ */
/* QR scanning                                                         */
/* ------------------------------------------------------------------ */

/** No native scanner here (web, or the device lacks it): use the in-page camera scanner. */
export class ScanUnavailableError extends Error {
  constructor(message = 'The native scanner is not available here.') {
    super(message);
    this.name = 'ScanUnavailableError';
  }
}

/** A native scanner will be tried (the app). The UI still keeps its in-page fallback. */
export function canScanNatively(): boolean {
  return isNativeApp();
}

/**
 * Scan one QR code with the platform scanner. Resolves the raw text, or null
 * when the user closed the scanner. Throws ScanUnavailableError when there is
 * no native scanner (always on the web) — fall back to the in-page scanner.
 */
export async function scanQr(): Promise<string | null> {
  const n = await loadNative();
  if (!n) throw new ScanUnavailableError();
  return n.scanQr();
}

/* ------------------------------------------------------------------ */
/* External links                                                      */
/* ------------------------------------------------------------------ */

/** Open an http(s) URL outside the wallet (custom tab / Safari view in the app). */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  const n = await loadNative();
  if (n) {
    await n.openExternal(parsed.toString());
    return;
  }
  if (typeof window !== 'undefined') window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
}

/* ------------------------------------------------------------------ */
/* Deep links                                                          */
/* ------------------------------------------------------------------ */

const linkListeners = new Set<(link: DeepLink) => void>();
/** Links that arrived before anyone listened (the launch URL): replayed to the first listener. */
const pendingLinks: DeepLink[] = [];
const fresh = createDeduper();

const hooks = {
  /** native.ts hands every URL the app is opened with to this. */
  deliverUrl(raw: string): void {
    const link = parseDeepLink(raw);
    if (!link || !fresh(link)) return;
    if (linkListeners.size === 0) pendingLinks.push(link);
    else for (const l of linkListeners) l(link);
  },
  setBiometricEnabled(on: boolean): void {
    setBioEnabled(on);
  },
};

export type PlatformHooks = typeof hooks;

/**
 * Subscribe to deep links. The link the app was launched with (or, on the
 * web, a wallet URL like /wc?uri=wc:…) is delivered to the first subscriber.
 * Returns an unsubscribe function.
 */
export function onDeepLink(listener: (link: DeepLink) => void): () => void {
  linkListeners.add(listener);
  if (pendingLinks.length > 0) {
    const queued = pendingLinks.splice(0);
    queueMicrotask(() => {
      for (const l of queued) listener(l);
    });
  }
  return () => {
    linkListeners.delete(listener);
  };
}

/**
 * Web: https://wallet.ferminux.net/wc?uri=wc:… opens the web wallet when the
 * app is not installed. Take the code out of the address bar (it carries the
 * pairing key) and queue it like an app link.
 */
function captureWebDeepLink(): void {
  if (typeof window === 'undefined' || typeof location === 'undefined') return;
  const here = location.href;
  const link = parseDeepLink(here, [location.host]);
  if (!link || link.kind === 'open') return;
  try {
    const clean = new URL(here);
    clean.search = '';
    clean.pathname = clean.pathname.replace(/wc\/?$/i, '');
    history.replaceState(history.state, '', clean.toString());
  } catch {
    /* leave the URL as it is */
  }
  if (fresh(link)) pendingLinks.push(link); // boot runs before any listener exists
}

/* ------------------------------------------------------------------ */
/* Secure screen                                                       */
/* ------------------------------------------------------------------ */

let secureRefs = 0;

/**
 * Keep screenshots, screen recording and the app-switcher thumbnail from
 * capturing the screen (Android FLAG_SECURE; iOS screenshot shield) while
 * `on`. Reference-counted: every setSecureScreen(true) needs its false.
 *
 * Declarative alternative: any element carrying `data-secure-screen` (and the
 * recovery-phrase grid, `.mnemonic-grid`) turns it on while it is in the page.
 */
export async function setSecureScreen(on: boolean): Promise<void> {
  secureRefs = Math.max(0, secureRefs + (on ? 1 : -1));
  const n = await loadNative();
  if (n) n.setSecureRefs(secureRefs);
}

/** Elements whose presence turns the secure screen on (see setSecureScreen). */
export const SECURE_SCREEN_SELECTOR = '[data-secure-screen], .mnemonic-grid';

/* ------------------------------------------------------------------ */
/* Android back button                                                 */
/* ------------------------------------------------------------------ */

const backHandlers: Array<() => boolean | void> = [];

/**
 * Handle the Android back button. The most recently registered handler runs
 * first; return true to consume the press. Unhandled presses close the
 * top-most dialog (it receives Escape, which every Modal already honours),
 * then press the screen's own visible Back control (`.back-btn` or
 * `[data-back]`), then go back in history, then send the app to the background.
 */
export function onBackButton(handler: () => boolean | void): () => void {
  backHandlers.push(handler);
  return () => {
    const i = backHandlers.lastIndexOf(handler);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}

/** native.ts: run the registered handlers, newest first. */
export function runBackHandlers(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i -= 1) {
    if (backHandlers[i]() === true) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export type SaveFileResult = 'downloaded' | 'shared' | 'cancelled';

/**
 * Hand a text file to the user: a download on the web, the share sheet in
 * the app (Save to Files / Drive / …). The app writes it to its cache for the
 * share and clears that cache on the next start.
 */
export async function saveFile(name: string, text: string, mime = 'application/json'): Promise<SaveFileResult> {
  if (isNativeApp()) {
    const n = await loadNative();
    if (n) return n.saveFile(name, text);
  }
  // Web: synchronous, inside the click that asked for it.
  if (typeof document === 'undefined') return 'cancelled';
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}

/* ------------------------------------------------------------------ */
/* WalletConnect identity                                              */
/* ------------------------------------------------------------------ */

/** Where dApps send the user back to the wallet (WalletConnect metadata `redirect`). */
export const WALLET_UNIVERSAL_LINK = 'https://wallet.ferminux.net/wc';
export const WALLET_NATIVE_LINK = 'ferminuxwallet://';

/**
 * Metadata fields to merge into WalletKit.init({ metadata }). In the app the
 * icon must be a public URL (the page's own files are not reachable from a
 * dApp), and `redirect` tells dApps how to send the user back to the app after
 * they ask for a signature. (The SDK reports the page origin as `url`; the app
 * serves itself as https://wallet.ferminux.net, see capacitor.config.ts.)
 */
export function wcMetadataOverrides(): {
  url?: string;
  icons?: string[];
  redirect?: { native?: string; universal?: string };
} {
  if (!isNativeApp()) return {};
  return {
    url: 'https://wallet.ferminux.net',
    icons: ['https://wallet.ferminux.net/apple-touch-icon.png'],
    redirect: { native: WALLET_NATIVE_LINK, universal: WALLET_UNIVERSAL_LINK },
  };
}
