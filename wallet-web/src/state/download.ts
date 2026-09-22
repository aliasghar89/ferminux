/** Trigger a local file download of the encrypted keystore JSON (browser only). */
export function downloadKeystore(json: string, address: string, label?: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = label
    ? label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24)
    : '';
  a.download = `ferminux-keystore-${slug ? `${slug}-` : ''}${address.slice(2, 10).toLowerCase()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
