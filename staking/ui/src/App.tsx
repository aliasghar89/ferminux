import { useEffect, useState } from 'react';
import { CHAIN_ID, EXPLORER_URL, STAKING_VAULT_ADDRESS, NODE_REGISTRY_ADDRESS } from './config.ts';
import { formatGwei } from './lib/validate.ts';
import { shortAddress, formatFMX } from './lib/format.ts';
import { useChain } from './state/useChain.ts';
import { useWallet } from './state/useWallet.ts';
import { useVaultData, usePositions, useRoster, useBalance } from './state/useStakingData.ts';
import { StatsHeader } from './views/StatsHeader.tsx';
import { StakePanel } from './views/StakePanel.tsx';
import { PositionsPanel } from './views/PositionsPanel.tsx';
import { NodesPanel } from './views/NodesPanel.tsx';
import { ExplainerPanel } from './views/ExplainerPanel.tsx';
import { ConnectModal } from './views/ConnectModal.tsx';

type Tab = 'stake' | 'positions' | 'nodes' | 'about';

/** Unix seconds, ticking — drives every countdown on screen. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const DEPLOYED = STAKING_VAULT_ADDRESS !== '';

export function App() {
  const chain = useChain();
  const wallet = useWallet();
  const vault = useVaultData(chain.provider, STAKING_VAULT_ADDRESS);
  const positions = usePositions(chain.provider, STAKING_VAULT_ADDRESS, wallet.address);
  const roster = useRoster(chain.provider, NODE_REGISTRY_ADDRESS);
  const balance = useBalance(chain.provider, wallet.address);
  const [tab, setTab] = useState<Tab>('stake');
  const [connectOpen, setConnectOpen] = useState(false);
  const now = useNow();

  const refreshAll = () => {
    vault.refresh();
    positions.refresh();
    roster.refresh();
    balance.refresh();
  };

  const openPositions = positions.data?.filter((p) => p.state !== 'withdrawn') ?? null;

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Ferminux
            <span className="brand-sub">Staking</span>
          </span>
          <span className="header-spacer" />
          {wallet.address ? (
            <>
              <span className="wallet-chip" title={wallet.address}>
                {shortAddress(wallet.address)}
                <span className="bal num">
                  {balance.data !== null ? `${formatFMX(balance.data, 2)} FMX` : '…'}
                </span>
              </span>
              <button className="btn btn-sm" onClick={wallet.disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => setConnectOpen(true)}>
              Connect wallet
            </button>
          )}
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
        </div>
      </header>

      <StatsHeader vault={vault} roster={roster} deployed={DEPLOYED} />

      <main className="app-main">
        {chain.status === 'error' && (
          <div className="notice notice-danger" role="alert">
            Cannot reach any Ferminux RPC endpoint. Retrying automatically…{' '}
            <button className="btn btn-sm" onClick={chain.retry} style={{ marginLeft: 8 }}>
              Retry now
            </button>
          </div>
        )}
        {!DEPLOYED && (
          <div className="notice notice-warn">
            <strong>Staking is not live yet.</strong> The contracts are in final review and have not been deployed
            by the treasury multisig. Everything below shows how it will work; no transaction can be sent until the
            audited contract addresses are published here.
          </div>
        )}
        {wallet.error && (
          <div className="notice notice-warn" role="alert">
            {wallet.error}
          </div>
        )}

        <div className="panel">
          <div className="tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === 'stake'} onClick={() => setTab('stake')}>
              Stake
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'positions'} onClick={() => setTab('positions')}>
              Positions{openPositions && openPositions.length > 0 ? ` (${openPositions.length})` : ''}
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'nodes'} onClick={() => setTab('nodes')}>
              Nodes
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'about'} onClick={() => setTab('about')}>
              How it works
            </button>
          </div>

          {tab === 'stake' && (
            <StakePanel
              chain={chain}
              wallet={wallet}
              vault={vault}
              balance={balance}
              deployed={DEPLOYED}
              now={now}
              onConnect={() => setConnectOpen(true)}
              onDone={refreshAll}
            />
          )}
          {tab === 'positions' && (
            <PositionsPanel
              chain={chain}
              wallet={wallet}
              vault={vault}
              positions={positions}
              deployed={DEPLOYED}
              now={now}
              onConnect={() => setConnectOpen(true)}
              onDone={refreshAll}
            />
          )}
          {tab === 'nodes' && (
            <NodesPanel
              chain={chain}
              wallet={wallet}
              roster={roster}
              positions={positions}
              deployed={DEPLOYED}
              now={now}
              onConnect={() => setConnectOpen(true)}
              onDone={refreshAll}
              onGoStake={() => setTab('stake')}
            />
          )}
          {tab === 'about' && <ExplainerPanel vault={vault} chain={chain} />}
        </div>
      </main>

      {connectOpen && (
        <ConnectModal
          wallet={wallet}
          onClose={() => setConnectOpen(false)}
          onConnected={() => setConnectOpen(false)}
        />
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
