import { useState } from 'react';
import { CHAIN_ID } from '../config.ts';
import { CHAINS, FERMINUX_CHAIN, chainById } from '../lib/chains.ts';
import { checkAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { buildEip681Uri } from '../lib/qr.ts';
import { Modal, QrCanvas, CopyButton, Switch } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { ChainBadge } from '../components/ChainBadge.tsx';

/**
 * Receive screen. The QR encodes an EIP-681 URI for the chosen network
 * (`ethereum:0x…@3961` by default) rather than a bare address, so a wallet
 * scanning it learns the chain — and, when a request amount is set, the amount
 * too. The same address works on every supported network; the plain address
 * stays one click away for anything that only understands 0x….
 */
export function ReceiveModal({ address, label, onClose }: { address: string; label: string; onClose: () => void }) {
  const [chainId, setChainId] = useState<number>(CHAIN_ID);
  const [wantAmount, setWantAmount] = useState(false);
  const [amount, setAmount] = useState('');
  const chain = chainById(chainId) ?? FERMINUX_CHAIN;
  const symbol = chain.native.symbol;

  const trimmed = amount.trim();
  const check = wantAmount && trimmed !== '' ? checkAmount(trimmed, chain.native.decimals) : null;
  const amountWei = check?.ok ? check.wei : undefined;
  const amountError = check && !check.ok ? check.error : null;
  const uri = buildEip681Uri(address, { chainId: chain.id, amountWei });

  return (
    <Modal title={`Receive on ${chain.name}`} onClose={onClose}>
      <div className="receive-account">
        <Identicon address={address} size={24} />
        <strong>{label}</strong>
        <span className="mono muted small">{shortAddress(address)}</span>
      </div>

      <div className="field-label" id="receive-chain-label">
        Network for this code
      </div>
      <div className="chips" role="group" aria-labelledby="receive-chain-label" data-testid="receive-chain" style={{ marginBottom: 16 }}>
        {CHAINS.map((c) => (
          <button
            key={c.id}
            className="chip"
            aria-pressed={c.id === chain.id}
            onClick={() => {
              setChainId(c.id);
              setAmount('');
            }}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="qr-frame">
        <QrCanvas value={uri} size={208} />
      </div>
      <p className="receive-addr">{address}</p>
      {amountWei !== undefined && (
        <p className="request-line num">
          Requesting <strong style={{ color: 'var(--ink)' }}>{formatAmountExact(amountWei, chain.native.decimals)} {symbol}</strong> on {chain.name}
        </p>
      )}
      <div className="actions-row" style={{ justifyContent: 'center', margin: '4px 0 16px', gap: 4 }}>
        <CopyButton text={address} label="Copy address" />
        <CopyButton text={uri} label="Copy payment link" />
      </div>

      <div className="receive-chains" data-testid="receive-chains">
        <div className="small">This address works on all {CHAINS.length} networks this wallet supports:</div>
        <div className="receive-chain-list">
          {CHAINS.map((c) => (
            <ChainBadge key={c.id} chain={c} withName />
          ))}
        </div>
        <div className="small muted">
          The code above asks for {chain.name} (chain {chain.id}). Only accept funds on these networks: this wallet does
          not show assets on any other.
        </div>
      </div>

      <Switch
        checked={wantAmount}
        onChange={(v) => {
          setWantAmount(v);
          if (!v) setAmount('');
        }}
        label={`Request a specific amount of ${symbol}`}
      />

      {wantAmount && (
        <div className="field" style={{ marginTop: 8, marginBottom: 12 }}>
          <label htmlFor="receive-amount">Amount ({symbol})</label>
          <input
            id="receive-amount"
            className={'input input-mono' + (amountError ? ' input-error' : '')}
            placeholder="0.0"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoComplete="off"
          />
          {amountError && <div className="field-error">{amountError}</div>}
          <div className="field-hint">Encoded into the QR, so a wallet scanning it fills the amount in too. Leave blank for an open request.</div>
        </div>
      )}

      <div className="uri-line" style={{ marginTop: 12 }} title="Payment link encoded in the QR">
        {uri}
      </div>
    </Modal>
  );
}
