// The Capacitor side of the platform bridge. Loaded only in an app build
// (index.ts imports it behind NATIVE_BUILD), so none of this reaches the web
// bundle.
//
// Plugins
//   @capgo/capacitor-native-biometric  Keystore/Keychain storage (setData: AES-GCM with an
//                                      Android Keystore key / a Keychain item) and the
//                                      biometric-bound secret (setData + accessControl: an
//                                      Android Keystore key that needs a BiometricPrompt
//                                      CryptoObject to decrypt / a Keychain item with
//                                      SecAccessControl .biometryCurrentSet)
//   @capacitor/barcode-scanner         native full-screen QR scanner (Android: CameraX + ML Kit,
//                                      no Google Play services needed; iOS: AVFoundation)
//   @capacitor-community/privacy-screen  FLAG_SECURE / iOS screenshot shield, on demand only
//   @capacitor/app, browser, filesystem, share, splash-screen

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';
import { AccessControl, BiometryType, NativeBiometric } from '@capgo/capacitor-native-biometric';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import {
  BiometricInvalidatedError,
  PROTECTED_KEYS,
  SECURE_SCREEN_SELECTOR,
  ScanUnavailableError,
  platformName,
  runBackHandlers,
  type BiometricKind,
  type BiometricStatus,
  type PlatformHooks,
  type SaveFileResult,
} from './index.ts';

/** Namespace for this app's entries in the plugin's store. */
const NS = 'fxw.';
/** The vault password behind the device biometrics. */
const BIO_KEY = `${NS}biometric.password.v1`;
/** In-page "Back" controls the Android back button follows when no dialog is open. */
const IN_PAGE_BACK_SELECTOR = '[data-back], .back-btn';
/** Where saveFile() writes before the share sheet; emptied on every start. */
const EXPORT_DIR = 'exports';

interface Mirror {
  active: boolean;
  values: Map<string, string>;
}

function errCode(e: unknown): number | null {
  const c = (e as { code?: unknown } | null)?.code;
  const n = typeof c === 'string' ? Number(c) : typeof c === 'number' ? c : NaN;
  return Number.isFinite(n) ? n : null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readData(key: string): Promise<string | null> {
  try {
    const r = await NativeBiometric.getData({ key: NS + key });
    return typeof r.value === 'string' ? r.value : null;
  } catch {
    return null; // "No data found"
  }
}

async function writeData(key: string, value: string): Promise<void> {
  await NativeBiometric.setData({ key: NS + key, value });
}

async function deleteData(key: string): Promise<void> {
  try {
    await NativeBiometric.deleteData({ key: NS + key });
  } catch {
    /* nothing stored */
  }
}

function safeLocal(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function kindOf(t: BiometryType | undefined): BiometricKind {
  switch (t) {
    case BiometryType.FINGERPRINT:
    case BiometryType.TOUCH_ID:
      return 'fingerprint';
    case BiometryType.FACE_ID:
    case BiometryType.FACE_AUTHENTICATION:
      return 'face';
    case BiometryType.IRIS_AUTHENTICATION:
      return 'iris';
    case BiometryType.MULTIPLE:
      return 'multiple';
    default:
      return 'none';
  }
}

function labelOf(t: BiometryType | undefined): string {
  switch (t) {
    case BiometryType.FACE_ID:
      return 'Face ID';
    case BiometryType.TOUCH_ID:
      return 'Touch ID';
    case BiometryType.FINGERPRINT:
      return 'Fingerprint';
    case BiometryType.FACE_AUTHENTICATION:
      return 'Face unlock';
    case BiometryType.IRIS_AUTHENTICATION:
      return 'Iris unlock';
    default:
      return 'Biometrics';
  }
}

export function createNative(hooks: PlatformHooks) {
  /** Writes to the secure store run one after another, in call order. */
  let writes: Promise<void> = Promise.resolve();
  let secureOn = false;
  let secureRefs = 0;
  let domSecure = false;

  async function applySecure() {
    const want = secureRefs > 0 || domSecure;
    if (want === secureOn) return;
    secureOn = want;
    try {
      if (want) await PrivacyScreen.enable();
      else await PrivacyScreen.disable();
    } catch (e) {
      console.error('platform: secure screen', errText(e));
    }
  }

  /** Watch the page for secret screens (recovery phrase, key reveal). */
  function watchSecureScreens() {
    let queued = false;
    const check = () => {
      queued = false;
      const hit = document.querySelector(SECURE_SCREEN_SELECTOR) !== null;
      if (hit !== domSecure) {
        domSecure = hit;
        void applySecure();
      }
    };
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      // Before the next frame paints: the flag must be on before the phrase is drawn.
      queueMicrotask(check);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-secure-screen', 'class'] });
    check();
  }

  /** Links with target=_blank (explorer, docs) belong in the system browser, not the wallet's WebView. */
  function routeExternalLinks() {
    document.addEventListener(
      'click',
      (ev) => {
        if (ev.defaultPrevented || ev.button !== 0) return;
        const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || a.hasAttribute('download')) return;
        let url: URL;
        try {
          url = new URL(a.href, location.href);
        } catch {
          return;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        if (url.origin === location.origin) return;
        ev.preventDefault();
        void Browser.open({ url: url.toString() });
      },
      true,
    );
  }

  function handleBack() {
    void App.addListener('backButton', ({ canGoBack }) => {
      if (runBackHandlers()) return;
      const dialog = document.querySelector('[role="dialog"], .modal-overlay');
      if (dialog) {
        // Every dialog closes on Escape (components/ui.tsx Modal, the WalletConnect modals).
        const target = (document.activeElement as HTMLElement | null) ?? document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        return;
      }
      // A sub-screen's own Back control (Send, Receive, onboarding steps): the same as tapping it.
      const inPage = Array.from(document.querySelectorAll<HTMLElement>(IN_PAGE_BACK_SELECTOR)).find(
        (el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
      );
      if (inPage) {
        inPage.click();
        return;
      }
      if (canGoBack) {
        window.history.back();
        return;
      }
      void App.minimizeApp();
    });
  }

  async function listenForLinks() {
    await App.addListener('appUrlOpen', ({ url }) => hooks.deliverUrl(url));
    try {
      const launch = await App.getLaunchUrl();
      if (launch?.url) hooks.deliverUrl(launch.url);
    } catch {
      /* not launched by a link */
    }
  }

  async function clearExports() {
    try {
      await Filesystem.rmdir({ path: EXPORT_DIR, directory: Directory.Cache, recursive: true });
    } catch {
      /* nothing there */
    }
  }

  /** Move the vault from WebView storage (an older build, or a fallback write) into the secure store. */
  async function hydrate(m: Mirror) {
    const ls = safeLocal();
    for (const key of PROTECTED_KEYS) {
      let value = await readData(key);
      const local = ls?.getItem(key) ?? null;
      if (value === null && local !== null) {
        try {
          await writeData(key, local);
          if ((await readData(key)) === local) {
            value = local;
            ls?.removeItem(key);
          } else value = local;
        } catch (e) {
          console.error('platform: vault migration failed; keeping WebView copy', errText(e));
          value = local;
        }
      } else if (value !== null && local !== null) {
        // The secure copy is authoritative; a stale WebView copy is removed.
        ls?.removeItem(key);
      }
      if (value !== null) m.values.set(key, value);
    }
    m.active = true;
  }

  /** `html.fxw-app[data-platform=android|ios]` for app-only styling; the browser-only "open in a wallet app" hand-off is hidden. */
  function markPlatform() {
    const root = document.documentElement;
    root.classList.add('fxw-app');
    root.dataset.platform = platformName();
    const style = document.createElement('style');
    // components/MobileHandoff.tsx is byte-identical with the DEX's copy, so it is hidden here rather than edited.
    style.textContent = 'html.fxw-app [data-testid="mobile-handoff"]{display:none!important}';
    document.head.appendChild(style);
  }

  return {
    async boot(m: Mirror) {
      markPlatform();
      await hydrate(m);
      let bio = false;
      try {
        bio = (await NativeBiometric.isDataSaved({ key: BIO_KEY })).isSaved === true;
      } catch {
        bio = false;
      }
      // A password with no vault to open (forgotten from an older build) is removed, not kept.
      if (bio && !m.values.has(PROTECTED_KEYS[0])) {
        await NativeBiometric.deleteData({ key: BIO_KEY }).catch(() => undefined);
        bio = false;
      }
      hooks.setBiometricEnabled(bio);
      watchSecureScreens();
      routeExternalLinks();
      handleBack();
      void clearExports();
      await listenForLinks();
    },

    hideSplash() {
      return SplashScreen.hide({ fadeOutDuration: 150 }).catch(() => undefined);
    },

    /* secure store ------------------------------------------------- */

    secureGet: readData,
    async secureSet(key: string, value: string) {
      await writeData(key, value);
    },
    secureRemove: deleteData,

    /** vaultMirror write-through: queued, never lost — a failed secure write lands in WebView storage (still scrypt-encrypted). */
    persist(key: string, value: string | null) {
      writes = writes.then(async () => {
        const ls = safeLocal();
        if (value === null) {
          await deleteData(key);
          ls?.removeItem(key);
          return;
        }
        try {
          await writeData(key, value);
          ls?.removeItem(key);
        } catch (e) {
          console.error('platform: secure write failed; keeping an encrypted copy in WebView storage', errText(e));
          try {
            ls?.setItem(key, value);
          } catch {
            /* storage full: the in-memory mirror still holds it for this session */
          }
        }
      });
    },

    /* biometrics --------------------------------------------------- */

    async biometricStatus(): Promise<BiometricStatus> {
      try {
        const r = await NativeBiometric.isAvailable({ useFallback: false });
        const kind = kindOf(r.biometryType);
        const label = labelOf(r.biometryType);
        // The password is kept behind a Keystore key that needs Class 3 (strong) biometrics on Android.
        const available = platformName() === 'android' ? r.strongBiometryIsAvailable === true : r.isAvailable === true;
        let reason: string | null = null;
        if (!available) {
          if (r.isAvailable && platformName() === 'android') reason = 'This device’s biometrics are not strong enough to protect a wallet password.';
          else if (r.deviceIsSecure === false) reason = 'Set a screen lock and enrol a fingerprint or face in the device settings first.';
          else reason = 'No fingerprint or face is enrolled on this device.';
        }
        return { available, kind, label, reason };
      } catch (e) {
        return { available: false, kind: 'none', label: 'Biometrics', reason: errText(e) };
      }
    },

    async biometricEnable(password: string) {
      await NativeBiometric.setData({
        key: BIO_KEY,
        value: password,
        accessControl: AccessControl.BIOMETRY_CURRENT_SET,
        title: 'Turn on biometric unlock',
        negativeButtonText: 'Cancel',
      });
    },

    async biometricDisable() {
      try {
        await NativeBiometric.deleteData({ key: BIO_KEY });
      } catch {
        /* nothing stored */
      }
    },

    async biometricUnlock(): Promise<string | null> {
      try {
        const r = await NativeBiometric.getSecureData({
          key: BIO_KEY,
          reason: 'Unlock Ferminux Wallet',
          title: 'Unlock Ferminux Wallet',
          subtitle: 'Confirm it is you',
          negativeButtonText: 'Use password',
        });
        return typeof r.value === 'string' && r.value !== '' ? r.value : null;
      } catch (e) {
        const code = errCode(e);
        const text = errText(e);
        // The saved password is gone (code 21), or its Keystore key was invalidated or removed. Android reports
        // the last two as code 0 ("Biometric enrollment changed", "Biometric crypto object unavailable"), and
        // on enrollment change the plugin has already deleted the entry: say so and turn the setting off,
        // instead of reading it as a cancel and leaving a button that does nothing.
        if (code === 21 || /enrollment changed|invalidated|KeyPermanentlyInvalidated/i.test(text)) throw new BiometricInvalidatedError();
        if (/crypto object unavailable|key not found/i.test(text)) {
          throw new BiometricInvalidatedError('This device can no longer read the password saved for biometric unlock, so it was turned off. Unlock with your password, then turn it on again.');
        }
        // cancelled, "use password", timeout, system cancel, failed match: fall back to the password field
        if (code === 16 || code === 17 || code === 15 || code === 11 || code === 10 || code === null) return null;
        // The Android plugin closes the prompt after one unrecognised finger with its own code 4 "Too many failed
        // attempts"; the system lockout (also code 4, or 2 when permanent) carries the system's own text.
        if (code === 4 && /^Too many failed attempts$/i.test(text.trim())) throw new Error('Not recognised. Try again, or use your password.');
        if (code === 2 || code === 4) throw new Error('Too many attempts. Use your password, or try again later.');
        throw new Error(text);
      }
    },

    /* QR ----------------------------------------------------------- */

    async scanQr(): Promise<string | null> {
      try {
        const r = await CapacitorBarcodeScanner.scanBarcode({
          hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
          scanInstructions: 'Point the camera at the QR code',
          scanButton: false,
          cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
          scanOrientation: CapacitorBarcodeScannerScanOrientation.ADAPTIVE,
          cancelButtonAccessibilityLabel: 'Close the scanner',
          android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.MLKIT },
        });
        const text = typeof r.ScanResult === 'string' ? r.ScanResult : '';
        return text !== '' ? text : null;
      } catch (e) {
        if (/cancel/i.test(errText(e))) return null;
        // Camera refused or missing: the in-page scanner explains that, and offers image / paste.
        throw new ScanUnavailableError(errText(e));
      }
    },

    /* links, screens, files ---------------------------------------- */

    async openExternal(url: string) {
      await Browser.open({ url });
    },

    setSecureRefs(n: number) {
      secureRefs = n;
      void applySecure();
    },

    async saveFile(name: string, text: string): Promise<SaveFileResult> {
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 96) || 'ferminux-file.json';
      const path = `${EXPORT_DIR}/${safe}`;
      const written = await Filesystem.writeFile({ path, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      try {
        await Share.share({ title: safe, dialogTitle: 'Save your keystore file', files: [written.uri] });
        return 'shared';
      } catch (e) {
        if (/cancel/i.test(errText(e))) return 'cancelled';
        throw e;
      }
    },
  };
}

export type NativeImpl = ReturnType<typeof createNative>;
