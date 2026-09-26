import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import type { WalletConnectApi } from '../state/useWalletConnect.ts';
import { CHAIN_ID } from '../config.ts';
import { CHAINS, FERMINUX_CHAIN, chainById } from '../lib/chains.ts';
import { parseQrPayload, type QrTarget } from '../lib/qr.ts';
import { parseWcUri } from '../lib/walletconnect.ts';
import type { AssetRef } from '../lib/portfolio.ts';
import { usePortfolio } from '../state/usePortfolio.ts';
import { useLocalActivity } from '../state/useLocalActivity.ts';
import { SendPanel, type SendSelection } from './SendPanel.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';
import { LocalActivity } from './LocalActivity.tsx';
import { NftsPanel } from './NftsPanel.tsx';
import { ConnectPanel } from './ConnectPanel.tsx';
import { WcModals } from './WcModals.tsx';
import { HomeScreen } from './HomeScreen.tsx';
import { AssetScreen } from './AssetScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { ReceiveModal } from './ReceiveModal.tsx';
import { ScannerModal, type ScanMode } from './ScannerModal.tsx';
import { AppLayout } from './Shell.tsx';
import { topOf, useRoute, type Route } from './router.ts';
import type { AccountsMode } from './AccountsPanel.tsx';
import { loadSites, onSitesChange } from '../connect/index.ts';
import { onTxAnnounced } from '../lib/txSignal.ts';
import { sendProvider } from './SendPanel.tsx';
import { BackButton, ScreenHead } from './ScreenHead.tsx';

/** What the Home "Scan" button understands: a payment code, or a WalletConnect pairing code. */
type ScanResult = { kind: 'pay'; target: QrTarget } | { kind: 'wc'; uri: string };

const OTHER_CHAIN_IDS = CHAINS.filter((c) => c.id !== CHAIN_ID).map((c) => c.id);

const ANY_SCAN_MODE: ScanMode<ScanResult> = {
  title: 'Scan a code',
  hint: (
    <>
      Point the rear camera at a payment code (an address or an <span className="mono">ethereum:</span> request on any
      supported network) or at a site’s WalletConnect code.
    </>
  ),
  manualLabel: 'Or paste an address, payment link or wc: code',
  manualPlaceholder: '0x…, ethereum:0x… or wc:…',
  parse: (payload) => {
    if (/^\s*wc:/i.test(payload)) {
      const r = parseWcUri(payload);
      return r.ok ? { ok: true, target: { kind: 'wc', uri: r.uri } } : { ok: false, error: r.error };
    }
    const r = parseQrPayload(payload, CHAIN_ID, OTHER_CHAIN_IDS);
    return r.ok ? { ok: true, target: { kind: 'pay', target: r.target } } : { ok: false, error: r.error };
  },
};

const TITLES: Record<Route['name'], string | null> = {
  home: null,
  asset: 'Asset',
  send: 'Send',
  nfts: 'NFTs',
  activity: 'Activity',
  connect: 'Connect',
  settings: 'Settings',
};

export function WalletHome({
  api,
  balances,
  chain,
  wc,
  onManageAccounts,
  onLock,
  banner,
}: {
  api: AccountsApi;
  balances: BalancesApi;
  chain: ChainState;
  wc: WalletConnectApi;
  onManageAccounts: (mode?: AccountsMode) => void;
  onLock: () => void;
  banner?: ReactNode;
}) {
  const [route, go, back] = useRoute();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [pendingScan, setPendingScan] = useState<QrTarget | null>(null);
  const [pendingWc, setPendingWc] = useState<string | null>(null);
  const [sendSel, setSendSel] = useState<SendSelection>({ chainId: CHAIN_ID, asset: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [activityChain, setActivityChain] = useState<number>(CHAIN_ID);
  const [siteCount, setSiteCount] = useState(() => loadSites().length);
  useEffect(() => onSitesChange(() => setSiteCount(loadSites().length)), []);
  const connectCount = wc.state.sessions.length + siteCount;

  const active = api.active;
  const portfolio = usePortfolio(active.address);
  const local = useLocalActivity(api.remembered);

  const afterSend = (chainId: number) => {
    if (chainId === CHAIN_ID) {
      setRefreshKey((k) => k + 1);
      balances.refresh();
    }
    portfolio.refresh(chainId);
  };

  // A mint or transaction confirmed in the connect window (another window of
  // this wallet): refresh now, and again once it is in a block.
  const [nftKey, setNftKey] = useState(0);
  const latest = useRef({ afterSend, chain });
  latest.current = { afterSend, chain };
  useEffect(
    () =>
      onTxAnnounced((t) => {
        latest.current.afterSend(t.chainId);
        const def = chainById(t.chainId);
        if (!def) return;
        void sendProvider(def, latest.current.chain)
          .then((p) => p.waitForTransaction(t.hash, 1, 120_000))
          .then(() => {
            latest.current.afterSend(t.chainId);
            if (t.chainId === CHAIN_ID) setNftKey((k) => k + 1); // a mint shows up in NFTs
          }, () => undefined);
      }),
    [],
  );

  const openSend = (sel: SendSelection) => {
    setSendSel(sel);
    go({ name: 'send' });
  };
  const openAsset = (a: AssetRef) => go({ name: 'asset', chainId: a.chainId, address: a.address });

  let screen: JSX.Element;
  switch (route.name) {
    case 'home':
      screen = (
        <HomeScreen
          api={api}
          balances={balances}
          portfolio={portfolio}
          onSend={() => openSend({ chainId: CHAIN_ID, asset: null })}
          onReceive={() => setReceiveOpen(true)}
          onScan={() => setScanOpen(true)}
          onOpenAsset={openAsset}
          onManageAccounts={() => onManageAccounts('list')}
        />
      );
      break;
    case 'asset':
      screen = (
        <AssetScreen
          portfolio={portfolio}
          chainId={route.chainId}
          address={route.address}
          onBack={back}
          onSend={(a) => openSend({ chainId: a.chainId, asset: a.address })}
          onReceive={() => setReceiveOpen(true)}
          onRemoved={() => go({ name: 'home' }, { replace: true })}
          onRefresh={balances.refresh}
        />
      );
      break;
    case 'send':
      screen = (
        <>
          <BackButton onClick={back} label="Back" />
          <ScreenHead title="Send" />
          <SendPanel
            // Remount on account switch so a half-filled form never carries
            // over to a different sender.
            key={active.id}
            api={api}
            chain={chain}
            portfolio={portfolio}
            selection={sendSel}
            onSelectionChange={setSendSel}
            onSent={afterSend}
            onRecord={local.record}
            onStatus={local.setStatus}
            initialScan={pendingScan}
            onScanUsed={() => setPendingScan(null)}
          />
        </>
      );
      break;
    case 'nfts':
      screen = (
        <>
          <ScreenHead title="NFTs" />
          <NftsPanel
            key={active.id}
            api={api}
            chain={chain}
            portfolio={portfolio}
            refreshKey={nftKey}
            view={route.view ?? 'yours'}
            onView={(v) => go(v === 'mint' ? { name: 'nfts', view: 'mint' } : { name: 'nfts' }, { replace: true })}
            onReceive={() => setReceiveOpen(true)}
            onSent={afterSend}
          />
        </>
      );
      break;
    case 'activity': {
      const activityDef = chainById(activityChain) ?? FERMINUX_CHAIN;
      screen = (
        <>
          <ScreenHead title="Activity" />
          <div className="chips activity-chain-bar" role="group" aria-label="Network" style={{ marginBottom: 16 }}>
            {CHAINS.map((c) => (
              <button
                key={c.id}
                className="chip"
                aria-pressed={activityChain === c.id}
                data-testid={`activity-chain-${c.id}`}
                onClick={() => setActivityChain(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
          {activityDef.id === CHAIN_ID ? (
            <ActivityPanel key={active.id} address={active.address} label={active.label} refreshKey={refreshKey} />
          ) : (
            <LocalActivity chain={activityDef} list={local.list} address={active.address} label={active.label} />
          )}
        </>
      );
      break;
    }
    case 'connect':
      screen = (
        <>
          <ScreenHead title="Connect" />
          <ConnectPanel wc={wc} address={active.address} label={active.label} initialUri={pendingWc} onUriUsed={() => setPendingWc(null)} />
        </>
      );
      break;
    case 'settings':
      screen = (
        <>
          <ScreenHead title="Settings" />
          <SettingsScreen api={api} balances={balances} chain={chain} onManageAccounts={onManageAccounts} onLock={onLock} />
        </>
      );
      break;
  }

  return (
    <AppLayout
      current={topOf(route)}
      onNavigate={(id) => go({ name: id })}
      connectCount={connectCount}
      chain={chain}
      api={api}
      balances={balances}
      onManage={() => onManageAccounts('list')}
      onLock={onLock}
      title={TITLES[route.name]}
      banner={banner}
    >
      <div key={route.name + (route.name === 'asset' ? `${route.chainId}${route.address}` : '')} className={'page view-enter' + (route.name === 'home' || route.name === 'nfts' ? ' page-wide' : '')}>
        {screen}
      </div>

      {receiveOpen && <ReceiveModal address={active.address} label={active.label} onClose={() => setReceiveOpen(false)} />}

      {scanOpen && (
        <ScannerModal<ScanResult>
          mode={ANY_SCAN_MODE}
          onClose={() => setScanOpen(false)}
          onResult={(r) => {
            setScanOpen(false);
            if (r.kind === 'wc') {
              setPendingWc(r.uri);
              go({ name: 'connect' });
            } else {
              setPendingScan(r.target);
              go({ name: 'send' });
            }
          }}
        />
      )}

      <WcModals wc={wc} api={api} home={chain} portfolio={portfolio} onRecord={local.record} onStatus={local.setStatus} />
    </AppLayout>
  );
}
