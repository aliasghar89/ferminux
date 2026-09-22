import { useMemo, useState } from 'react';
import {
  CHAINS,
  DOCS_URL,
  HOME_CHAIN_KEY,
  chainByKey,
  isChainLive,
  liveChains,
  type ChainConfig,
} from './config.ts';
import { shortAddress } from './lib/amounts.ts';
import { useWallet } from './state/wallet.ts';
import { useBridgeData } from './state/useBridgeData.ts';
import { useTransfers } from './state/useTransfers.ts';
import { useNow } from './state/useNow.ts';
import { useRelayerStatus } from './state/useRelayerStatus.ts';
import { RiskNotice } from './components/RiskNotice.tsx';
import { ChainHealth } from './components/ChainHealth.tsx';
import { Spinner } from './components/ui.tsx';
import { RouteSelector } from './views/RouteSelector.tsx';
import { TransferForm } from './views/TransferForm.tsx';
import { ActiveTransfers, HistoryPanel } from './views/TransferPanels.tsx';

function defaultRoute(): { src: ChainConfig; dst: ChainConfig } | null {
  const live = liveChains();
  if (live.length < 2) return null;
  const home = live.find((c) => c.key === HOME_CHAIN_KEY) ?? live[0];
  const other = live.find((c) => c.key !== home.key)!;
  return { src: home, dst: other };
}

export function App() {
  const wallet = useWallet();
  const transfers = useTransfers();
  const now = useNow(5000);
  const relayer = useRelayerStatus();
  const initial = useMemo(defaultRoute, []);
  const [route, setRoute] = useState(initial);

  const src = route?.src ?? null;
  const dst = route?.dst ?? null;
  const data = useBridgeData(src, dst);

  const capEntry = data.routes[0] ?? null;

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Ferminux
            <span className="brand-sub">Bridge</span>
          </span>
          <span className="header-spacer" />
          {src && (
            <span className="net-pill num" title={`${src.name} · chain ${src.chainId}`}>
              <span
                className={
                  'dot ' +
                  (data.status === 'ready' ? 'dot-ok' : data.status === 'error' ? 'dot-bad' : 'dot-wait')
                }
              />
              {data.status === 'ready' ? src.short : data.status === 'error' ? 'RPC unreachable' : 'Connecting…'}
            </span>
          )}
          {wallet.status === 'connected' && wallet.address ? (
            <span className="net-pill mono" title={wallet.address}>
              <span className={'dot ' + (wallet.chainId === src?.chainId ? 'dot-ok' : 'dot-warn')} />
              {shortAddress(wallet.address)}
            </span>
          ) : (
            <button
              className="btn btn-sm"
              onClick={() => void wallet.connect()}
              disabled={wallet.status === 'connecting' || wallet.status === 'unavailable'}
            >
              {wallet.status === 'connecting' ? (
                <>
                  <Spinner /> Connecting
                </>
              ) : wallet.status === 'unavailable' ? (
                'No wallet'
              ) : (
                'Connect'
              )}
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        <h1 className="page-title">Bridge assets to and from Ferminux</h1>
        <p className="page-sub">
          Lock-and-mint in one direction, burn-and-release in the other. The same contract runs on every chain; the
          asset list, the fee and the limits below are read live from it.
        </p>

        <RiskNotice
          srcConfig={data.srcConfig}
          srcChainName={src?.name ?? 'the source chain'}
          cap={capEntry ? { maxPerTransfer: capEntry.maxPerTransfer, dailyCap: capEntry.dailyCap } : null}
          capSymbol={capEntry?.meta.symbol ?? null}
          capDecimals={capEntry?.meta.decimals ?? 18}
        />

        {wallet.error && (
          <div className="notice notice-danger" role="alert">
            {wallet.error}{' '}
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={wallet.clearError}>
              Dismiss
            </button>
          </div>
        )}

        {!route || !src || !dst ? (
          <NotDeployedYet />
        ) : (
          <>
            <section className="panel">
              <div className="panel-body">
                <RouteSelector
                  src={src}
                  dst={dst}
                  disabled={false}
                  onChange={(nextSrc, nextDst) => setRoute({ src: nextSrc, dst: nextDst })}
                />
              </div>
              <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
                {data.status === 'loading' && (
                  <p className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                    <Spinner /> Reading the bridge registry on {src.name} and {dst.name}…
                  </p>
                )}
                {data.status === 'error' && (
                  <div className="notice notice-danger" style={{ marginBottom: 0 }} role="alert">
                    <p>Could not read the bridges on this route: {data.error}</p>
                    <button className="btn btn-sm" onClick={data.reload}>
                      Retry
                    </button>
                  </div>
                )}
                {data.status === 'ready' && (
                  <>
                    {data.srcConfig?.paused && (
                      <div className="notice notice-danger" role="alert">
                        The bridge on {src.name} is <strong>paused</strong>. No transfer can be sent until the owner
                        multisig unpauses it.
                      </div>
                    )}
                    {data.dstConfig?.paused && (
                      <div className="notice notice-danger" role="alert">
                        The bridge on {dst.name} is <strong>paused</strong>. A transfer sent now would be locked on{' '}
                        {src.name} until it resumes.
                      </div>
                    )}
                    <ChainHealth chain={src} status={relayer.status} now={now} statusError={relayer.settled ? relayer.error : null} />
                    <TransferForm
                      src={src}
                      dst={dst}
                      data={data}
                      wallet={wallet}
                      onSent={transfers.add}
                      liveness={relayer.status}
                    />
                  </>
                )}
              </div>
              {data.status === 'ready' && data.srcConfig && data.dstConfig && (
                <div className="panel-foot num">
                  {src.short} bridge {data.srcConfig.threshold}-of-{data.srcConfig.validatorCount} ·{' '}
                  {dst.short} bridge {data.dstConfig.threshold}-of-{data.dstConfig.validatorCount} · timelock{' '}
                  {Math.round(data.srcConfig.timelockDelaySeconds / 3600)} h
                </div>
              )}
            </section>

            <ActiveTransfers
              records={transfers.records}
              statuses={transfers.statuses}
              now={now}
              ephemeral={transfers.ephemeral}
              liveness={relayer.status}
            />

            <HistoryPanel
              records={transfers.records}
              statuses={transfers.statuses}
              now={now}
              onClear={() => {
                for (const r of transfers.records) {
                  if (r.phase === 'complete' || r.phase === 'reverted' || r.phase === 'unverifiable') {
                    transfers.remove(r.txHash);
                  }
                }
              }}
            />
          </>
        )}
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <span className="footer-item">
            {liveChains().length} of {CHAINS.length} chains live
          </span>
          {src && (
            <span className="footer-item">
              <a href={src.explorerUrl} target="_blank" rel="noreferrer noopener">
                {src.short} explorer ↗
              </a>
            </span>
          )}
          {dst && (
            <span className="footer-item">
              <a href={dst.explorerUrl} target="_blank" rel="noreferrer noopener">
                {dst.short} explorer ↗
              </a>
            </span>
          )}
          <span className="footer-item" style={{ marginLeft: 'auto' }}>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
              Bridge docs ↗
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}

/**
 * The shipped default: no bridge addresses configured yet. Say so plainly and
 * show exactly which chains are waiting on a deployment, rather than rendering
 * a form that could never submit.
 */
function NotDeployedYet() {
  const home = chainByKey(HOME_CHAIN_KEY);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Bridge deployments</h2>
      </div>
      <div className="panel-body">
        <div className="notice notice-warn" style={{ marginBottom: 18 }}>
          At least two chains need a deployed bridge before a route exists. Set the contract address for each chain at
          build time (<span className="mono">VITE_BRIDGE_&lt;CHAIN&gt;</span>) and rebuild this app.
        </div>
        <table className="kv">
          <tbody>
            {CHAINS.map((c) => (
              <tr key={c.key}>
                <th>
                  {c.name} · {c.chainId}
                </th>
                <td>
                  {isChainLive(c) ? (
                    <span className="mono">{c.bridgeAddress}</span>
                  ) : (
                    <span className="muted">not deployed — set after deployment</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {home && (
          <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
            Home chain: {home.name} ({home.chainId}), native coin {home.native.symbol}. RPC {home.rpcUrls[0]}.
          </p>
        )}
      </div>
    </section>
  );
}
