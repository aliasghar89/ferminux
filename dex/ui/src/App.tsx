import { useMemo, useState } from 'react';
import {
  CHAIN_ID,
  DEX_ADDRESSES,
  EXPLORER_URL,
  PRELOADED_TOKENS,
  isConfigured,
  missingAddresses,
} from './config.ts';
import { MobileHandoff } from './components/MobileHandoff.tsx';
import { ConnectChooser } from './components/ConnectChooser.tsx';
import { AddressLink, Modal, Notice, Spinner } from './components/ui.tsx';
import { shortAddress } from './lib/amounts.ts';
import { parseDexLink } from './lib/deeplink.ts';
import { tokenKey, type TokenInfo } from './lib/tokens.ts';
import { useChain } from './state/useChain.ts';
import { useCustomTokens } from './state/useCustomTokens.ts';
import { usePools } from './state/usePools.ts';
import { useTokenBalances } from './state/useTokenBalances.ts';
import { useWallet } from './state/useWallet.ts';
import { AddLiquidity } from './views/AddLiquidity.tsx';
import { FmxMarkets } from './views/FmxMarkets.tsx';
import { PoolsPanel } from './views/PoolsPanel.tsx';
import { PositionsPanel } from './views/PositionsPanel.tsx';
import { SwapPanel } from './views/SwapPanel.tsx';
import { BridgePanel } from './views/BridgePanel.tsx';
import { BRIDGE_TAB_ENABLED } from './lib/bridgeChains.ts';

type Tab = 'swap' | 'liquidity' | 'pools' | 'bridge';

export function App() {
  const chain = useChain();
  const wallet = useWallet();
  const pools = usePools(chain.provider, chain.blockTimestamp);
  const { customTokens, addCustomToken } = useCustomTokens();
  // ?inputCurrency=…&outputCurrency=…&tab=… — how ferminux.net and ferminux.com open a swap here
  const link = useMemo(() => parseDexLink(window.location.search), []);
  const [tab, setTab] = useState<Tab>(link.tab ?? 'swap');
  const [phoneOpen, setPhoneOpen] = useState(false);

  // Pool tokens + preloaded + anything imported by hand, de-duplicated.
  const tokens: TokenInfo[] = useMemo(() => {
    const merged = new Map<string, TokenInfo>();
    for (const t of pools.tokens) merged.set(tokenKey(t), t);
    for (const t of customTokens) if (!merged.has(tokenKey(t))) merged.set(tokenKey(t), t);
    return [...merged.values()];
  }, [pools.tokens, customTokens]);

  const { balances, refresh: refreshBalances } = useTokenBalances(chain.provider, wallet.address, tokens);

  // Tokens the router may route through: WFMX first, then the preloaded list.
  const bases = useMemo(() => {
    const list: string[] = [];
    if (isConfigured()) list.push(DEX_ADDRESSES.wfmx);
    for (const t of PRELOADED_TOKENS) list.push(t.address);
    return list;
  }, []);

  const onChainChanged = () => {
    pools.reload();
    refreshBalances();
  };

  const configured = isConfigured();

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Ferminux
            <span className="brand-sub">DEX</span>
          </span>
          <span className="header-spacer" />
          <span className="net-pill num" title={chain.rpcUrl ?? 'not connected'}>
            <span
              className={
                'dot ' + (chain.status === 'ok' ? 'dot-ok' : chain.status === 'error' ? 'dot-bad' : 'dot-wait')
              }
            />
            <span className="net-label">
              {chain.status === 'ok'
                ? `Ferminux · ${CHAIN_ID}`
                : chain.status === 'error'
                  ? 'RPC unreachable'
                  : 'Connecting…'}
            </span>
          </span>
          {wallet.address ? (
            <button className="btn btn-sm mono" onClick={wallet.disconnect} title={`${wallet.address} — click to disconnect`}>
              {shortAddress(wallet.address)}
            </button>
          ) : (
            <button className="btn btn-sm" data-testid="header-connect" onClick={wallet.connect} disabled={wallet.connecting}>
              Connect
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        {chain.status === 'error' && (
          <Notice kind="danger" role="alert">
            Cannot reach any Ferminux RPC endpoint. Retrying automatically…{' '}
            <button className="btn btn-sm" onClick={chain.retry} style={{ marginLeft: 8 }}>
              Retry now
            </button>
          </Notice>
        )}

        {wallet.error && !wallet.chooserOpen && (
          <Notice kind="danger" role="alert">
            {wallet.error}
          </Notice>
        )}

        {wallet.status && (
          <Notice role="status">
            <Spinner /> {wallet.status}
          </Notice>
        )}

        {wallet.wallet && wallet.wrongChain && !wallet.status && (
          <Notice kind="warn">
            Your wallet is on chain {wallet.wallet.chainId}, not Ferminux ({CHAIN_ID}). Reading works; signing does
            not.{' '}
            <button className="btn btn-sm" onClick={() => void wallet.switchChain()} style={{ marginLeft: 8 }}>
              Switch network
            </button>
          </Notice>
        )}

        {!configured ? (
          <NotConfigured />
        ) : (
          <>
            <nav className="tabs" role="tablist" aria-label="Sections">
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'swap'}
                onClick={() => setTab('swap')}
              >
                Swap
              </button>
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'liquidity'}
                onClick={() => setTab('liquidity')}
              >
                Liquidity
              </button>
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'pools'}
                onClick={() => setTab('pools')}
              >
                Pools
              </button>
              {/* Off unless the build opts in (VITE_ENABLE_BRIDGE=1): see
                  BRIDGE_TAB_ENABLED in lib/bridgeChains.ts. */}
              {BRIDGE_TAB_ENABLED && (
                <button
                  className="tab"
                  role="tab"
                  aria-selected={tab === 'bridge'}
                  onClick={() => setTab('bridge')}
                >
                  Bridge
                </button>
              )}
            </nav>

            <div className="tab-body">
              {tab === 'swap' && (
                <div className="column-narrow">
                  <SwapPanel
                    provider={chain.provider}
                    pools={pools}
                    wallet={wallet}
                    tokens={tokens}
                    balances={balances}
                    bases={bases}
                    link={link}
                    onImportToken={addCustomToken}
                    onChainChanged={onChainChanged}
                  />
                  <FmxMarkets pools={pools} />
                </div>
              )}
              {tab === 'liquidity' && (
                <>
                  <AddLiquidity
                    provider={chain.provider}
                    pools={pools}
                    wallet={wallet}
                    tokens={tokens}
                    balances={balances}
                    onImportToken={addCustomToken}
                    onChainChanged={onChainChanged}
                  />
                  <PositionsPanel
                    provider={chain.provider}
                    pools={pools}
                    wallet={wallet}
                    chainTimestamp={chain.blockTimestamp}
                    onChainChanged={onChainChanged}
                  />
                </>
              )}
              {tab === 'pools' && (
                <>
                  <FmxMarkets pools={pools} />
                  <PoolsPanel pools={pools} chainTimestamp={chain.blockTimestamp} />
                </>
              )}
              {BRIDGE_TAB_ENABLED && tab === 'bridge' && <BridgePanel wallet={wallet} />}
            </div>
          </>
        )}
      </main>

      {wallet.chooserOpen && (
        <ConnectChooser
          wallet={wallet}
          onHandoff={() => {
            wallet.closeChooser();
            setPhoneOpen(true);
          }}
        />
      )}

      {phoneOpen && (
        <Modal title="Open on your phone" onClose={() => setPhoneOpen(false)}>
          <MobileHandoff hasInjected={wallet.hasInjected} variant="modal" />
        </Modal>
      )}

      <footer className="app-footer">
        <div className="app-footer-inner">
          <span className="footer-item">
            <span
              className={
                'dot ' + (chain.status === 'ok' ? 'dot-ok' : chain.status === 'error' ? 'dot-bad' : 'dot-wait')
              }
            />
            {chain.status === 'ok' ? 'Connected' : chain.status === 'error' ? 'Offline' : 'Connecting'}
          </span>
          <span className="footer-item">
            Block {chain.blockNumber !== null ? chain.blockNumber.toLocaleString('en-US') : '—'}
          </span>
          {configured && (
            <span className="footer-item">
              Router <AddressLink address={DEX_ADDRESSES.router} />
            </span>
          )}
          {chain.rpcUrl && (
            <span className="footer-item" title={chain.rpcUrl}>
              {new URL(chain.rpcUrl).host}
            </span>
          )}
          <span className="footer-item" style={{ marginLeft: 'auto' }}>
            <a href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
              Explorer ↗
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}

/**
 * Only a build that blanked the addresses lands here (the defaults are the
 * chain-3961 deployment). Guessing an address would be worse than saying so.
 */
function NotConfigured() {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Not configured</h2>
      </div>
      <div className="panel-body">
        <Notice kind="warn">
          This build has no DEX contract addresses, so there is nothing to read. It was built with the addresses
          overridden to blank; the default build uses the Ferminux AMM deployed on chain 3961.
        </Notice>
        <p className="small">Set these before building, or edit <code>src/config.ts</code>:</p>
        <ul className="row-list">
          {missingAddresses().map((label) => (
            <li key={label}>
              <span className="row-main">
                <span className="row-title mono">{label}</span>
              </span>
            </li>
          ))}
        </ul>
        <pre className="code-block">
{`VITE_FACTORY_ADDRESS=0x… \\
VITE_ROUTER_ADDRESS=0x… \\
VITE_WFMX_ADDRESS=0x… \\
VITE_LOCKER_ADDRESS=0x… \\
  npm run build`}
        </pre>
      </div>
    </section>
  );
}
