// "Connect a wallet": Ferminux Wallet first (the web wallet — nothing to
// install), then each injected wallet this browser has, then WalletConnect
// when the build carries a project id.

import { useEffect } from "react";
import type { WalletChoice } from "../../../shared/fxwallet/connector.ts";

function ChoiceIcon({ choice }: { choice: WalletChoice }) {
  if (choice.icon) return <img className="wallet-choice-icon" src={choice.icon} alt="" width={28} height={28} />;
  return (
    <span className="wallet-choice-icon wallet-choice-mono" aria-hidden="true">
      {choice.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function ConnectChooser({
  choices,
  connecting,
  error,
  onChoose,
  onClose,
}: {
  choices: WalletChoice[];
  connecting: boolean;
  error: string | null;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="lp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lp-dialog" role="dialog" aria-modal="true" aria-labelledby="lp-connect-title">
        <div className="lp-dialog-head">
          <h3 id="lp-connect-title">Connect a wallet</h3>
          <button className="subtle" onClick={onClose}>
            Close
          </button>
        </div>
        <ul className="wallet-choices" data-testid="wallet-choices">
          {choices.map((c) => (
            <li key={c.id}>
              <button
                className="wallet-choice"
                data-testid={`choice-${c.kind}`}
                disabled={connecting}
                autoFocus={c.kind === "ferminux"}
                onClick={() => onChoose(c.id)}
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
        </ul>
        {connecting && (
          <p className="wallet-choice-status">
            <span className="spinner" /> Waiting for the wallet…
          </p>
        )}
        {error && (
          <div className="notice error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
