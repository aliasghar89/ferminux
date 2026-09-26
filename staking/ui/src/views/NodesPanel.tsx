// NODES: the live roster from the registry, plus a register-a-node flow for
// desktop-app operators — with a plain-words explanation of what a node
// actually does on an authority chain (service, not security).

import { useMemo, useState } from 'react';
import { EXPLORER_URL, NODE_REGISTRY_ADDRESS } from '../config.ts';
import type { ChainState } from '../state/useChain.ts';
import type { WalletState } from '../state/useWallet.ts';
import type { Poll, RosterData } from '../state/useStakingData.ts';
import type { Position } from '../lib/staking.ts';
import { humanizeTxError } from '../lib/staking.ts';
import { registerNode, enodeToId, checkConsensusAddress } from '../lib/nodes.ts';
import { formatFMX, formatBps, formatAgo, shortAddress, formatDate } from '../lib/format.ts';
import { Modal, Spinner, Skeleton } from '../components/ui.tsx';

export function NodesPanel({
  chain,
  wallet,
  roster,
  positions,
  deployed,
  now,
  onConnect,
  onDone,
  onGoStake,
}: {
  chain: ChainState;
  wallet: WalletState;
  roster: Poll<RosterData>;
  positions: Poll<Position[]>;
  deployed: boolean;
  now: number;
  onConnect: () => void;
  onDone: () => void;
  onGoStake: () => void;
}) {
  const [registerOpen, setRegisterOpen] = useState(false);

  const nodes = roster.data?.nodes ?? null;
  const activeNodes = nodes?.filter((n) => n.active) ?? null;

  const eligible = useMemo(() => {
    if (!positions.data || !roster.data) return [];
    const registered = new Set(roster.data.nodes.filter((n) => n.active).map((n) => n.positionId.toString()));
    return positions.data.filter(
      (p) =>
        p.state === 'active' &&
        p.tier === roster.data!.validatorTier &&
        p.amountWei >= roster.data!.minBondWei &&
        !registered.has(p.id.toString()),
    );
  }, [positions.data, roster.data]);

  return (
    <div className="panel-body">
      {/* plain words first */}
      <div className="notice">
        <strong>What a node does today.</strong> Ferminux uses authority consensus — a set of authorised signers
        confirms blocks — and running a node does <strong>not</strong> add security. What extra nodes genuinely add: faster block and transaction
        propagation, more RPC capacity, redundant copies of the chain data, and resistance to eclipse attacks on
        light clients. The <strong>{roster.data ? formatFMX(roster.data.minBondWei, 0) : '25,000'} FMX bond</strong>{' '}
        is a validator-track stake — skin in the game that earns the 3.0× tier. It does not give a signing seat:
        the signer set stays the authorised set the foundation operates. Run the node with the Ferminux desktop
        app, then register it here.
      </div>

      {!deployed ? (
        <div className="empty-state">
          <div className="title">Registry not live yet</div>
          The node roster will appear here once the contracts are deployed.
        </div>
      ) : roster.loading ? (
        <div>
          <Skeleton width={300} />
          <div style={{ marginTop: 10 }}>
            <Skeleton width={240} />
          </div>
        </div>
      ) : roster.error && !roster.data ? (
        <div className="notice notice-danger mb-0" role="alert">
          Could not load the node roster: {roster.error}{' '}
          <button className="btn btn-sm" onClick={roster.refresh} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="actions-row" style={{ marginBottom: 12 }}>
            <span className="small muted num">
              {activeNodes!.length} bonded node{activeNodes!.length === 1 ? '' : 's'} — on-chain bonds; one operator
              can run several, so this is not a count of distinct operators.
            </span>
            <span className="push" />
            {wallet.address === null ? (
              <button className="btn btn-sm" onClick={onConnect}>
                Connect to register a node
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => setRegisterOpen(true)}>
                Register a node
              </button>
            )}
          </div>

          {activeNodes!.length === 0 ? (
            <div className="empty-state">
              <div className="title">No nodes registered yet</div>
              Be the first: stake a validator-track bond, run the desktop app, register the node here.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="roster-table">
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Node id</th>
                    <th className="r">Bond</th>
                    <th className="r">Uptime</th>
                    <th className="r">Last seen</th>
                    <th className="r">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {activeNodes!.map((n) => (
                    <tr key={n.id.toString()}>
                      <td>
                        <a
                          href={`${EXPLORER_URL}/address/${n.operator}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mono"
                          title={n.operator}
                        >
                          {shortAddress(n.operator)}
                        </a>
                      </td>
                      <td className="mono" title={n.enodeId}>
                        {n.enodeId.slice(0, 10)}…
                      </td>
                      <td className="r num">{formatFMX(n.bondWei, 0)} FMX</td>
                      <td className="r num">{n.lastSeen === 0 ? '—' : formatBps(n.uptimeBps)}</td>
                      <td className="r num">{formatAgo(n.lastSeen, now)}</td>
                      <td className="r num">{formatDate(n.registeredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            &ldquo;Last seen&rdquo; and uptime come from the watchtower&apos;s signed daily attestations — an
            operator-run oracle with published challenge logs, not a trustless proof. It can only affect the
            validator tier&apos;s 2.0×→3.0× uptime step, never principal.
          </p>
        </>
      )}

      {registerOpen && roster.data && (
        <RegisterModal
          chain={chain}
          wallet={wallet}
          eligible={eligible}
          minBondWei={roster.data.minBondWei}
          positionsLoading={positions.loading}
          onClose={() => setRegisterOpen(false)}
          onGoStake={() => {
            setRegisterOpen(false);
            onGoStake();
          }}
          onDone={() => {
            setRegisterOpen(false);
            onDone();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RegisterModal({
  chain,
  wallet,
  eligible,
  minBondWei,
  positionsLoading,
  onClose,
  onGoStake,
  onDone,
}: {
  chain: ChainState;
  wallet: WalletState;
  eligible: Position[];
  minBondWei: bigint;
  positionsLoading: boolean;
  onClose: () => void;
  onGoStake: () => void;
  onDone: () => void;
}) {
  const [positionId, setPositionId] = useState<string>(eligible[0]?.id.toString() ?? '');
  const [consensusRaw, setConsensusRaw] = useState('');
  const [enodeRaw, setEnodeRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<'form' | 'signing' | 'pending' | 'done' | 'error'>('form');
  const [message, setMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const consensus = checkConsensusAddress(consensusRaw);
  const enodeId = enodeToId(enodeRaw);
  const enodeError = touched && enodeRaw.trim() !== '' && enodeId === null;

  const submit = async () => {
    if (!chain.provider || !consensus.ok || enodeId === null || positionId === '') return;
    setPhase('signing');
    setMessage(null);
    try {
      const signer = await wallet.getSigner(chain.provider);
      const resp = await registerNode(signer, NODE_REGISTRY_ADDRESS, BigInt(positionId), consensus.address, enodeId);
      setPhase('pending');
      setTxHash(resp.hash);
      const receipt = await resp.wait();
      if (receipt?.status !== 1) throw new Error('Transaction reverted on chain.');
      setPhase('done');
      onDone();
    } catch (e) {
      setMessage(humanizeTxError(e));
      setPhase('error');
    }
  };

  if (positionsLoading) {
    return (
      <Modal title="Register a node" onClose={onClose}>
        <p className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner /> Checking your positions…
        </p>
      </Modal>
    );
  }

  if (eligible.length === 0 && phase === 'form') {
    return (
      <Modal title="Register a node" onClose={onClose}>
        <p className="small">
          Registering a node needs an <strong>active validator-track position of at least{' '}
          {formatFMX(minBondWei, 0)} FMX</strong> that does not already have a node attached. You have none right
          now.
        </p>
        <p className="small muted">
          Stake {formatFMX(minBondWei, 0)} FMX in the Validator track tier first, then come back here.
        </p>
        <button className="btn btn-primary btn-block" onClick={onGoStake}>
          Go to Stake
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="Register a node" onClose={onClose}>
      {phase === 'done' ? (
        <>
          <div className="notice notice-success">
            Node registered. It appears in the roster immediately; the watchtower starts probing it within a day,
            and the 3.0× uptime step follows its first ≥95% attested epoch.
          </div>
          {txHash && (
            <p className="small">
              <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer noopener">
                View transaction ↗
              </a>
            </p>
          )}
          <button className="btn btn-block" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <>
          <p className="small muted">
            Run the node in the Ferminux desktop app first. Both values below come from it: the consensus address
            is your node&apos;s key, recorded in the registry (it confirms no blocks: the signers are the authorised
            set); the enode URL identifies the node itself (Settings → Node info).
          </p>
          <div className="field">
            <label htmlFor="reg-pos">Bonded position</label>
            <select
              id="reg-pos"
              className="input"
              value={positionId}
              onChange={(e) => setPositionId(e.target.value)}
            >
              {eligible.map((p) => (
                <option key={p.id.toString()} value={p.id.toString()}>
                  #{p.id.toString()} — {formatFMX(p.amountWei, 0)} FMX validator bond
                </option>
              ))}
            </select>
            <div className="field-hint">One node per bonded position.</div>
          </div>
          <div className="field">
            <label htmlFor="reg-consensus">Consensus signing address</label>
            <input
              id="reg-consensus"
              className={'input input-mono' + (touched && consensusRaw !== '' && !consensus.ok ? ' input-error' : '')}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              value={consensusRaw}
              onChange={(e) => {
                setConsensusRaw(e.target.value);
                setTouched(true);
              }}
            />
            {touched && consensusRaw !== '' && !consensus.ok && <div className="field-error">{consensus.error}</div>}
          </div>
          <div className="field">
            <label htmlFor="reg-enode">Node enode URL</label>
            <textarea
              id="reg-enode"
              className={'input input-mono' + (enodeError ? ' input-error' : '')}
              placeholder="enode://<128 hex chars>@host:port"
              spellCheck={false}
              value={enodeRaw}
              onChange={(e) => {
                setEnodeRaw(e.target.value);
                setTouched(true);
              }}
            />
            {enodeError && (
              <div className="field-error">
                Not an enode URL — expected enode://&lt;128 hex characters&gt;@host:port.
              </div>
            )}
            {enodeId !== null && (
              <div className="field-hint mono">
                On-chain node id: {enodeId.slice(0, 18)}… (keccak256 of the node key — IP changes don&apos;t matter)
              </div>
            )}
          </div>
          {phase === 'error' && message && (
            <div className="notice notice-danger" role="alert">
              {message}
            </div>
          )}
          {phase === 'signing' || phase === 'pending' ? (
            <p className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner />
              {phase === 'signing' ? 'Waiting for your wallet…' : 'Waiting for the chain to confirm…'}
            </p>
          ) : (
            <button
              className="btn btn-primary btn-block"
              disabled={!consensus.ok || enodeId === null || positionId === ''}
              onClick={() => void submit()}
            >
              Register node
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
