import { useCallback, useEffect, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { RPC_URLS, CHAIN_ID, REFRESH_MS } from './config.ts';
import { connectRpc } from './lib/rpc.ts';
import { useAccountSession } from './state/useAccounts.ts';
import { useBalances } from './state/useBalances.ts';
import { forgetWalletConnect, useWalletConnect } from './state/useWalletConnect.ts';
import { hasStoredVault } from './state/storage.ts';
import { Onboarding } from './views/Onboarding.tsx';
import { Unlock } from './views/Unlock.tsx';
import { WalletHome } from './views/WalletHome.tsx';
import { AccountsPanel, type AccountsMode } from './views/AccountsPanel.tsx';
import { GateFrame } from './views/Shell.tsx';
import { useLockMs } from './views/prefs.ts';
import { useIdleLock } from './state/useIdleLock.ts';
import { announceLock, onLockAnnounced } from './lib/lockSignal.ts';
import { useWalletConnectLinks } from './platform/react.ts';

export interface ChainState {
  provider: JsonRpcProvider | null;
  rpcUrl: string | null;
  status: 'connecting' | 'ok' | 'error';
  blockNumber: number | null;
  baseFee: bigint | null;
  retry: () => void;
}

function useChain(): ChainState {
  const [conn, setConn] = useState<{
    provider: JsonRpcProvider | null;
    rpcUrl: string | null;
    status: 'connecting' | 'ok' | 'error';
  }>({ provider: null, rpcUrl: null, status: 'connecting' });
  const [head, setHead] = useState<{ blockNumber: number | null; baseFee: bigint | null }>({
    blockNumber: null,
    baseFee: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setConn((c) => ({ ...c, status: 'connecting' }));
    connectRpc(RPC_URLS, CHAIN_ID)
      .then(({ provider, url }) => {
        if (!alive) {
          provider.destroy();
          return;
        }
        setConn({ provider, rpcUrl: url, status: 'ok' });
      })
      .catch(() => {
        if (alive) setConn({ provider: null, rpcUrl: null, status: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Poll chain head for the status footer.
  useEffect(() => {
    const p = conn.provider;
    if (!p) return;
    let alive = true;
    let failures = 0;
    const tick = async () => {
      try {
        const b = await p.getBlock('latest');
        if (alive && b) {
          failures = 0;
          setHead({ blockNumber: b.number, baseFee: b.baseFeePerGas ?? null });
        }
      } catch {
        failures += 1;
        if (alive && failures >= 2) setAttempt((a) => a + 1); // re-run endpoint fallback
      }
    };
    void tick();
    const id = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [conn.provider]);

  // Auto-retry while unreachable.
  useEffect(() => {
    if (conn.status !== 'error') return;
    const id = setTimeout(() => setAttempt((a) => a + 1), 10_000);
    return () => clearTimeout(id);
  }, [conn.status, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...conn, ...head, retry };
}

const EMPTY_ADDRESSES: string[] = [];

export function App() {
  const chain = useChain();
  const session = useAccountSession();
  const { api, set, vault, lock: dropKeys, forget } = session;
  const [notice, setNotice] = useState<string | null>(null);
  const [accountsOpen, setAccountsOpen] = useState<AccountsMode | null>(null);

  // Every account's balance, refreshed together in one batched request.
  const balances = useBalances(chain.rpcUrl, chain.provider, api?.addresses ?? EMPTY_ADDRESSES);

  // WalletConnect answers for the active account only, and for nobody while locked.
  const wc = useWalletConnect(set !== null && api !== null ? api.active.address : null, api?.remembered ?? vault !== null);

  // wc: / ferminuxwallet:// / https://wallet.ferminux.net/wc links (app links, and the web /wc page) pair here.
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  useWalletConnectLinks(wc, setLinkNotice);

  const lock = useCallback(() => {
    setAccountsOpen(null);
    dropKeys();
    // Not remembered: nothing of this session outlives the lock, and
    // WalletConnect's sessions name the address (IndexedDB included).
    if (!hasStoredVault()) void forgetWalletConnect();
    // A stored wallet's unlock screen says what is needed; only a session-only
    // wallet needs telling that its keys are gone.
    setNotice(
      hasStoredVault()
        ? null
        : 'Session locked. Keys are kept in memory only — unlock, or import your wallet again, to continue.',
    );
  }, [dropKeys]);

  // Idle auto-lock (15 min without interaction by default; Settings → Security).
  // Also judged when the tab or app comes back from the background: state/useIdleLock.ts.
  useIdleLock(set !== null, useLockMs(), lock);

  // Lock pressed here locks the wallet, not one tab: every other tab and
  // connect window holding keys from the stored vault drops them too.
  const lockByHand = useCallback(() => {
    announceLock();
    lock();
  }, [lock]);
  const fromVault = useRef(false);
  fromVault.current = set !== null && vault !== null;
  useEffect(
    () =>
      onLockAnnounced(() => {
        if (fromVault.current) lock();
      }),
    [lock],
  );

  const unlocked = set !== null && api !== null;
  const phase: 'unlocked' | 'locked' | 'onboarding' = unlocked ? 'unlocked' : vault ? 'locked' : 'onboarding';

  // A deep link that could not pair (platform/react.ts), shown on any screen.
  const banner = linkNotice ? (
    <div className="notice notice-warn" role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ flex: '1 1 220px' }}>{linkNotice}</span>
      <button className="btn btn-sm" onClick={() => setLinkNotice(null)}>
        Dismiss
      </button>
    </div>
  ) : null;

  return (
    <>
      {phase === 'unlocked' && api ? (
        <WalletHome
          api={api}
          balances={balances}
          chain={chain}
          wc={wc}
          onManageAccounts={(mode) => setAccountsOpen(mode ?? 'list')}
          onLock={lockByHand}
          banner={banner}
        />
      ) : (
        <GateFrame chain={chain} banner={banner}>
          {phase === 'onboarding' && (
            <Onboarding
              notice={notice ?? undefined}
              onOpen={async (accountSet, options) => {
                setNotice(null);
                await session.open(accountSet, options);
              }}
            />
          )}
          {phase === 'locked' && vault && (
            <Unlock
              vault={vault}
              notice={notice ?? undefined}
              onUnlock={session.unlock}
              onForgotten={() => {
                setNotice(null);
                forget();
                void forgetWalletConnect();
              }}
            />
          )}
        </GateFrame>
      )}

      {accountsOpen && api && (
        <AccountsPanel api={api} balances={balances} initialMode={accountsOpen} onClose={() => setAccountsOpen(null)} />
      )}
    </>
  );
}
