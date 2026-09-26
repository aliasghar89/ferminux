// "Connect a wallet": Ferminux Wallet first (the web wallet — nothing to
// install), then each injected wallet this browser has, then WalletConnect
// when the build carries a project id. Without an injected wallet the phone
// hand-off stays one row away.

import type { WalletChoice } from '../../../../shared/fxwallet/connector.ts';
import type { WalletSession } from '../state/useWallet.ts';
import { classifyHandoff } from '../lib/handoff.ts';
import { Modal, Notice, Spinner } from './ui.tsx';

function ChoiceIcon({ choice }: { choice: WalletChoice }) {
  if (choice.icon) return <img className="wallet-choice-icon" src={choice.icon} alt="" width={28} height={28} />;
  return (
    <span className="wallet-choice-icon wallet-choice-mono" aria-hidden="true">
      {choice.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ConnectChooser({ wallet, onHandoff }: { wallet: WalletSession; onHandoff: () => void }) {
  const env = classifyHandoff({
    hasInjected: wallet.hasInjected,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  });
  return (
    <Modal title="Connect a wallet" onClose={wallet.closeChooser}>
      <ul className="wallet-choices" data-testid="wallet-choices">
        {wallet.choices.map((c) => (
          <li key={c.id}>
            <button
              className="wallet-choice"
              data-testid={`choice-${c.kind}`}
              disabled={wallet.connecting}
              onClick={() => wallet.connectWith(c.id)}
            >
              <ChoiceIcon choice={c} />
              <span className="wallet-choice-main">
                <span className="wallet-choice-name">
                  {c.name}
                  {c.featured && <span className="wallet-choice-tag">Recommended</span>}
                </span>
                <span className="wallet-choice-detail">{c.detail}</span>
              </span>
            </button>
          </li>
        ))}
        {env !== 'wallet' && (
          <li>
            <button className="wallet-choice" data-testid="choice-handoff" onClick={onHandoff}>
              <span className="wallet-choice-icon wallet-choice-mono" aria-hidden="true">
                ↗
              </span>
              <span className="wallet-choice-main">
                <span className="wallet-choice-name">{env === 'phone' ? 'Open in a wallet app' : 'Use on phone'}</span>
                <span className="wallet-choice-detail">
                  {env === 'phone' ? 'Continue inside MetaMask’s browser' : 'Scan a code to open this page in MetaMask Mobile'}
                </span>
              </span>
            </button>
          </li>
        )}
      </ul>
      {wallet.connecting && (
        <p className="small muted wallet-choice-status">
          <Spinner /> Waiting for the wallet…
        </p>
      )}
      {wallet.error && (
        <Notice kind="danger" role="alert">
          {wallet.error}
        </Notice>
      )}
    </Modal>
  );
}
