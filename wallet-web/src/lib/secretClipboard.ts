// A copied secret (the recovery phrase) must not stay on the system clipboard.
//
// The clipboard outlives the page: other apps, clipboard history and cloud
// clipboard sync all see what is left there. A copied secret is wiped after
// SECRET_CLIPBOARD_MS, unless something else has been copied since (by this
// page, or anywhere when the browser lets the page look without a prompt).
// A page without focus may not write the clipboard, so a wipe that comes due
// in the background happens as soon as the page is back.
//
// No browser globals at import time: the Node tests pass their own clipboard.

export const SECRET_CLIPBOARD_MS = 60_000;

export interface ClipboardEnv {
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** Whether the page may read the clipboard without a prompt. */
  canRead(): Promise<boolean>;
  now(): number;
}

function browserEnv(): ClipboardEnv {
  return {
    clipboard: navigator.clipboard,
    async canRead() {
      try {
        return (await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName }))?.state === 'granted';
      } catch {
        return false; // the permission name is unknown here (Firefox, Safari)
      }
    },
    now: () => Date.now(),
  };
}

let pending: { text: string; due: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let watching = false;

/** Wipe the clipboard if a secret copied here is due and still (as far as can be told) on it. */
export async function wipeSecretIfDue(env: ClipboardEnv = browserEnv()): Promise<void> {
  const p = pending;
  if (!p || env.now() < p.due) return;
  try {
    if ((await env.canRead()) && (await env.clipboard.readText()) !== p.text) {
      if (pending === p) pending = null; // something else was copied since
      return;
    }
  } catch {
    /* could not look: wipe */
  }
  try {
    await env.clipboard.writeText('');
    if (pending === p) pending = null;
  } catch {
    /* not focused: retried when the page is back */
  }
}

/** Record a copy made by this page. A secret is wiped later; anything else replaces it on the clipboard. */
export function noteCopied(text: string, secret: boolean, env?: ClipboardEnv): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
  if (!secret) return;
  const e = env ?? browserEnv();
  pending = { text, due: e.now() + SECRET_CLIPBOARD_MS };
  timer = setTimeout(() => void wipeSecretIfDue(env), SECRET_CLIPBOARD_MS);
  if (!watching && typeof window !== 'undefined' && typeof document !== 'undefined') {
    watching = true;
    window.addEventListener('focus', () => void wipeSecretIfDue());
    document.addEventListener('visibilitychange', () => void wipeSecretIfDue());
    // The person copied something else in this page: the secret is already gone.
    document.addEventListener('copy', () => {
      pending = null;
    });
  }
}

/** Test hook: whether a wipe is still owed. */
export function secretPending(): boolean {
  return pending !== null;
}
