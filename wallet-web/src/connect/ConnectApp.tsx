// The connect window (connect.html): what a dApp opens when it asks Ferminux
// Wallet to connect, sign, send or add a token.
//
// One request at a time, in arrival order. The requesting origin — verified
// from the message, not from the URL — heads every screen. Keys are decrypted
// in this window's memory only when a request needs one, and die with it: the
// window closes itself a moment after its last answer.
//
// Opened directly (no dApp behind it), the same page is the "Connected sites"
// manager.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, type JsonRpcProvider } from 'ethers';
import { CHAIN_META, FERMINUX_CHAIN_ID, chainName, nativeSymbol } from '../../../shared/fxwallet/chains.ts';
import { ERR, ProviderRpcError } from '../../../shared/fxwallet/errors.ts';
import { decryptVault, VAULT_KEY, type AccountSet, type Vault } from '../lib/vault.ts';
import type { SessionAccount } from '../lib/accounts.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { loadTokenAddresses, loadVault, saveTokenAddresses } from '../state/storage.ts';
import { DEFAULT_TOKENS, WALLET_CONNECT_URLS } from '../config.ts';
import { useLockMs } from '../views/prefs.ts';
import { useIdleLock } from '../state/useIdleLock.ts';
import { onLockAnnounced } from '../lib/lockSignal.ts';
import { Identicon } from '../components/Identicon.tsx';
import { ProgressBar, Spinner } from '../components/ui.tsx';
import { useOpenerChannel, type IncomingRequest, type OpenerChannel } from './channel.ts';
import { screenRequest, needsKey, permitWarning, siweDomainMismatch, type Screened } from './screen.ts';
import { isSecureOrigin, loadSites, onSitesChange, saveSites, touched, withSite, withoutSite, type ConnectedSite } from './sites.ts';
import { handOffUrl, otherWalletUrls, walletPlace } from './origins.ts';
import { decodeCalldata, isUnlimited, type DecodedCall } from './decode.ts';
import { prepareCall, providerFor, signAndSend, signPersonal, signTyped, tokenFacts, WouldFailError, type PreparedCall, type TokenFacts } from './execute.ts';
import type { PersonalSignRequest, TxRequest, TypedDataRequest, WatchAssetRequest } from './requests.ts';
import { ConnectedSites } from './ConnectedSites.tsx';
import { Brand } from '../components/Brand.tsx';
import { announceTx } from '../lib/txSignal.ts';

/** How long the window stays after its last answer, so a follow-up request (connect → send) reuses it. */
const LINGER_MS = 2000;

/** What counts as using this window: a hover over a review is not. */
const IDLE_EVENTS: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];

/**
 * A review's approve button stays disabled this long after it appears. The
 * window is reused for follow-up requests, and the next review puts its own
 * approve button on screen the moment the last one is answered: without the
 * pause, the second click of a double-click on "Connect" or "Sign" would
 * approve whatever the site queued behind it.
 */
const ARM_MS = 600;

const rejected = () => new ProviderRpcError(ERR.USER_REJECTED, 'You rejected the request in Ferminux Wallet.');

function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(t);
  }, []);
  return armed;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; reason?: string; message?: string };
  const msg = err?.shortMessage || err?.reason || err?.message || String(e);
  return msg.length > 240 ? msg.slice(0, 240) + '…' : msg;
}

/* ================================================================== */
/* Root                                                                */
/* ================================================================== */

export function ConnectApp() {
  const channel = useOpenerChannel();
  const [vault, setVault] = useState<Vault | null>(() => loadVault());
  const [sites, setSites] = useState<ConnectedSite[]>(() => loadSites());
  const [set, setSet] = useState<AccountSet | null>(null);

  useEffect(() => onSitesChange(() => setSites(loadSites())), []);
  // A wallet created (or forgotten) in another tab shows up here without a reload;
  // keys decrypted from a vault that was just forgotten go with it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== VAULT_KEY) return;
      const next = loadVault();
      if (!next) setSet(null);
      setVault(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Keys are dropped when the wallet is locked in any tab, when the site that
  // opened this window is gone (nothing is left to sign for), and after the
  // wallet's own "Lock after" without a tap or key press.
  useEffect(() => onLockAnnounced(() => setSet(null)), []);
  useEffect(() => {
    if (channel.openerGone) setSet(null);
  }, [channel.openerGone]);
  useIdleLock(set !== null, useLockMs(), () => setSet(null), IDLE_EVENTS);

  const available = useMemo(() => vault?.accounts.map((a) => a.address) ?? [], [vault]);
  const head = channel.queue[0] ?? null;
  const screened = useMemo<Screened | null>(() => (head ? screenRequest(head, sites, available) : null), [head, sites, available]);

  // Answer at once what needs no one: known site asking for accounts, a site
  // disconnecting itself, or a refusal.
  const autoAnswered = useRef(new Set<string>());
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    if (!head || !screened || screened.action === 'review' || autoAnswered.current.has(head.id)) return;
    autoAnswered.current.add(head.id);
    if (screened.action === 'reply') {
      saveSites(touched(loadSites(), head.origin, Date.now()));
      channel.resolve(head, screened.result);
    } else if (screened.action === 'revoke') {
      saveSites(withoutSite(loadSites(), head.origin));
      setRevoked(true);
      channel.resolve(head, null);
    } else if (screened.action === 'error') {
      channel.reject(head, screened.error);
    }
  }, [head, screened, channel]);

  // The wallet's other origin(s), for a window that finds no vault here.
  const elsewhere = useMemo(() => otherWalletUrls(window.location, WALLET_CONNECT_URLS), []);

  // Close a moment after the last answer; a new request in the meantime keeps it open.
  const { hasOpener, answered, close } = channel;
  const queued = channel.queue.length;
  useEffect(() => {
    if (!hasOpener || queued > 0 || answered === 0) return;
    const t = window.setTimeout(close, LINGER_MS);
    return () => window.clearTimeout(t);
  }, [hasOpener, queued, answered, close]);

  let body: JSX.Element;
  if (!channel.hasOpener) {
    body = <Standalone claimed={channel.claimed} />;
  } else if (!head) {
    body = channel.openerGone ? (
      <Message title="The site closed" text="The page that opened this window is gone. You can close it." onClose={() => window.close()} />
    ) : channel.answered > 0 ? (
      <Message
        title={revoked ? 'Disconnected' : 'Done'}
        text={
          revoked
            ? `${channel.claimed ? hostOf(channel.claimed) : 'The site'} is no longer connected to this wallet. Returning you there…`
            : `Returning you to ${channel.claimed ? hostOf(channel.claimed) : 'the site'}…`
        }
        onClose={() => channel.close()}
        testId="done"
      />
    ) : (
      <Waiting host={channel.claimed ? hostOf(channel.claimed) : ''} />
    );
  } else if (!screened || screened.action !== 'review') {
    body = <Waiting host={hostOf(head.origin)} />;
  } else {
    body = (
      <>
        <OriginBanner req={head} kind={screened.kind} />
        {!vault ? (
          <NoVault
            elsewhere={elsewhere}
            onHandOff={(url) => channel.handOff(handOffUrl(url, window.location.hash))}
            onCancel={() => channel.reject(head, rejected())}
          />
        ) : needsKey(screened.kind) && !set ? (
          <UnlockCard vault={vault} onUnlocked={setSet} onCancel={() => channel.reject(head, rejected())} />
        ) : (
          <Review key={head.id} req={head} screened={screened} set={set} channel={channel} />
        )}
      </>
    );
  }

  const chain = head?.chainId ?? FERMINUX_CHAIN_ID;
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner cx-header-inner">
          <Brand />
          <span className="header-spacer" />
          {channel.hasOpener && (
            <span className="net-pill num cx-chain-pill" data-testid="cx-chain">
              <span className="dot dot-ok" />
              <span className="cx-chain-label">
                {chainName(chain)} · {chain}
              </span>
            </span>
          )}
        </div>
      </header>
      <main className="cx-main">{body}</main>
      <footer className="cx-foot">Keys stay in this window. Nothing is signed or sent without your confirmation here.</footer>
    </>
  );
}

/* ================================================================== */
/* Frame pieces                                                        */
/* ================================================================== */

const TITLES: Record<string, string> = {
  connect: 'Connect to this site',
  sign: 'Sign a message',
  typed: 'Sign typed data',
  tx: 'Confirm transaction',
  watch: 'Add a token',
};

function OriginBanner({ req, kind }: { req: IncomingRequest; kind: string }) {
  const host = hostOf(req.origin);
  const secure = isSecureOrigin(req.origin);
  return (
    <section className="cx-origin" aria-label="Requesting site" data-testid="cx-origin">
      <div className="cx-origin-kicker">{TITLES[kind] ?? 'Request'}</div>
      <div className="cx-origin-host" title={req.origin}>
        {host}
      </div>
      <div className="cx-origin-meta">
        <span className="mono">{req.origin}</span>
        {req.appName && req.appName.toLowerCase() !== host.toLowerCase() && <span> · calls itself “{req.appName}”</span>}
      </div>
      {!secure && (
        <div className="notice notice-danger cx-origin-warn" role="alert">
          This site is not served over HTTPS. Anyone on the network path could change what it asks you to sign.
        </div>
      )}
    </section>
  );
}

function Message({ title, text, onClose, testId }: { title: string; text: string; onClose: () => void; testId?: string }) {
  return (
    <div className="panel" data-testid={testId}>
      <div className="panel-body cx-center">
        <div className="cx-big">{title}</div>
        <p className="small muted">{text}</p>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function Waiting({ host }: { host: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="panel">
      <div className="panel-body cx-center">
        <Spinner />
        <p className="small muted mb-0" style={{ marginTop: 10 }}>
          {host ? `Waiting for ${host}…` : 'Waiting…'}
        </p>
        {slow && <p className="small muted mb-0">If nothing happens, close this window and try again from the site.</p>}
      </div>
    </div>
  );
}

function Standalone({ claimed }: { claimed: string | null }) {
  return (
    <>
      {claimed && (
        <div className="notice notice-warn">
          This window is no longer linked to {hostOf(claimed)}. Go back to the site and start again there.
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <h2>Connected sites</h2>
        </div>
        <ConnectedSites />
      </div>
      <p className="small muted cx-center-text">
        <a href="./" className="cx-link">
          Open Ferminux Wallet
        </a>
      </p>
    </>
  );
}

function NoVault({ elsewhere, onHandOff, onCancel }: { elsewhere: string[]; onHandOff: (url: string) => void; onCancel: () => void }) {
  const here = walletPlace(`${window.location.origin}${window.location.pathname}`);
  return (
    <div className="panel" data-testid="cx-novault">
      <div className="panel-body">
        <div className="cx-big">{elsewhere.length > 0 ? `No wallet saved at ${here}` : 'No wallet on this device yet'}</div>
        {elsewhere.length > 0 && (
          <div className="cx-elsewhere">
            <p className="small">
              A browser keeps a wallet at the address where it was created. If you made yours at{' '}
              {elsewhere.map(walletPlace).join(' or ')}, continue there.
            </p>
            {elsewhere.map((url) => (
              <button key={url} className="btn btn-block" data-testid="cx-elsewhere" onClick={() => onHandOff(url)}>
                My wallet is at {walletPlace(url)}
              </button>
            ))}
          </div>
        )}
        <p className="small">
          Create or import a wallet in Ferminux Wallet with <strong>Remember on this device</strong> switched on. This
          window picks it up as soon as it is saved.
        </p>
        <div className="cx-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <a className="btn btn-primary" href="./" target="_blank" rel="noopener">
            Open Ferminux Wallet
          </a>
        </div>
      </div>
    </div>
  );
}

function UnlockCard({ vault, onUnlocked, onCancel }: { vault: Vault; onUnlocked: (s: AccountSet) => void; onCancel: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pw === '' || busy) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const { set } = await decryptVault(vault, pw, { progress: setProgress });
      setPw('');
      onUnlocked(set);
    } catch {
      setError('Wrong password — the stored accounts could not be decrypted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-body">
        <div className="cx-big">Unlock to continue</div>
        <ul className="unlock-accounts">
          {vault.accounts.map((a) => (
            <li key={a.id}>
              <Identicon address={a.address} size={20} />
              <span className="unlock-label">{a.label}</span>
              <span className="unlock-addr mono">{shortAddress(a.address)}</span>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor="cx-pw">Password</label>
            <input
              id="cx-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={pw}
              disabled={busy}
              onChange={(e) => setPw(e.target.value)}
            />
          </div>
          {error && (
            <div className="field-error" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}
          {busy ? (
            <>
              <ProgressBar fraction={progress} />
              <p className="small muted mb-0">Decrypting…</p>
            </>
          ) : (
            <div className="cx-actions">
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" data-testid="cx-unlock" disabled={pw === ''}>
                Unlock
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Reviews                                                             */
/* ================================================================== */

interface ReviewProps {
  req: IncomingRequest;
  screened: Extract<Screened, { action: 'review' }>;
  set: AccountSet | null;
  channel: OpenerChannel;
}

function Review({ req, screened, set, channel }: ReviewProps) {
  const approve = useCallback((result: unknown) => channel.resolve(req, result), [channel, req]);
  const reject = useCallback(() => channel.reject(req, rejected()), [channel, req]);
  const accountFor = (address: string) => set?.accounts.find((a) => a.address.toLowerCase() === address.toLowerCase()) ?? null;

  switch (screened.kind) {
    case 'connect':
      return <ConnectReview req={req} set={set!} onApprove={approve} onReject={reject} />;
    case 'sign': {
      const acct = accountFor(screened.request.address);
      return acct ? <SignReview req={req} request={screened.request} account={acct} onApprove={approve} onReject={reject} /> : <MissingKey onReject={reject} />;
    }
    case 'typed': {
      const acct = accountFor(screened.request.address);
      return acct ? <TypedReview request={screened.request} account={acct} onApprove={approve} onReject={reject} /> : <MissingKey onReject={reject} />;
    }
    case 'tx': {
      const acct = accountFor(screened.request.from);
      return acct ? <TxReview req={req} request={screened.request} account={acct} onApprove={approve} onReject={reject} /> : <MissingKey onReject={reject} />;
    }
    case 'watch':
      return <WatchReview request={screened.request} onApprove={approve} onReject={reject} />;
  }
}

function MissingKey({ onReject }: { onReject: () => void }) {
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="notice notice-danger">This account is in the list but its key could not be unlocked on this device.</div>
        <div className="cx-actions">
          <button className="btn" onClick={onReject}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountLine({ account, label = 'Account' }: { account: { address: string; label: string }; label?: string }) {
  return (
    <div className="cx-acct-line">
      <span className="cx-k">{label}</span>
      <Identicon address={account.address} size={18} />
      <span className="cx-acct-label">{account.label}</span>
      <span className="mono muted" title={account.address}>
        {shortAddress(account.address)}
      </span>
    </div>
  );
}

function Actions({
  busy,
  error,
  approveLabel,
  onApprove,
  onReject,
  disabled,
  testId,
}: {
  busy: boolean;
  error: string | null;
  approveLabel: string;
  onApprove: () => void;
  onReject: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  const armed = useArmed();
  return (
    <>
      {error && (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      )}
      <div className="cx-actions">
        <button className="btn" onClick={onReject} disabled={busy} data-testid="cx-reject">
          Reject
        </button>
        <button className="btn btn-primary" onClick={onApprove} disabled={busy || disabled || !armed} data-testid={testId ?? 'cx-approve'}>
          {busy ? <Spinner /> : null}
          {approveLabel}
        </button>
      </div>
    </>
  );
}

/* ---------------- connect ---------------- */

function ConnectReview({
  req,
  set,
  onApprove,
  onReject,
}: {
  req: IncomingRequest;
  set: AccountSet;
  onApprove: (r: unknown) => void;
  onReject: () => void;
}) {
  const [chosen, setChosen] = useState(set.activeId);
  const armed = useArmed();
  const account = set.accounts.find((a) => a.id === chosen) ?? set.accounts[0]!;
  return (
    <div className="panel">
      <div className="panel-body">
        <div className="cx-section-title">Account to share</div>
        <ul className="cx-pick" role="radiogroup" aria-label="Account to share">
          {set.accounts.map((a) => (
            <li key={a.id}>
              <label className={'cx-pick-row' + (a.id === account.id ? ' is-on' : '')}>
                <input type="radio" name="cx-account" checked={a.id === account.id} onChange={() => setChosen(a.id)} />
                <Identicon address={a.address} size={22} />
                <span className="cx-pick-main">
                  <span className="cx-pick-label">{a.label}</span>
                  <span className="cx-pick-addr mono">{shortAddress(a.address)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="small muted">
          {hostOf(req.origin)} will see this address and its balances, and can ask you to sign messages and
          transactions. It can never move funds without your confirmation in this window. Revoke it any time under
          Connected sites.
        </p>
        <div className="cx-actions">
          <button className="btn" onClick={onReject} data-testid="cx-reject">
            Cancel
          </button>
          <button
            className="btn btn-primary"
            data-testid="cx-connect"
            disabled={!armed}
            onClick={() => {
              saveSites(withSite(loadSites(), req.origin, req.appName, [account.address], Date.now()));
              onApprove([account.address]);
            }}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- personal_sign ---------------- */

function SignReview({
  req,
  request,
  account,
  onApprove,
  onReject,
}: {
  req: IncomingRequest;
  request: PersonalSignRequest;
  account: SessionAccount;
  onApprove: (r: unknown) => void;
  onReject: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = siweDomainMismatch(request.text, req.origin);
  return (
    <div className="panel">
      <div className="panel-body">
        <AccountLine account={account} />
        <div className="cx-section-title">Message</div>
        <pre className="cx-message" data-testid="cx-message">
          {request.text ?? request.hex}
        </pre>
        {request.text === null && <p className="small muted">Shown as hex: these bytes are not readable text.</p>}
        {mismatch && (
          <div className="notice notice-danger" role="alert">
            This sign-in message is for <strong>{mismatch}</strong>, but it was sent by <strong>{hostOf(req.origin)}</strong>. Signing
            it could log someone else into your account there. Reject it unless you know why.
          </div>
        )}
        <p className="small muted">Signing proves you control this account. It costs nothing and sends no transaction.</p>
        <Actions
          busy={busy}
          error={error}
          approveLabel="Sign"
          onReject={onReject}
          onApprove={async () => {
            setBusy(true);
            setError(null);
            try {
              onApprove(await signPersonal(account.privateKey, request));
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        />
      </div>
    </div>
  );
}

/* ---------------- eth_signTypedData_v4 ---------------- */

function Value({ v, depth = 0 }: { v: unknown; depth?: number }) {
  if (v !== null && typeof v === 'object' && depth < 4) {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    return (
      <dl className="cx-tree">
        {entries.slice(0, 50).map(([k, x]) => (
          <div key={k} className="cx-tree-row">
            <dt>{k}</dt>
            <dd>
              <Value v={x} depth={depth + 1} />
            </dd>
          </div>
        ))}
        {entries.length > 50 && <div className="small muted">… {entries.length - 50} more</div>}
      </dl>
    );
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return <span className="mono cx-val">{s && s.length > 300 ? s.slice(0, 300) + '…' : s}</span>;
}

function TypedReview({
  request,
  account,
  onApprove,
  onReject,
}: {
  request: TypedDataRequest;
  account: SessionAccount;
  onApprove: (r: unknown) => void;
  onReject: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = request.domain;
  const permit = permitWarning(request);
  return (
    <div className="panel">
      <div className="panel-body">
        <AccountLine account={account} />
        {permit && (
          <div className="notice notice-danger" role="alert" data-testid="cx-permit">
            {permit}
          </div>
        )}
        <table className="confirm-table cx-table">
          <tbody>
            {typeof d.name === 'string' && (
              <tr>
                <th>Application</th>
                <td>{d.name}</td>
              </tr>
            )}
            {request.domainChainId !== null && (
              <tr>
                <th>Chain</th>
                <td>
                  {chainName(request.domainChainId)} · {request.domainChainId}
                </td>
              </tr>
            )}
            {typeof d.verifyingContract === 'string' && (
              <tr>
                <th>Contract</th>
                <td className="mono">{d.verifyingContract}</td>
              </tr>
            )}
            <tr>
              <th>Type</th>
              <td className="mono">{request.primaryType}</td>
            </tr>
          </tbody>
        </table>
        <div className="cx-section-title">Message</div>
        <div className="cx-message cx-message-tree" data-testid="cx-typed">
          <Value v={request.message} />
        </div>
        <p className="small muted">A typed signature can authorise a payment or a transfer inside the contract above. Sign only what you meant to.</p>
        <Actions
          busy={busy}
          error={error}
          approveLabel="Sign"
          onReject={onReject}
          onApprove={async () => {
            setBusy(true);
            setError(null);
            try {
              onApprove(await signTyped(account.privateKey, request));
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        />
      </div>
    </div>
  );
}

/* ---------------- eth_sendTransaction ---------------- */

type TxState =
  | { status: 'loading' }
  | { status: 'ready'; provider: JsonRpcProvider; prepared: PreparedCall; token: TokenFacts | null }
  | { status: 'fail'; reason: string }
  | { status: 'error'; message: string };

function describeCall(request: TxRequest, decoded: DecodedCall | null, token: TokenFacts | null, symbol: string): string {
  if (request.to === null) return 'Deploy a contract';
  if (!decoded) return request.data === '0x' ? `Send ${formatAmount(request.value)} ${symbol}` : 'Contract interaction';
  const arg = (n: string) => decoded.args.find((a) => a.name === n)?.raw as bigint | undefined;
  switch (decoded.name) {
    case 'deposit':
      if (request.value > 0n) return `Deposit ${formatAmount(request.value)} ${symbol}`;
      break;
    case 'swapExactFMXForTokens':
    case 'swapExactTokensForFMX':
    case 'swapExactTokensForTokens':
      return 'Swap';
    case 'addLiquidity':
    case 'addLiquidityFMX':
      return 'Add liquidity';
    case 'removeLiquidity':
    case 'removeLiquidityFMX':
      return 'Remove liquidity';
    case 'createPair':
      return 'Create a pool';
    case 'launch':
      return `Launch token ${String(decoded.args[1]?.raw ?? '')}`.trim();
    case 'register':
      return `Register agent “${String(decoded.args[0]?.raw ?? '').slice(0, 40)}”`;
    case 'mint':
      return `Mint #${String(decoded.args[0]?.raw ?? '')}`;
    default:
      break;
  }
  if (token && decoded.name === 'transfer') return `Send ${formatAmount(arg('amount') ?? 0n, token.decimals)} ${token.symbol}`;
  if (token && decoded.name === 'approve') {
    const amt = arg('amount') ?? 0n;
    return amt === 0n ? `Remove ${token.symbol} allowance` : `Allow spending ${isUnlimited(amt) ? 'all your' : formatAmount(amt, token.decimals)} ${token.symbol}`;
  }
  if (token && decoded.name === 'increaseAllowance') {
    const amt = arg('addedValue') ?? 0n;
    return `Allow spending ${isUnlimited(amt) ? 'all your' : `${formatAmount(amt, token.decimals)} more`} ${token.symbol}`;
  }
  if (decoded.name === 'setApprovalForAll') return (decoded.args[1]?.raw ? 'Allow transfer of all your NFTs in this collection' : 'Remove NFT approval');
  return `Call ${decoded.name}`;
}

function TxReview({
  req,
  request,
  account,
  onApprove,
  onReject,
}: {
  req: IncomingRequest;
  request: TxRequest;
  account: SessionAccount;
  onApprove: (r: unknown) => void;
  onReject: () => void;
}) {
  const [state, setState] = useState<TxState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const decoded = useMemo(() => decodeCalldata(request.data), [request.data]);
  const symbol = nativeSymbol(req.chainId);
  const decimals = CHAIN_META[req.chainId]?.nativeCurrency.decimals ?? 18;

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    (async () => {
      let provider: JsonRpcProvider;
      try {
        provider = await providerFor(req.chainId);
      } catch {
        if (alive) setState({ status: 'error', message: `Cannot reach ${chainName(req.chainId)} right now. Try again in a moment.` });
        return;
      }
      try {
        const tokenCall = decoded && request.to && ['transfer', 'approve', 'increaseAllowance', 'transferFrom'].includes(decoded.name);
        const [prepared, token] = await Promise.all([
          prepareCall(provider, req.chainId, request),
          tokenCall ? tokenFacts(provider, request.to!) : Promise.resolve(null),
        ]);
        if (alive) setState({ status: 'ready', provider, prepared, token });
      } catch (e) {
        if (!alive) return;
        if (e instanceof WouldFailError) setState({ status: 'fail', reason: e.message });
        else setState({ status: 'error', message: errorText(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [req.chainId, request, decoded, attempt]);

  const ready = state.status === 'ready' ? state : null;
  const token = ready?.token ?? null;
  const total = ready ? request.value + ready.prepared.maxFeeWei : null;
  const insufficient = ready && total !== null && total > ready.prepared.balance;
  // approve(spender, amount) and increaseAllowance(spender, addedValue) both
  // grant an allowance and both carry it at arg index 1.
  const grantsAllowance = decoded?.name === 'approve' || decoded?.name === 'increaseAllowance';
  const approveAmount = grantsAllowance ? (decoded!.args[1]?.raw as bigint | undefined) : undefined;
  const unlimited = approveAmount !== undefined && isUnlimited(approveAmount);
  // setApprovalForAll(operator, true): the whole collection, not one token
  const allNfts = decoded?.name === 'setApprovalForAll' && decoded.args[1]?.raw === true;

  return (
    <div className="panel">
      <div className="panel-body">
        <div className="cx-tx-title" data-testid="cx-tx-title">
          {describeCall(request, decoded, token, symbol)}
        </div>
        <table className="confirm-table cx-table">
          <tbody>
            <tr>
              <th>Network</th>
              <td>
                {chainName(req.chainId)} · {req.chainId}
              </td>
            </tr>
            <tr>
              <th>From</th>
              <td>
                <span className="cx-inline-acct">
                  <Identicon address={account.address} size={16} />
                  {account.label} <span className="mono muted">{shortAddress(account.address)}</span>
                </span>
              </td>
            </tr>
            <tr>
              <th>{request.to === null ? 'Creates' : 'To'}</th>
              <td className="mono">
                {request.to ?? 'a new contract'}
                {ready && request.to && (
                  <span className="acct-tag cx-tag">{ready.prepared.toIsContract ? 'CONTRACT' : 'ACCOUNT'}</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Amount</th>
              <td className="em num" title={formatAmountExact(request.value, decimals)} data-testid="cx-amount">
                {formatAmount(request.value, decimals)} {symbol}
              </td>
            </tr>
            {decoded && (
              <tr>
                <th>Function</th>
                <td>
                  <span className="mono">{decoded.name}</span>
                  <ul className="cx-args">
                    {decoded.args.map((a) => (
                      <li key={a.name}>
                        <span className="muted">{a.name}</span>{' '}
                        <span className="mono">
                          {token && a.type === 'uint256' && ['amount', 'addedValue'].includes(a.name)
                            ? isUnlimited(a.raw as bigint)
                              ? 'unlimited'
                              : `${formatUnits(a.raw as bigint, token.decimals)} ${token.symbol}`
                            : a.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            )}
            {!decoded && request.data !== '0x' && (
              <tr>
                <th>Data</th>
                <td className="mono">
                  {request.data.slice(0, 10)} · {(request.data.length - 2) / 2} bytes
                </td>
              </tr>
            )}
            <tr>
              <th>Network fee</th>
              <td className="num">
                {ready ? (
                  <>
                    up to {formatAmount(ready.prepared.maxFeeWei, decimals, 8)} {symbol}
                  </>
                ) : (
                  <span className="muted">estimating…</span>
                )}
              </td>
            </tr>
            {ready && total !== null && (
              <tr>
                <th>Total</th>
                <td className="em num" data-testid="cx-total">
                  up to {formatAmount(total, decimals, 8)} {symbol}
                </td>
              </tr>
            )}
            {ready && (
              <tr>
                <th>Balance</th>
                <td className="num">
                  {formatAmount(ready.prepared.balance, decimals)} {symbol}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {unlimited && (
          <div className="notice notice-danger" role="alert">
            This lets {shortAddress(String(decoded?.args[0]?.raw ?? ''))} take <strong>all</strong> of your {token?.symbol ?? 'tokens'}, now and later.
            Approve an exact amount in the site if it lets you.
          </div>
        )}
        {allNfts && (
          <div className="notice notice-danger" role="alert" data-testid="cx-approval-for-all">
            This lets <span className="mono">{shortAddress(String(decoded?.args[0]?.raw ?? ''))}</span> move <strong>every</strong> NFT you hold in
            this collection, now and later, without asking you again. Approve it only for a marketplace or contract you trust, and revoke it when
            you are done.
          </div>
        )}
        {state.status === 'loading' && (
          <p className="small muted cx-inline-status">
            <Spinner /> Checking the transaction against {chainName(req.chainId)}…
          </p>
        )}
        {state.status === 'fail' && (
          <div className="notice notice-danger" role="alert" data-testid="cx-would-fail">
            This transaction would fail: {state.reason}. Nothing has been sent.
          </div>
        )}
        {state.status === 'error' && (
          <div className="notice notice-danger" role="alert">
            {state.message}{' '}
            <button className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {insufficient && (
          <div className="notice notice-danger" role="alert">
            Not enough {symbol}: this needs up to {formatAmount(total!, decimals, 8)} {symbol} including the fee.
          </div>
        )}

        <Actions
          busy={busy}
          error={error}
          approveLabel="Confirm"
          disabled={!ready || Boolean(insufficient)}
          onReject={onReject}
          onApprove={async () => {
            if (!ready) return;
            setBusy(true);
            setError(null);
            try {
              const hash = await signAndSend(account.privateKey, ready.provider, ready.prepared);
              // an open wallet tab refreshes now, and again when it lands
              announceTx({ chainId: req.chainId, from: account.address, hash });
              onApprove(hash);
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        />
      </div>
    </div>
  );
}

/* ---------------- wallet_watchAsset ---------------- */

function WatchReview({ request, onApprove, onReject }: { request: WatchAssetRequest; onApprove: (r: unknown) => void; onReject: () => void }) {
  const [facts, setFacts] = useState<TokenFacts | null | 'loading'>('loading');
  useEffect(() => {
    let alive = true;
    providerFor(FERMINUX_CHAIN_ID)
      .then((p) => tokenFacts(p, request.address))
      .then((f) => alive && setFacts(f))
      .catch(() => alive && setFacts(null));
    return () => {
      alive = false;
    };
  }, [request.address]);
  // Listed already, by the user or by default: adding changes nothing, but the site still gets its answer.
  const known = [...loadTokenAddresses(), ...DEFAULT_TOKENS.map((t) => t.address)].some(
    (a) => a.toLowerCase() === request.address.toLowerCase(),
  );
  const f = facts === 'loading' ? null : facts;
  const symbolDiffers = f && f.symbol !== request.symbol;
  const decimalsDiffer = f && f.decimals !== request.decimals;
  return (
    <div className="panel">
      <div className="panel-body">
        <table className="confirm-table cx-table">
          <tbody>
            <tr>
              <th>Token</th>
              <td className="mono">{request.address}</td>
            </tr>
            <tr>
              <th>Symbol</th>
              <td className="em">{f ? f.symbol : request.symbol}</td>
            </tr>
            <tr>
              <th>Decimals</th>
              <td className="num">{f ? f.decimals : request.decimals}</td>
            </tr>
            <tr>
              <th>Network</th>
              <td>Ferminux Network · 3961</td>
            </tr>
          </tbody>
        </table>
        {facts === 'loading' && (
          <p className="small muted cx-inline-status">
            <Spinner /> Reading the token contract…
          </p>
        )}
        {facts === null && (
          <div className="notice notice-danger" role="alert">
            This address does not answer as an FRC-20 token on Ferminux Network.
          </div>
        )}
        {(symbolDiffers || decimalsDiffer) && (
          <div className="notice notice-warn">
            The site said {request.symbol} with {request.decimals} decimals; the contract says {f!.symbol} with {f!.decimals}. The wallet uses
            what the contract says.
          </div>
        )}
        {known && <p className="small muted">This token is already in your list.</p>}
        <Actions
          busy={false}
          error={null}
          approveLabel="Add token"
          disabled={!f}
          onReject={onReject}
          testId="cx-add-token"
          onApprove={() => {
            if (!known) saveTokenAddresses([...loadTokenAddresses(), request.address]);
            onApprove(true);
          }}
        />
      </div>
    </div>
  );
}
