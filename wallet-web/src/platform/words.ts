// Wording that depends on where the wallet runs. The same screens ship as the
// web wallet (keys in this browser's storage, a keystore file downloads) and
// as the Ferminux Wallet app (keys in the phone's Keystore/Keychain-backed
// store, a keystore file leaves through the share sheet). Every sentence that
// names the place or the file hand-over asks here instead of hard-coding the
// browser.
//
// Plain functions, read at render time: isNativeApp() is fixed for the life
// of the page, so no subscription is needed.

import { isNativeApp, type SaveFileResult } from './index.ts';

/** "this phone" in the app, "this browser" on the web — where keys are made and kept. */
export function here(): string {
  return isNativeApp() ? 'this phone' : 'this browser';
}

/** Sentence-initial form of here(). */
export function Here(): string {
  return isNativeApp() ? 'This phone' : 'This browser';
}

/** Where a remembered wallet is stored, as a phrase: "in this browser" / "on this phone, in its secure storage". */
export function storedWhere(): string {
  return isNativeApp() ? 'on this phone, in its secure storage' : 'in this browser';
}

/** Where keys live while unlocked but not remembered. */
export function sessionOnlyWhere(): string {
  return isNativeApp()
    ? 'Keys live in the app’s memory only. Locking or closing the app forgets them.'
    : 'Keys live in this tab only. Locking or closing it forgets them.';
}

/** How the keystore file reaches the user, for the sentence before the button. */
export function keystoreHandOver(): string {
  return isNativeApp()
    ? 'the share sheet opens so you can save the keystore file to Files, Drive or another place you control'
    : 'the keystore file downloads';
}

/** The button that encrypts and hands over the first keystore. */
export function encryptButtonLabel(): string {
  return isNativeApp() ? 'Encrypt & save keystore file' : 'Encrypt & download keystore';
}

/** The export form's button. */
export function exportButtonLabel(): string {
  return isNativeApp() ? 'Save file' : 'Download';
}

/** The export form's first sentence ("Downloads a scrypt-encrypted keystore for …"). */
export function exportLead(): string {
  return isNativeApp() ? 'Saves a scrypt-encrypted keystore file, through the share sheet, for' : 'Downloads a scrypt-encrypted keystore for';
}

/**
 * What happened to a keystore file, for the notice after it was handed over.
 * `subject` names it ("Keystore file", "Keystore for Payroll").
 */
export function keystoreResult(result: SaveFileResult | 'failed', subject = 'Keystore file'): { ok: boolean; text: string } {
  switch (result) {
    case 'downloaded':
      return { ok: true, text: `${subject} downloaded.` };
    case 'shared':
      return { ok: true, text: `${subject} handed to the share sheet. Check it arrived where you saved it.` };
    case 'cancelled':
      return { ok: false, text: `${subject} was not saved: the share sheet was closed. Save it again.` };
    default:
      return { ok: false, text: `${subject} could not be ${isNativeApp() ? 'handed to the share sheet' : 'downloaded'}. Try again.` };
  }
}
