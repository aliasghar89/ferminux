import { useCallback, useMemo, useState } from 'react';
import { DEX_ADDRESSES, isConfigured, missingAddresses } from './config.ts';
import { MobileHandoff } from './components/MobileHandoff.tsx';
import { ConnectChooser } from './components/ConnectChooser.tsx';
import { Shell } from './components/Shell.tsx';
import { Modal, Notice } from './components/ui.tsx';
import { parseDexLink } from './lib/deeplink.ts';
import { listedTokens } from './lib/tokenlist.ts';
import { tokenKey, type TokenInfo } from './lib/tokens.ts';
import { BRIDGE_TAB_ENABLED } from './lib/bridgeChains.ts';
import { useActivity } from './state/useActivity.ts';
import { useChain } from './state/useChain.ts';
import { useCustomTokens } from './state/useCustomTokens.ts';
import { useMarket } from './state/useMarket.ts';
import { usePools } from './state/usePools.ts';
import { usePositions } from './state/usePositions.ts';
import { useRoute, type Page, type RouteState } from './state/useRoute.ts';
import { useSettings } from './state/useSettings.ts';
import { useTokenBalances } from './state/useTokenBalances.ts';
import { useWallet } from './state/useWallet.ts';
import { ActivityView } from './views/ActivityView.tsx';
import { BridgePanel } from './views/BridgePanel.tsx';
import { ChartsView } from './views/ChartsView.tsx';
import { LiquidityView } from './views/LiquidityView.tsx';
import { PoolsView } from './views/PoolsView.tsx';
import { SwapView } from './views/SwapView.tsx';

export function App() {
  const chain = useChain();
  const wallet = useWallet();
  const pools = usePools(chain.provider, chain.blockTimestamp);
  const market = useMarket(chain.provider, pools, chain.blockNumber, chain.blockTimestamp);
  const { customTokens, addCustomToken } = useCustomTokens();
  const [route, navigateTo] = useRoute();
  const [settings, setSettings] = useSettings();
  const [phoneOpen, setPhoneOpen] = useState(false);
  // ?inputCurrency=…&outputCurrency=… — how ferminux.net and ferminux.com open a swap here
  const link = useMemo(() => parseDexLink(window.location.search), []);

  // FMX and the registry's tokens first, then every pool token, then anything imported by hand.
  const tokens: TokenInfo[] = useMemo(() => {
    const merged = new Map<string, TokenInfo>();
    if (isConfigured()) for (const t of listedTokens(DEX_ADDRESSES.wfmx)) merged.set(tokenKey(t), t);
    for (const t of pools.tokens) if (!merged.has(tokenKey(t))) merged.set(tokenKey(t), t);
    for (const t of customTokens) if (!merged.has(tokenKey(t))) merged.set(tokenKey(t), t);
    return [...merged.values()];
  }, [pools.tokens, customTokens]);

  const { balances, refresh: refreshBalances } = useTokenBalances(chain.provider, wallet.address, tokens);
  const positions = usePositions(chain.provider, pools.pairs, wallet.address);
  const activity = useActivity(chain.provider, wallet.address, pools, tokens, market, chain.blockNumber, route.page === 'activity');

  const onChainChanged = useCallback(() => {
    pools.reload();
    refreshBalances();
  }, [pools, refreshBalances]);

  const navigate = useCallback(
    (to: Partial<RouteState> & { page: Page }) => navigateTo(to),
    [navigateTo],
  );

  const fmxBalance = balances.get('native');
  const page: Page = route.page === 'bridge' && !BRIDGE_TAB_ENABLED ? 'swap' : route.page;

  let body;
  if (!isConfigured()) body = <NotConfigured />;
  else if (page === 'swap')
    body = (
      <SwapView
        provider={chain.provider}
        pools={pools}
        market={market}
        wallet={wallet}
        tokens={tokens}
        balances={balances}
        settings={settings}
        onSettings={setSettings}
        link={link}
        onImportToken={addCustomToken}
        onChainChanged={onChainChanged}
        navigate={navigate}
      />
    );
  else if (page === 'pools')
    body = (
      <PoolsView
        route={route}
        pools={pools}
        market={market}
        positions={positions}
        chainTime={chain.blockTimestamp}
        account={wallet.address}
        navigate={navigate}
      />
    );
  else if (page === 'liquidity')
    body = (
      <LiquidityView
        key={`${route.pairA ?? ''}-${route.pairB ?? ''}`}
        provider={chain.provider}
        pools={pools}
        market={market}
        wallet={wallet}
        tokens={tokens}
        balances={balances}
        positions={positions}
        settings={settings}
        onSettings={setSettings}
        pair={{ a: route.pairA, b: route.pairB }}
        chainTime={chain.blockTimestamp}
        onImportToken={addCustomToken}
        onChainChanged={() => {
          onChainChanged();
          positions.reload();
        }}
      />
    );
  else if (page === 'charts' || page === 'analytics') body = <ChartsView page={page} market={market} pools={pools} navigate={navigate} />;
  else if (page === 'activity') body = <ActivityView wallet={wallet} activity={activity} now={market.now} />;
  else
    body = (
      <div className="page page-narrow">
        <BridgePanel wallet={wallet} />
      </div>
    );

  return (
    <>
      <Shell
        page={page}
        navigate={(p) => navigate({ page: p })}
        chain={chain}
        wallet={wallet}
        fmxBalance={fmxBalance}
        extraNav={BRIDGE_TAB_ENABLED ? { page: 'bridge', label: 'Bridge' } : null}
      >
        {wallet.error && !wallet.chooserOpen && (
          <div className="page">
            <Notice kind="danger" role="alert">
              {wallet.error}
            </Notice>
          </div>
        )}
        {wallet.status && (
          <div className="page">
            <Notice role="status">{wallet.status}</Notice>
          </div>
        )}
        {body}
      </Shell>

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
    </>
  );
}

/**
 * Only a build that blanked the addresses lands here (the defaults are the
 * chain-3961 deployment). Guessing an address would be worse than saying so.
 */
function NotConfigured() {
  return (
    <div className="page page-narrow">
      <section className="card" data-testid="not-configured">
        <div className="card-head">
          <h1 className="card-title">Not configured</h1>
        </div>
        <div className="card-pad">
          <Notice kind="warn">
            This build has no DEX contract addresses, so there is nothing to read. It was built with the addresses overridden
            to blank; the default build uses the Ferminux DEX deployed on chain 3961.
          </Notice>
          <p className="small">Set these before building, or edit src/config.ts:</p>
          <ul className="rows rows-flush">
            {missingAddresses().map((label) => (
              <li key={label} className="row">
                <span className="row-title mono">{label}</span>
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
    </div>
  );
}
