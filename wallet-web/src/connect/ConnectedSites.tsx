// "Connected sites": every origin this wallet approved, the account it can
// see, when it was last used — and Revoke. Self-contained (reads and writes
// the sites store itself, follows changes from other tabs), so the main
// wallet screen can mount it as-is:
//
//   import { ConnectedSites } from './connect/index.ts';
//   <ConnectedSites />
//
// A revoke takes effect at once for the wallet (the next request from that
// site is refused with 4100) and, for dApps on the wallet's own site, live in
// the dApp through its status frame.

import { useEffect, useState } from 'react';
import { Identicon } from '../components/Identicon.tsx';
import { shortAddress } from '../lib/validate.ts';
import { isSecureOrigin, loadSites, onSitesChange, relativeTime, revokeSite, type ConnectedSite } from './sites.ts';

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function ConnectedSites({ onRevoked }: { onRevoked?: (origin: string) => void } = {}) {
  const [sites, setSites] = useState<ConnectedSite[]>(() => loadSites());
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => onSitesChange(() => setSites(loadSites())), []);

  if (sites.length === 0) {
    return (
      <div className="empty-state" data-testid="sites-empty">
        <div className="title">No connected sites</div>
        When a site asks to connect to Ferminux Wallet and you approve it, it is listed here.
      </div>
    );
  }

  return (
    <ul className="row-list cx-sites" data-testid="connected-sites">
      {sites.map((site) => (
        <li key={site.origin} data-origin={site.origin}>
          <div className="row-main">
            <div className="row-title">
              <span className="cx-site-host">{hostOf(site.origin)}</span>
              {!isSecureOrigin(site.origin) && <span className="acct-tag cx-tag-danger">NOT HTTPS</span>}
            </div>
            <div className="row-sub mono">{site.origin}</div>
            <div className="cx-site-meta">
              {site.accounts.map((a) => (
                <span key={a} className="cx-site-acct" title={a}>
                  <Identicon address={a} size={14} />
                  <span className="mono">{shortAddress(a)}</span>
                </span>
              ))}
              <span className="muted">· used {relativeTime(site.lastUsedAt)}</span>
            </div>
          </div>
          <div className="row-actions">
            {confirming === site.origin ? (
              <>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)}>
                  Keep
                </button>
                <button
                  className="btn btn-sm btn-danger-ghost"
                  data-testid="revoke-confirm"
                  onClick={() => {
                    revokeSite(site.origin);
                    setConfirming(null);
                    onRevoked?.(site.origin);
                  }}
                >
                  Revoke
                </button>
              </>
            ) : (
              <button
                className="btn btn-sm"
                data-testid="revoke"
                aria-label={`Revoke ${hostOf(site.origin)}`}
                onClick={() => setConfirming(site.origin)}
              >
                Revoke
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
