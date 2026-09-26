import { useEffect, useState } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { WalletConnectApi } from '../state/useWalletConnect.ts';
import type { LocalTx, LocalTxStatus } from '../lib/localActivity.ts';
import {
  isSigningRequest,
  signForRequest,
  type DecodedCall,
  type ProposalReview,
  type RequestView,
  type VerifyView,
} from '../lib/walletconnect.ts';
import { CHAIN_ID } from '../config.ts';
import { chainById, type ChainDef } from '../lib/chains.ts';
import { feePolicyFor, prepareTransaction, receiptOf, signAndBroadcast, type PreparedTx } from '../lib/tx.ts';
import { balanceFor } from '../lib/portfolio.ts';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { formatAmount, formatAmountExact, formatGwei, shortAddress } from '../lib/validate.ts';
import { Modal, Spinner } from '../components/ui.tsx';
import { ChainBadge } from '../components/ChainBadge.tsx';
import { ChainBanner, HashLine, sendProvider, shortenError } from './SendPanel.tsx';

/** A dApp's own icon (https only), or its initial. */
export function DappIcon({ icon, name }: { icon: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) {
    return (
      <span className="dapp-icon dapp-icon-empty" aria-hidden="true">
        {(name.trim()[0] ?? '?').toUpperCase()}
      </span>
    );
  }
  return <img className="dapp-icon" src={icon} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function VerifyLine({ verify }: { verify: VerifyView }) {
  const label =
    verify.status === 'valid'
      ? 'Verified domain'
      : verify.status === 'scam'
        ? 'Known scam'
        : verify.status === 'invalid'
          ? 'Domain mismatch'
          : 'Domain not verified';
  return (
    <div className={'verify-line verify-' + verify.status}>
      <span className="verify-tag">{label}</span>
      <span className="small">
        Request from <span className="mono">{verify.origin || 'an unknown origin'}</span>
      </span>
    </div>
  );
}

function DappHead({ name, url, icon, verify }: { name: string; url: string; icon: string | null; verify: VerifyView }) {
  return (
    <div className="dapp-head">
      <DappIcon icon={icon} name={name} />
      <div className="dapp-head-main">
        <div className="dapp-name">{name}</div>
        <div className="small muted mono dapp-url">{url || 'no URL given'}</div>
      </div>
      <VerifyLine verify={verify} />
    </div>
  );
}

function Notices({ blockers, warnings, dangers = [] }: { blockers: string[]; warnings: string[]; dangers?: string[] }) {
  return (
    <>
      {blockers.length > 0 && (
        <div className="notice notice-danger" role="alert" data-testid="wc-blockers">
          <strong>This cannot be approved.</strong>
          <ul className="notice-list">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {blockers.length === 0 &&
        dangers.map((d) => (
          <div key={d} className="notice notice-danger" role="alert" data-testid="wc-danger">
            {d}
          </div>
        ))}
      {warnings.map((w) => (
        <div key={w} className="notice notice-warn">
          {w}
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Session proposal                                                    */
/* ------------------------------------------------------------------ */

function ProposalModal({ review, wc, account }: { review: ProposalReview; wc: WalletConnectApi; account: { label: string; address: string } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reject = async () => {
    setBusy(true);
    try {
      await wc.controller?.rejectProposal(review.id);
    } catch {
      /* the proposal may have expired; it is gone either way */
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await wc.controller?.approveProposal(review.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const blocked = review.blockers.length > 0;
  return (
    <Modal title="Connection request" onClose={() => void reject()}>
      <div data-testid="wc-proposal">
        <DappHead name={review.dapp.name} url={review.dapp.url} icon={review.dapp.icon} verify={review.verify} />
        {review.dapp.description && <p className="small muted">{review.dapp.description}</p>}
        <Notices
          blockers={review.blockers}
          warnings={
            review.verify.status === 'invalid'
              ? [`The request came from ${review.verify.origin}, which is not the site it claims to be (${review.dapp.url}).`]
              : []
          }
        />
        <table className="confirm-table">
          <tbody>
            <tr>
              <th>Account</th>
              <td>
                {account.label} <span className="mono muted">{shortAddress(account.address)}</span>
              </td>
            </tr>
            <tr>
              <th>Networks</th>
              <td>
                <div className="wc-chain-rows">
                  {review.chains.length === 0 && <span className="muted">None named — Ferminux will be shared.</span>}
                  {review.chains.map((c) => {
                    const def = c.chainId !== null ? chainById(c.chainId) : undefined;
                    return (
                      <span key={c.caip} className={'wc-chain-row' + (c.supported ? '' : ' wc-chain-unsupported')}>
                        {def ? <ChainBadge chain={def} /> : <span className="chain-badge">?</span>} {c.name}
                        {c.required ? ' · required' : ''}
                        {!c.supported && ' · not supported'}
                      </span>
                    );
                  })}
                  {review.otherChains > 0 && (
                    <span className="small muted" data-testid="wc-other-chains">
                      + {review.otherChains} other network{review.otherChains === 1 ? '' : 's'} this wallet does not use, not shared
                    </span>
                  )}
                </div>
              </td>
            </tr>
            <tr>
              <th>It can ask to</th>
              <td className="small">View this address, request signatures and transactions (each needs your approval), and switch networks.</td>
            </tr>
          </tbody>
        </table>
        {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="actions-row">
          <button className="btn" onClick={() => void reject()} disabled={busy} data-testid="wc-proposal-reject">
            Reject
          </button>
          <span className="push" />
          {!blocked && (
            <button className="btn btn-primary" onClick={() => void approve()} disabled={busy} data-testid="wc-proposal-approve">
              {busy ? <Spinner /> : 'Connect'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

function DecodedCallRow({ call }: { call: DecodedCall }) {
  switch (call.kind) {
    case 'token-transfer':
      return (
        <>
          Token transfer to <span className="mono">{call.to}</span> · {call.amount.toString()} base units
        </>
      );
    case 'token-approve':
      return (
        <>
          Approve spender <span className="mono">{call.spender}</span> for{' '}
          {call.unlimited ? <strong>an unlimited amount</strong> : `${call.amount.toString()} base units`}
        </>
      );
    case 'token-increase-allowance':
      return (
        <>
          Increase spender <span className="mono">{call.spender}</span>’s allowance by{' '}
          {call.unlimited ? <strong>an unlimited amount</strong> : `${call.amount.toString()} base units`}
        </>
      );
    case 'token-transfer-from':
      return (
        <>
          Move tokens from <span className="mono">{shortAddress(call.from)}</span> to <span className="mono">{shortAddress(call.to)}</span> ·{' '}
          {call.amount.toString()} base units
        </>
      );
    case 'approval-for-all':
      return (
        <>
          {call.approved ? <strong>Grant</strong> : 'Revoke'} control of the whole collection for operator{' '}
          <span className="mono">{call.operator}</span>
        </>
      );
    case 'nft-transfer':
      return (
        <>
          NFT #{call.tokenId.toString()} to <span className="mono">{call.to}</span>
        </>
      );
    default:
      return (
        <>
          Contract call <span className="mono">{call.selector}</span> (not decoded)
        </>
      );
  }
}

/** Decoded amounts for a known token on this chain (the calldata alone only has base units). */
function tokenAmountNote(call: DecodedCall | null, to: string, chain: ChainDef | null, portfolio: PortfolioApi): string | null {
  if (!call || !chain) return null;
  const t = (portfolio.assetsByChain.get(chain.id) ?? []).find((a) => a.address?.toLowerCase() === to.toLowerCase());
  if (!t) return null;
  if (call.kind === 'token-transfer' || call.kind === 'token-transfer-from') return `${formatAmountExact(call.amount, t.decimals)} ${t.symbol}`;
  if ((call.kind === 'token-approve' || call.kind === 'token-increase-allowance') && !call.unlimited) return `${formatAmountExact(call.amount, t.decimals)} ${t.symbol}`;
  if (call.kind === 'token-approve' || call.kind === 'token-increase-allowance') return `all of your ${t.symbol}`;
  return null;
}

function RequestModal({
  view,
  wc,
  api,
  home,
  portfolio,
  onRecord,
  onStatus,
}: {
  view: RequestView;
  wc: WalletConnectApi;
  api: AccountsApi;
  home: ChainState;
  portfolio: PortfolioApi;
  onRecord: (tx: LocalTx) => void;
  onStatus: (chainId: number, hash: string, status: LocalTxStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);
  const d = view.detail;
  const blocked = view.blockers.length > 0;
  const chain = view.chain;

  // A transaction is fully prepared (nonce, gas, fees) before it can be approved.
  useEffect(() => {
    if (d.kind !== 'tx' || blocked || !chain) return;
    let alive = true;
    (async () => {
      try {
        const provider = await sendProvider(chain, home);
        const p = await prepareTransaction(provider, chain.id, view.address, d.to, d.valueWei, d.data, feePolicyFor(chain, CHAIN_ID));
        if (alive) setPrepared(p);
      } catch (e) {
        if (alive) setPrepError(e instanceof Error ? shortenError(e.message) : 'Could not prepare the transaction.');
      }
    })();
    return () => {
      alive = false;
    };
    // view.id identifies the request; its detail never changes.
  }, [view.id]);

  const nativeBalance = chain ? balanceFor(portfolio.lastGood, chain.id, null) : null;
  const insufficient =
    d.kind === 'tx' && prepared && nativeBalance !== null && prepared.valueWei + prepared.maxFeeWei > nativeBalance;

  const reject = async () => {
    setBusy(true);
    try {
      await wc.controller?.rejectRequest(view.id);
    } catch {
      /* already answered or expired */
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    const c = wc.controller;
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      if (isSigningRequest(view)) {
        const sig = await signForRequest(view, api.active.privateKey);
        await c.approveRequest(view.id, sig);
      } else if (d.kind === 'switch' || d.kind === 'add') {
        await c.approveChainRequest(view.id);
      } else if (d.kind === 'tx' && prepared && chain) {
        const provider = await sendProvider(chain, home);
        let sent;
        try {
          sent = await signAndBroadcast(api.active.privateKey, provider, prepared);
        } catch (e) {
          const msg = e instanceof Error ? shortenError(e.message) : 'Broadcast failed.';
          await c.failRequest(view.id, msg);
          throw new Error(msg);
        }
        setSentHash(sent.hash);
        await c.approveRequest(view.id, sent.hash);
        if (chain.id !== CHAIN_ID) {
          onRecord({
            chainId: chain.id,
            hash: sent.hash,
            from: view.address,
            to: d.to,
            kind: d.valueWei > 0n && d.data === '0x' ? 'native' : 'call',
            symbol: chain.native.symbol,
            amount: d.valueWei.toString(),
            decimals: chain.native.decimals,
            contract: null,
            status: 'pending',
            createdAt: Date.now(),
            via: view.dapp.name,
          });
          void receiptOf(sent.response).then(
            (r) => onStatus(chain.id, sent.hash, r && r.status === 1 ? 'confirmed' : 'failed'),
            () => undefined,
          );
        }
        portfolio.refresh(chain.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    d.kind === 'message'
      ? 'Signature request'
      : d.kind === 'eth_sign'
        ? 'Raw signature request (eth_sign)'
        : d.kind === 'typed'
          ? 'Typed-data signature request'
          : d.kind === 'tx'
            ? 'Transaction request'
            : d.kind === 'switch'
              ? 'Switch network'
              : d.kind === 'add'
                ? 'Add network'
                : 'Unsupported request';

  const approveLabel =
    d.kind === 'tx' ? `Approve & send on ${chain?.name ?? ''}` : d.kind === 'switch' || d.kind === 'add' ? 'Switch network' : 'Sign';
  const canApprove =
    !blocked &&
    !busy &&
    (d.kind !== 'eth_sign' || ack) &&
    (d.kind !== 'tx' || (prepared !== null && !insufficient)) &&
    d.kind !== 'unsupported';

  return (
    <Modal title={title} onClose={() => void reject()} wide>
      <div data-testid="wc-request" data-method={view.method}>
        <DappHead name={view.dapp.name} url={view.dapp.url} icon={view.dapp.icon} verify={view.verify} />
        {chain && d.kind !== 'switch' && d.kind !== 'add' && (
          // Only a transaction, or typed data whose domain names this chain, is
          // bound to it: an eth_sign signature drains the account on any chain.
          <ChainBanner chain={chain} unbound={!(d.kind === 'tx' || (d.kind === 'typed' && d.domain.chainId === chain.id))} />
        )}
        <Notices blockers={view.blockers} warnings={view.warnings} dangers={view.dangers} />

        <div className="small muted" style={{ marginBottom: 8 }}>
          {d.kind === 'switch' || d.kind === 'add' ? 'For' : 'Signing as'} <strong>{api.active.label}</strong>{' '}
          <span className="mono">{shortAddress(view.address)}</span> · method <span className="mono">{view.method}</span>
        </div>

        {d.kind === 'message' && (
          <>
            {d.siweDomain && <div className="small muted">Sign-in request for <strong>{d.siweDomain}</strong></div>}
            <pre className="sign-box" data-testid="wc-message">{d.text ?? d.hex}</pre>
            {d.text === null && <div className="field-hint">Shown as hex: the message is not readable text.</div>}
          </>
        )}

        {d.kind === 'eth_sign' && (
          <>
            <pre className="sign-box mono">{d.hash}</pre>
            <label className="check-row" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="wc-ethsign-ack" />
              <span>I understand this signature can authorize a transaction that moves everything in this account, and I trust this site with that.</span>
            </label>
          </>
        )}

        {d.kind === 'typed' && (
          <table className="confirm-table typed-table">
            <tbody>
              <tr>
                <th>Type</th>
                <td className="mono">{d.primaryType}</td>
              </tr>
              {d.domain.name && (
                <tr>
                  <th>Domain</th>
                  <td>
                    {d.domain.name}
                    {d.domain.version ? ` v${d.domain.version}` : ''}
                  </td>
                </tr>
              )}
              {d.domain.chainId !== null && (
                <tr>
                  <th>Domain chain</th>
                  <td className="num">{d.domain.chainId}</td>
                </tr>
              )}
              {d.domain.verifyingContract && (
                <tr>
                  <th>Contract</th>
                  <td className="mono">{d.domain.verifyingContract}</td>
                </tr>
              )}
              {d.fields.map((f) => (
                <tr key={f.path}>
                  <th className="mono">{f.path}</th>
                  <td className="mono">{f.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {d.kind === 'tx' && (
          <table className="confirm-table">
            <tbody>
              <tr>
                <th>To</th>
                <td className="mono">{d.to}</td>
              </tr>
              <tr>
                <th>Value</th>
                <td className="em num">
                  {chain ? `${formatAmountExact(d.valueWei, chain.native.decimals)} ${chain.native.symbol}` : d.valueWei.toString()}
                </td>
              </tr>
              {d.decoded && (
                <tr>
                  <th>Action</th>
                  <td>
                    <DecodedCallRow call={d.decoded} />
                    {tokenAmountNote(d.decoded, d.to, chain, portfolio) && (
                      <div className="em">= {tokenAmountNote(d.decoded, d.to, chain, portfolio)}</div>
                    )}
                  </td>
                </tr>
              )}
              {d.data !== '0x' && (
                <tr>
                  <th>Data</th>
                  <td className="mono small">
                    <details>
                      <summary>{(d.data.length - 2) / 2} bytes</summary>
                      <span className="sign-hex">{d.data}</span>
                    </details>
                  </td>
                </tr>
              )}
              <tr>
                <th>Network fee (max)</th>
                <td className="num">
                  {prepared && chain ? (
                    <>
                      {formatAmount(prepared.maxFeeWei, chain.native.decimals, 8)} {chain.native.symbol}
                      {prepared.l1FeeWei !== undefined && <span className="muted"> · incl. L1 data fee</span>}
                    </>
                  ) : prepError ? (
                    '—'
                  ) : (
                    <Spinner />
                  )}
                </td>
              </tr>
              {prepared && (
                <>
                  <tr>
                    <th>Gas limit · nonce</th>
                    <td className="num">
                      {prepared.gasLimit.toString()} · {prepared.nonce}
                    </td>
                  </tr>
                  <tr>
                    <th>Fee type</th>
                    <td className="num">
                      {prepared.type === 0
                        ? `Legacy · ${formatGwei(prepared.gasPrice ?? 0n)} gwei`
                        : `EIP-1559 · max ${formatGwei(prepared.maxFeePerGas)} gwei`}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        )}
        {prepError && <div className="notice notice-danger">{prepError}</div>}
        {insufficient && chain && (
          <div className="notice notice-danger" data-testid="wc-insufficient">
            Not enough {chain.native.symbol} on {chain.name}: value plus the worst-case fee exceeds this account’s balance.
          </div>
        )}

        {(d.kind === 'switch' || d.kind === 'add') && d.target && (
          <div className="chain-switch">
            <ChainBadge chain={d.target} withName />
            <span className="small muted">
              {d.inSession ? 'Already shared with this site.' : 'Not yet shared with this site — approving adds it to the connection.'}
            </span>
          </div>
        )}

        {sentHash && chain && <HashLine chain={chain} hash={sentHash} />}
        {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div className="actions-row">
          <button className="btn" onClick={() => void reject()} disabled={busy} data-testid="wc-reject">
            {blocked || d.kind === 'unsupported' ? 'Refuse' : 'Reject'}
          </button>
          <span className="push" />
          {!blocked && d.kind !== 'unsupported' && (
            <button className="btn btn-primary" onClick={() => void approve()} disabled={!canApprove} data-testid="wc-approve">
              {busy ? <Spinner /> : approveLabel}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The head of the WalletConnect queue: one decision at a time, proposals first. */
export function WcModals({
  wc,
  api,
  home,
  portfolio,
  onRecord,
  onStatus,
}: {
  wc: WalletConnectApi;
  api: AccountsApi;
  home: ChainState;
  portfolio: PortfolioApi;
  onRecord: (tx: LocalTx) => void;
  onStatus: (chainId: number, hash: string, status: LocalTxStatus) => void;
}) {
  const proposal = wc.state.proposals[0];
  if (proposal) return <ProposalModal key={`p${proposal.id}`} review={proposal} wc={wc} account={api.active} />;
  const request = wc.state.requests[0];
  if (request) {
    return (
      <RequestModal
        key={`r${request.id}`}
        view={request}
        wc={wc}
        api={api}
        home={home}
        portfolio={portfolio}
        onRecord={onRecord}
        onStatus={onStatus}
      />
    );
  }
  return null;
}
