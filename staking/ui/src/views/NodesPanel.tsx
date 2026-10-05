// NODES: the live roster from the registry, plus a register-a-node flow for
// desktop-app operators — with a plain-words explanation of what a node
// actually does on an authority chain (service, not security).
//
// Registration needs a signature from the NODE's own key (its devp2p nodekey)
// proving possession. That key never enters this page: the form shows the
// digest, the operator signs it on the node's machine, and pastes the result.

import { useEffect, useMemo, useState } from 'react';
import { CHAIN_ID, EXPLORER_URL, NODE_REGISTRY_ADDRESS } from '../config.ts';
import type { ChainState } from '../state/useChain.ts';
import type { WalletState } from '../state/useWallet.ts';
import type { Poll, RosterData } from '../state/useStakingData.ts';
import type { Position } from '../lib/staking.ts';
import { humanizeTxError } from '../lib/staking.ts';
import { TIER_IDS } from '../lib/tiers.ts';
import {
  registerNode,
  deregisterNode,
  fetchBondedPositions,
  registrationDigest,
  checkPossessionSignature,
  enodePubkeyBytes,
  enodeToNodeAddress,
  checkConsensusAddress,
  type NetworkNode,
} from '../lib/nodes.ts';
import { formatFMX, formatBps, formatAgo, formatDuration, shortAddress } from '../lib/format.ts';
import { CopyButton, Modal, Spinner, Skeleton } from '../components/ui.tsx';

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
  const [deregFor, setDeregFor] = useState<NetworkNode | null>(null);

  // listActiveNodes() already leaves out nodes whose bond exited or fell below the minimum.
  const activeNodes = roster.data?.nodes ?? null;
  const me = wallet.address?.toLowerCase() ?? null;

  // Validator-track positions big enough to bond a node; whether one already
  // bonds a node is asked of the registry when the form opens.
  const candidates = useMemo(() => {
    if (!positions.data || !roster.data) return [];
    return positions.data.filter(
      (p) => p.state === 'active' && p.tier === TIER_IDS.Validator && p.amountWei >= roster.data!.minBondWei,
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
        is a validator-track stake — skin in the game that earns 2.0×, and 3.0× while its node holds the uptime
        boost. It does not give a signing seat: the signer set stays the authorised set the foundation operates.
        Run the node with the Ferminux desktop app, then register it here.
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
                    <th>Node address</th>
                    <th className="r">Bond</th>
                    <th className="r">Uptime</th>
                    <th className="r">Boost</th>
                    <th className="r">Last seen</th>
                    <th className="r" aria-label="Actions" />
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
                      <td className="mono" title={n.nodeAddress}>
                        {shortAddress(n.nodeAddress)}
                      </td>
                      <td className="r num">{formatFMX(n.bondWei, 0)} FMX</td>
                      <td className="r num">{n.lastSeen === 0 && n.uptimeBps === 0n ? '—' : formatBps(n.uptimeBps)}</td>
                      <td className="r">{n.boosted ? 'on' : '—'}</td>
                      <td className="r num">{formatAgo(n.lastSeen, now)}</td>
                      <td className="r">
                        {me !== null && n.operator.toLowerCase() === me && (
                          <button className="btn btn-sm btn-ghost" onClick={() => setDeregFor(n)}>
                            Deregister
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            &ldquo;Last seen&rdquo; and uptime come from the watchtower&apos;s signed daily attestations — an
            operator-run oracle with published challenge logs, not a trustless proof. Each epoch sits in a{' '}
            {roster.data ? formatDuration(roster.data.disputeWindowSeconds) : '7d'} dispute window before it counts.
            It can only affect the validator tier&apos;s 2.0×→3.0× uptime step (at{' '}
            {roster.data ? formatBps(roster.data.boostThresholdBps) : '95%'} or better), never principal.
          </p>
        </>
      )}

      {deregFor && (
        <DeregisterModal
          chain={chain}
          wallet={wallet}
          node={deregFor}
          onClose={() => setDeregFor(null)}
          onDone={onDone}
        />
      )}

      {registerOpen && roster.data && (
        <RegisterModal
          chain={chain}
          wallet={wallet}
          candidates={candidates}
          minBondWei={roster.data.minBondWei}
          disputeWindowSeconds={roster.data.disputeWindowSeconds}
          positionsLoading={positions.loading}
          onClose={() => setRegisterOpen(false)}
          onGoStake={() => {
            setRegisterOpen(false);
            onGoStake();
          }}
          onDone={onDone}
        />
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */

function RegisterModal({
  chain,
  wallet,
  candidates,
  minBondWei,
  disputeWindowSeconds,
  positionsLoading,
  onClose,
  onGoStake,
  onDone,
}: {
  chain: ChainState;
  wallet: WalletState;
  candidates: Position[];
  minBondWei: bigint;
  disputeWindowSeconds: number;
  positionsLoading: boolean;
  onClose: () => void;
  onGoStake: () => void;
  onDone: () => void;
}) {
  const [bonded, setBonded] = useState<Set<string> | null>(null);
  const [positionId, setPositionId] = useState<string>('');
  const [consensusRaw, setConsensusRaw] = useState('');
  const [enodeRaw, setEnodeRaw] = useState('');
  const [sigRaw, setSigRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<'form' | 'signing' | 'pending' | 'done' | 'error'>('form');
  const [message, setMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // One node per position: ask the registry which candidates already bond one.
  // Keyed on the ids, not the array, so the 10 s position poll does not re-ask;
  // the previous answer stays on screen until the next one arrives.
  const candidateIds = candidates.map((p) => p.id.toString()).join(',');
  useEffect(() => {
    if (!chain.provider) return;
    let alive = true;
    fetchBondedPositions(
      chain.provider,
      NODE_REGISTRY_ADDRESS,
      candidateIds === '' ? [] : candidateIds.split(',').map((id) => BigInt(id)),
    )
      .then((set) => {
        if (alive) setBonded(set);
      })
      .catch(() => {
        // Unknown: list every candidate; the contract preflight refuses a duplicate in plain words.
        if (alive) setBonded(new Set());
      });
    return () => {
      alive = false;
    };
  }, [chain.provider, candidateIds]);

  const eligible = useMemo(
    () => (bonded === null ? [] : candidates.filter((p) => !bonded.has(p.id.toString()))),
    [candidates, bonded],
  );
  useEffect(() => {
    if (eligible.length > 0 && !eligible.some((p) => p.id.toString() === positionId)) {
      setPositionId(eligible[0].id.toString());
    }
  }, [eligible, positionId]);

  const consensus = checkConsensusAddress(consensusRaw);
  const pubkey = enodePubkeyBytes(enodeRaw);
  const nodeAddress = enodeToNodeAddress(enodeRaw);
  const enodeError = touched && enodeRaw.trim() !== '' && pubkey === null;
  const digest =
    wallet.address && consensus.ok && nodeAddress && positionId !== ''
      ? registrationDigest(CHAIN_ID, NODE_REGISTRY_ADDRESS, wallet.address, consensus.address, BigInt(positionId))
      : null;
  const sig = digest && nodeAddress ? checkPossessionSignature(sigRaw, digest, nodeAddress) : null;
  const sigError = sigRaw.trim() !== '' && sig !== null && !sig.ok ? sig.error : null;
  const signCommand = digest
    ? `cast wallet sign --no-hash ${digest} --private-key 0x$(cat <node datadir>/ferminux-geth/nodekey)`
    : null;

  const submit = async () => {
    if (!chain.provider || !consensus.ok || pubkey === null || sig === null || !sig.ok || positionId === '') return;
    setPhase('signing');
    setMessage(null);
    try {
      const signer = await wallet.getSigner(chain.provider);
      const resp = await registerNode(signer, NODE_REGISTRY_ADDRESS, {
        pubkey,
        consensusAddr: consensus.address,
        positionId: BigInt(positionId),
        signature: sig,
      });
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

  if (phase === 'form' && (positionsLoading || bonded === null)) {
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
            and the 3.0× uptime step follows its first ≥95% attested epoch once that epoch clears the{' '}
            {formatDuration(disputeWindowSeconds)} dispute window.
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
            Run the node in the Ferminux desktop app first. The consensus address is your node&apos;s key, recorded
            in the registry (it confirms no blocks: the signers are the authorised set); the enode URL identifies
            the node itself (Settings → Node info). The node then proves it is yours by signing this registration
            with its own key.
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
            {nodeAddress !== null && (
              <div className="field-hint mono">
                On-chain node address: {nodeAddress} (derived from the node key — IP changes don&apos;t matter)
              </div>
            )}
          </div>
          {digest !== null && signCommand !== null && (
            <div className="field">
              <label htmlFor="reg-sig">Node key signature</label>
              <div className="field-hint" style={{ marginTop: 0, marginBottom: 8 }}>
                On the node&apos;s machine, sign this digest with the node&apos;s own key (its{' '}
                <span className="mono">nodekey</span> file) as a raw 32-byte hash, with no message prefix — for
                example with Foundry:
              </div>
              <div className="actions-row" style={{ marginBottom: 8 }}>
                <code className="mono small" style={{ wordBreak: 'break-all' }}>
                  {signCommand}
                </code>
                <span className="push" />
                <CopyButton text={signCommand} label="Copy command" />
              </div>
              <textarea
                id="reg-sig"
                className={'input input-mono' + (sigError ? ' input-error' : '')}
                placeholder="0x… (65 bytes)"
                spellCheck={false}
                value={sigRaw}
                onChange={(e) => setSigRaw(e.target.value)}
              />
              {sigError ? (
                <div className="field-error">{sigError}</div>
              ) : (
                <div className="field-hint">
                  The node key never enters this page. The digest binds this chain, the registry, your wallet, the
                  consensus address and the position, so the signature is good for this registration only.
                </div>
              )}
            </div>
          )}
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
              disabled={!consensus.ok || pubkey === null || sig === null || !sig.ok || positionId === ''}
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

/* ------------------------------------------------------------------ */

function DeregisterModal({
  chain,
  wallet,
  node,
  onClose,
  onDone,
}: {
  chain: ChainState;
  wallet: WalletState;
  node: NetworkNode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<'confirm' | 'signing' | 'pending' | 'done' | 'error'>('confirm');
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    if (!chain.provider) return;
    setPhase('signing');
    setMessage(null);
    try {
      const signer = await wallet.getSigner(chain.provider);
      const resp = await deregisterNode(signer, NODE_REGISTRY_ADDRESS, node.id);
      setPhase('pending');
      const receipt = await resp.wait();
      if (receipt?.status !== 1) throw new Error('Transaction reverted on chain.');
      setPhase('done');
      onDone();
    } catch (e) {
      setMessage(humanizeTxError(e));
      setPhase('error');
    }
  };

  return (
    <Modal title="Deregister node" onClose={onClose}>
      {phase === 'done' ? (
        <>
          <div className="notice notice-success">Node {shortAddress(node.nodeAddress)} deregistered.</div>
          <button className="btn btn-block" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <>
          <p className="small">
            Deregistering node <span className="mono">{shortAddress(node.nodeAddress)}</span> frees its node key,
            consensus address and bonding position for a new registration, and drops any uptime boost on the bond
            — it earns 2.0× again. The {formatFMX(node.bondWei, 0)} FMX bond itself stays staked.
          </p>
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
            <div className="actions-row">
              <button className="btn" onClick={onClose}>
                Keep it registered
              </button>
              <button className="btn btn-danger-ghost push" onClick={() => void submit()}>
                Deregister node
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
