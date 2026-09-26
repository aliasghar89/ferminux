import { saveFile, type SaveFileResult } from '../platform/index.ts';

/**
 * Hand the user the encrypted keystore JSON: a file download in the browser,
 * the share sheet in the app (Save to Files / Drive / …) — platform/saveFile.
 * Resolves what happened, so the screen can say "downloaded", "handed to the
 * share sheet" or "not saved" instead of assuming a download; never rejects.
 */
export function downloadKeystore(json: string, address: string, label?: string): Promise<SaveFileResult | 'failed'> {
  const slug = label
    ? label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24)
    : '';
  const name = `ferminux-keystore-${slug ? `${slug}-` : ''}${address.slice(2, 10).toLowerCase()}.json`;
  return saveFile(name, json, 'application/json').catch((e: unknown) => {
    console.error('keystore file could not be handed over', e);
    return 'failed' as const;
  });
}
