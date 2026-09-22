import { useCallback, useEffect, useRef, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { RPC_URLS, CHAIN_ID, EXPLORER_URL, IDLE_LOCK_MS, REFRESH_MS } from './config.ts';
import { connectRpc } from './lib/rpc.ts';
import { formatGwei } from './lib/validate.ts';
import { useAccountSession } from './state/useAccounts.ts';
import { useBalances } from './state/useBalances.ts';
import { Onboarding } from './views/Onboarding.tsx';
import { Unlock } from './views/Unlock.tsx';
import { WalletHome } from './views/WalletHome.tsx';
import { AccountSwitcher } from './views/AccountSwitcher.tsx';
import { AccountsPanel } from './views/AccountsPanel.tsx';

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
  const [accountsOpen, setAccountsOpen] = useState(false);

  // Every account's balance, refreshed together in one batched request.
  const balances = useBalances(chain.rpcUrl, chain.provider, api?.addresses ?? EMPTY_ADDRESSES);

  const lock = useCallback(() => {
    setAccountsOpen(false);
    dropKeys();
    setNotice(
      'Session locked. Keys are kept in memory only — unlock, or import your wallet again, to continue.',
    );
  }, [dropKeys]);

  // Idle auto-lock (15 min without interaction).
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    if (!set) return;
    lastActivity.current = Date.now();
    const bump = () => {
      lastActivity.current = Date.now();
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    const check = setInterval(() => {
      if (Date.now() - lastActivity.current >= IDLE_LOCK_MS) lock();
    }, 15_000);
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump);
      clearInterval(check);
    };
  }, [set, lock]);

  const unlocked = set !== null && api !== null;
  const phase: 'unlocked' | 'locked' | 'onboarding' = unlocked ? 'unlocked' : vault ? 'locked' : 'onboarding';

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Ferminux
            <span className="brand-sub">Wallet</span>
          </span>
          <span className="header-spacer" />
          {unlocked && api && (
            <AccountSwitcher api={api} balances={balances} onManage={() => setAccountsOpen(true)} />
          )}
          <span className="net-pill num" title={chain.rpcUrl ?? 'not connected'}>
            <span
              className={
                'dot ' + (chain.status === 'ok' ? 'dot-ok' : chain.status === 'error' ? 'dot-bad' : 'dot-wait')
              }
            />
            {/* The label collapses to the status dot on a narrow header so the
                account switcher and Lock always stay reachable. */}
            <span className="net-label">
              {chain.status === 'ok'
                ? `Ferminux · ${CHAIN_ID}`
                : chain.status === 'error'
                  ? 'RPC unreachable'
                  : 'Connecting…'}
            </span>
          </span>
          {unlocked && (
            <button className="btn btn-sm" onClick={lock}>
              Lock
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        {chain.status === 'error' && (
          <div className="notice notice-danger" role="alert">
            Cannot reach any Ferminux RPC endpoint. Retrying automatically…{' '}
            <button className="btn btn-sm" onClick={chain.retry} style={{ marginLeft: 8 }}>
              Retry now
            </button>
          </div>
        )}

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
            }}
          />
        )}
        {phase === 'unlocked' && api && (
          <WalletHome api={api} balances={balances} chain={chain} onManageAccounts={() => setAccountsOpen(true)} />
        )}
      </main>

      {accountsOpen && api && (
        <AccountsPanel api={api} balances={balances} onClose={() => setAccountsOpen(false)} />
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
          <span className="footer-item">
            Base fee {chain.baseFee !== null ? `${formatGwei(chain.baseFee)} gwei` : '—'}
          </span>
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
