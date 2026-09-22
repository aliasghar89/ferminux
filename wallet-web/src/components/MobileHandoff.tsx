// "Open on your phone" — the no-extension path to a working wallet.
//
// Three environments, three renderings (see src/lib/handoff.ts):
//   wallet   injected provider present (wallet in-app browser, or a desktop
//            extension) — render NOTHING; the normal flow already works.
//   phone    mobile browser, no provider — a tappable deep-link button,
//            because a phone cannot scan its own screen.
//   desktop  desktop browser, no provider — a QR of the MetaMask deep link,
//            plus the plain page URL to copy for other wallets.
//
// The QR is rendered locally to a canvas by the bundled `qrcode` package —
// no CDN, no image service, no network involved.
//
// SHARED FILE — src/components/MobileHandoff.tsx is byte-identical in dex/ui
// and wallet-web. If you change one copy, change the other;
// tests/handoff.test.mjs checks they have not drifted.

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { buildMetaMaskDeepLink, classifyHandoff } from '../lib/handoff.ts';
import { CopyButton } from './ui.tsx';

function injectedPresent(): boolean {
  return typeof window !== 'undefined' && Boolean((window as { ethereum?: unknown }).ethereum);
}

/**
 * Watch for an injected provider the same way the connect flows do: seed from
 * the immediate value, then listen for the EIP-1193/EIP-6963 announcements and
 * poll briefly — extensions often inject after first render.
 */
function useInjectedPresent(override?: boolean): boolean {
  const [present, setPresent] = useState(injectedPresent);
  useEffect(() => {
    if (override !== undefined || present) return;
    let cancelled = false;
    const found = () => {
      if (!cancelled && injectedPresent()) setPresent(true);
    };
    window.addEventListener('ethereum#initialized', found, { once: true });
    window.addEventListener('eip6963:announceProvider', found);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (injectedPresent()) {
        found();
        window.clearInterval(timer);
      } else if (Date.now() - started > 3000) {
        window.clearInterval(timer);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('ethereum#initialized', found);
      window.removeEventListener('eip6963:announceProvider', found);
    };
  }, [override, present]);
  return override ?? present;
}

/** QR rendered locally to a canvas — no network involved. */
function HandoffQr({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, value, {
      width: 184,
      margin: 2, // quiet zone — cameras need it against the dark page
      errorCorrectionLevel: 'M',
      color: { dark: '#111417', light: '#ffffff' },
    }).catch(() => setFailed(true));
  }, [value]);
  if (failed) return <p className="muted small">The QR could not be rendered — use the link below instead.</p>;
  return (
    <canvas
      ref={ref}
      width={184}
      height={184}
      data-testid="handoff-qr"
      aria-label={`QR code opening this page in MetaMask Mobile: ${value}`}
    />
  );
}

export function MobileHandoff({
  hasInjected,
  variant = 'inline',
  lede,
}: {
  /**
   * Provider presence, when the host app already tracks it (the DEX's
   * useWallet). Leave undefined and the component watches on its own.
   */
  hasInjected?: boolean;
  /**
   * 'inline' waits a beat before appearing (extensions inject late — never
   * flash a QR at someone whose wallet is about to announce itself) and shows
   * its own title. 'modal' renders immediately and leaves the title to the
   * modal chrome.
   */
  variant?: 'inline' | 'modal';
  /** Optional first sentence from the host app (e.g. "browsing works without a wallet"). */
  lede?: string;
}) {
  const injected = useInjectedPresent(hasInjected);

  const [settled, setSettled] = useState(variant === 'modal');
  useEffect(() => {
    if (settled) return;
    const t = window.setTimeout(() => setSettled(true), 900);
    return () => window.clearTimeout(t);
  }, [settled]);

  const env = classifyHandoff({
    hasInjected: injected,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  });

  // Inside a wallet browser (or next to a desktop extension) there is nothing
  // to hand off — the injected provider is already the connection.
  if (env === 'wallet' || !settled) return null;

  const pageUrl = window.location.href;
  const deepLink = buildMetaMaskDeepLink(pageUrl);

  const urlRow = (
    <div className="handoff-url-row">
      <span className="mono handoff-url" data-testid="handoff-url">
        {pageUrl}
      </span>
      <CopyButton text={pageUrl} label="Copy link" />
    </div>
  );

  if (env === 'phone') {
    return (
      <div className="handoff" data-testid="mobile-handoff" data-handoff-env="phone">
        <p className="handoff-text">
          {lede ? `${lede} ` : ''}
          This browser has no wallet. Open the page inside your wallet app instead — everything works there:
        </p>
        {deepLink && (
          <a className="btn btn-primary btn-block btn-lg handoff-open" href={deepLink} data-testid="handoff-open">
            Open in MetaMask
          </a>
        )}
        {urlRow}
        <p className="handoff-note">
          Trust Wallet and Rabby work the same way: copy the link and paste it into the wallet's built-in browser.
        </p>
      </div>
    );
  }

  return (
    <div className="handoff" data-testid="mobile-handoff" data-handoff-env="desktop">
      {variant === 'inline' && <div className="handoff-title">Open on your phone</div>}
      <p className="handoff-text">
        {lede ? `${lede} ` : ''}
        No wallet extension in this browser. Scan the code with your phone's camera: it opens this exact page
        inside MetaMask Mobile's built-in browser, where your wallet connects directly — no relay, no account,
        nothing between your devices.
      </p>
      {deepLink && (
        <div className="handoff-qr-frame">
          <HandoffQr value={deepLink} />
        </div>
      )}
      {urlRow}
      <p className="handoff-note">
        Using another wallet? Trust Wallet and Rabby have the same in-app browser — copy the link above and open
        it there. Prefer this computer? Install the MetaMask extension and reload.
      </p>
    </div>
  );
}
