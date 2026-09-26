import { useEffect, useRef, useState } from 'react';
import type { WalletConnectApi } from '../state/useWalletConnect.ts';
import { parseWcUri } from '../lib/walletconnect.ts';
import { chainById } from '../lib/chains.ts';
import { shortAddress } from '../lib/validate.ts';
import { Spinner } from '../components/ui.tsx';
import { ChainBadge } from '../components/ChainBadge.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { IconLink } from '../components/icons.tsx';
import { ScannerModal, type ScanMode } from './ScannerModal.tsx';
import { ScanGlyph } from './SendPanel.tsx';
import { DappIcon } from './WcModals.tsx';
import { ConnectedSites } from '../connect/index.ts';

const WC_SCAN_MODE: ScanMode<string> = {
  title: 'Scan a WalletConnect code',
  hint: 'Point the rear camera at the WalletConnect QR code the site shows.',
  manualLabel: 'Or paste the WalletConnect code',
  manualPlaceholder: 'wc:…',
  parse: (payload) => {
    const r = parseWcUri(payload);
    return r.ok ? { ok: true, target: r.uri } : { ok: false, error: r.error };
  },
};

/**
 * Sites connected to this wallet. WalletConnect first — pair with a site by
 * pasting or scanning its wc: code, and manage the sessions this device keeps
 * — then the sites approved in the Ferminux Wallet connect window (Revoke).
 */
export function ConnectPanel({
  wc,
  address,
  label,
  initialUri = null,
  onUriUsed,
}: {
  wc: WalletConnectApi;
  address: string;
  label: string;
  /** A wc: code scanned from Home: paired as soon as this screen opens. */
  initialUri?: string | null;
  onUriUsed?: () => void;
}) {
  const [uri, setUri] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);

  async function pair(raw: string) {
    const check = parseWcUri(raw);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await wc.start();
      if (!c) throw new Error(wc.error ?? 'WalletConnect could not start.');
      await c.pair(check.uri);
      setUri('');
      setWaiting(true);
      setTimeout(() => setWaiting(false), 15_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/already exists|pairing.*exist/i.test(msg) ? 'This code was already used. Ask the site for a fresh one.' : msg);
    } finally {
      setBusy(false);
    }
  }

  const pairRef = useRef(pair);
  pairRef.current = pair;
  useEffect(() => {
    if (!initialUri) return;
    onUriUsed?.();
    if (!wc.configured) {
      setUri(initialUri);
      return;
    }
    setUri(initialUri);
    void pairRef.current(initialUri);
    // Once per scanned code.
  }, [initialUri]);

  // Sites that chose "Ferminux Wallet" in their Connect menu and were
  // approved in the connect window. Works on every build.
  const ferminuxSites = (
    <>
      <div className="wc-sessions-head">
        <h2>Ferminux Wallet sites</h2>
      </div>
      <p className="section-sub">Sites that asked through the Connect with Ferminux Wallet window. Revoke one to cut it off at once.</p>
      <div className="list">
        <ConnectedSites />
      </div>
    </>
  );

  if (!wc.configured) {
    return (
      <div data-testid="wc-panel">
        <div className="wc-sessions-head wc-sessions-head-first">
          <h2>WalletConnect</h2>
        </div>
        <div className="list empty-state" data-testid="wc-not-configured">
          <div className="ic-wrap">
            <IconLink />
          </div>
          <div className="title">WalletConnect isn’t set up on this build</div>
          Sites that offer Ferminux Wallet connect without it. Everything else (balances, sending, receiving, NFTs) works
          normally.
          <p className="field-hint" style={{ marginTop: 12 }}>
            Operators: build with <span className="mono">VITE_WC_PROJECT_ID</span> set to a Reown project id.
          </p>
        </div>
        {ferminuxSites}
      </div>
    );
  }

  const sessions = wc.state.sessions;
  return (
    <div data-testid="wc-panel">
      <div className="panel pair-card">
        <div className="section-head" style={{ marginBottom: 4, minHeight: 0 }}>
          <h2>WalletConnect</h2>
          <span className="push" />
          {wc.status === 'starting' && <Spinner />}
        </div>
        <p className="intro-line">
          Connect any site or wallet-enabled app that offers WalletConnect. It sees{' '}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
            <Identicon address={address} size={16} />
            <strong>{label}</strong>
          </span>{' '}
          <span className="mono">{shortAddress(address)}</span>, the active account, and every signature or transaction still
          needs your confirmation here.
        </p>
        <div className="field mb-0">
          <label htmlFor="wc-uri">Connection code</label>
          <div className="input-row">
            <div className={'input-shell' + (error ? ' is-error' : '')} style={{ flex: 1, minWidth: 0 }}>
              <input
                id="wc-uri"
                className="input input-mono"
                placeholder="wc:…"
                value={uri}
                onChange={(e) => {
                  setUri(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && uri.trim() !== '') void pair(uri);
                }}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="icon-btn icon-btn-sm"
                type="button"
                onClick={() => setScanOpen(true)}
                disabled={busy}
                data-testid="wc-scan"
                aria-label="Scan a WalletConnect code"
                title="Scan"
              >
                <ScanGlyph />
              </button>
            </div>
            <button className="btn btn-primary" onClick={() => void pair(uri)} disabled={busy || uri.trim() === ''} data-testid="wc-pair">
              {busy ? <Spinner /> : 'Connect'}
            </button>
          </div>
          {error && <div className="field-error">{error}</div>}
          {waiting && !error && wc.state.proposals.length === 0 && (
            <div className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner /> Waiting for the site’s connection request…
            </div>
          )}
          {wc.status === 'error' && wc.error && <div className="field-error">WalletConnect could not start: {wc.error}</div>}
          <div className="field-hint">On the site choose WalletConnect, then copy its code or scan the QR it shows. WalletConnect v2.</div>
        </div>
      </div>

      {wc.state.notice && (
        <div className="notice" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 200px' }}>{wc.state.notice}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => wc.controller?.clearNotice()}>
            Dismiss
          </button>
        </div>
      )}

      <div className="wc-sessions-head">
        <h2>Sessions</h2>
        <span className="mono faint small">{sessions.length}</span>
      </div>
      {sessions.length === 0 ? (
        <div className="list empty-state" style={{ padding: '28px 20px' }}>
          <div className="title">No WalletConnect sessions</div>
          {wc.status === 'off' ? 'Sessions you approve are kept on this device until you disconnect them.' : 'Nothing is connected right now.'}
        </div>
      ) : (
        <div className="list">
          <ul className="row-list" data-testid="wc-sessions">
            {sessions.map((s) => {
              const other = s.addresses.length > 0 && !s.addresses.includes(address.toLowerCase());
              return (
                <li key={s.topic} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <DappIcon icon={s.dapp.icon} name={s.dapp.name} />
                  <div className="row-main">
                    <div className="row-title">{s.dapp.name}</div>
                    <div className="row-sub">
                      {s.dapp.host || s.dapp.url || 'no URL given'}
                      {other && ` · connected to ${shortAddress(s.addresses[0]!)}, not this account`}
                    </div>
                    <div className="wc-chain-list">
                      {s.chainIds.map((id) => {
                        const c = chainById(id);
                        return c ? <ChainBadge key={id} chain={c} /> : null;
                      })}
                    </div>
                  </div>
                  <div className="row-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {other && (
                      <button
                        className="btn btn-sm"
                        data-testid="wc-share-active"
                        title={`Let ${s.dapp.name} see ${shortAddress(address)} instead of ${shortAddress(s.addresses[0]!)}`}
                        onClick={() => void wc.controller?.shareAccount(s.topic, address).catch(() => undefined)}
                      >
                        Use {label} here
                      </button>
                    )}
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => void wc.controller?.disconnect(s.topic)}>
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {ferminuxSites}

      {scanOpen && (
        <ScannerModal<string>
          mode={WC_SCAN_MODE}
          onClose={() => setScanOpen(false)}
          onResult={(u) => {
            setUri(u);
            void pair(u);
          }}
        />
      )}
    </div>
  );
}
