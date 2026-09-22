#!/usr/bin/env node
/**
 * Ferminux bridge watcher.
 *
 * Reads both bridges, prints ONE LINE per notable event, and cross-checks every
 * `Executed` against a `Sent` on the counterpart chain. It signs nothing, holds no
 * key, and sends no transaction — it is deliberately powerless, so it can be run
 * anywhere, by anyone, without extending trust to the host.
 *
 * Its job is to make the bridge's fast defences usable. `pause()`, `cancelAction()`
 * and `decreaseTokenLimits()` are all instant and all human-triggered; without
 * something watching, the first notice of a forged quorum is a user complaint.
 *
 *   node watch.mjs --config watcher.config.json          # follow forever
 *   node watch.mjs --config watcher.config.json --once   # one pass, then exit
 *   node watch.mjs --config watcher.config.json --from-latest   # ignore history
 *
 * Every line is `SEVERITY | chain | event | detail`, single-line and greppable, so
 * it can be piped straight into a monitor, a log shipper or a phone notifier.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ethers } from '../relayer/node_modules/ethers/lib.esm/index.js';
import { Reconciler, EVENT_SEVERITY, SEVERITY, usageSeverity, limitChangeSeverity, fmtAmount, EdgeTracker } from './reconcile.mjs';

// Level-type conditions (cap pressure, paused) are reported on change only.
const edges = new EdgeTracker();

const ABI = [
  'event Sent(bytes32 indexed transferId, uint64 indexed dstChainId, address indexed localToken, uint64 srcChainId, uint64 nonce, address remoteToken, address sender, address recipient, uint256 amount, uint256 fee)',
  'event Executed(bytes32 indexed transferId, uint64 indexed srcChainId, address indexed localToken, address remoteToken, address recipient, uint256 amount, uint256 signatureCount)',
  'event TokenRegistered(address indexed localToken, uint8 kind, uint64 indexed remoteChainId, address indexed remoteToken, uint256 maxPerTransfer, uint256 dailyCap)',
  'event TokenLimitsChanged(address indexed localToken, uint256 maxPerTransfer, uint256 dailyCap, bool immediate)',
  'event RemoteBridgeChanged(uint64 indexed remoteChainId, address indexed remoteBridgeAddress)',
  'event ShortDeliveryAllowed(bytes32 indexed transferId, address indexed localToken, address indexed recipient, uint256 owed)',
  'event ShortDeliveryRevoked(bytes32 indexed transferId)',
  'event ShortDelivery(bytes32 indexed transferId, uint256 owed, uint256 paid, uint256 delivered)',
  'event ValidatorAdded(address indexed validator)',
  'event ValidatorRemoved(address indexed validator)',
  'event ThresholdChanged(uint256 threshold)',
  'event FeeBpsChanged(uint256 feeBps)',
  'event FeeCollectorChanged(address indexed feeCollector)',
  'event FeesWithdrawn(address indexed token, address indexed to, uint256 amount)',
  'event Paused(address indexed account)',
  'event Unpaused(address indexed account)',
  'event TokenPaused(address indexed localToken, address indexed account)',
  'event TokenUnpaused(address indexed localToken, address indexed account)',
  'event PauserSet(address indexed account, bool allowed)',
  'event ActionQueued(uint256 indexed actionId, bytes4 indexed selector, bytes data, uint64 eta)',
  'event ActionExecuted(uint256 indexed actionId, bytes4 indexed selector)',
  'event ActionCanceled(uint256 indexed actionId, bytes4 indexed selector)',
  'event TimelockDelayChanged(uint64 delay)',
  'event OwnershipTransferStarted(address indexed newOwner, uint64 expiry)',
  'event OwnershipTransferCanceled(address indexed canceledOwner)',
  'event OwnershipTransferred(address indexed oldOwner, address indexed newOwner)',
  'event BridgeTokenCodehashChanged(bytes32 codehash)',
  'event WrapperBridgeRotationProposed(address indexed localToken, address indexed newBridge)',
  'event WrapperBridgeRotationCanceled(address indexed localToken)',
  'event WrapperAdopted(address indexed localToken)',
  'event Rescued(address indexed token, address indexed to, uint256 amount)',
  'function outboundUsage(address) view returns (uint256)',
  'function inboundUsage(address) view returns (uint256)',
  // NOTE the field order: `paused` is SECOND, not last. Getting it wrong decodes
  // every field shifted by one — remoteChainId reads as `paused`, the remote token
  // address reads as maxPerTransfer, and the cap-pressure comparison is then made
  // against a number with no meaning. Verified against struct TokenConfig in
  // FerminuxBridge.sol, and cross-checked against the TokenRegistered event.
  'function tokenConfig(address) view returns (uint8 kind, bool paused, uint64 remoteChainId, address remoteToken, uint256 maxPerTransfer, uint256 dailyCap)',
  'function paused() view returns (bool)',
];

const iface = new ethers.Interface(ABI);

function parseArgs(argv) {
  const out = { once: false, fromLatest: false, config: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--from-latest') out.fromLatest = true;
    else if (a === '--config') out.config = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.config) throw new Error('--config <file> is required');
  return out;
}

/** Emit one line. Never throws — a formatting bug must not take the watcher down. */
function emit(severity, chain, event, detail) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`${severity.toUpperCase()} | ${ts} | ${chain} | ${event} | ${detail}\n`);
}

/**
 * A provider that tries every configured endpoint before giving up.
 *
 * Not a quorum — the watcher makes no signing decision, so one honest endpoint is
 * enough for it to raise an alarm. It is failover only, so a rate-limited public
 * RPC cannot silence the alarm, which is the failure that actually matters here.
 */
class Endpoints {
  constructor(urls, chainId, name) {
    if (!urls?.length) throw new Error(`chain ${name}: at least one rpcUrl is required`);
    this.name = name;
    this.providers = urls.map((u) => new ethers.JsonRpcProvider(u, chainId, { staticNetwork: true }));
    this.urls = urls;
    this.cursor = 0;
  }
  async call(fn) {
    let lastErr;
    for (let i = 0; i < this.providers.length; i++) {
      const idx = (this.cursor + i) % this.providers.length;
      try {
        const r = await fn(this.providers[idx]);
        this.cursor = idx; // stick to whatever answered
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`all ${this.providers.length} endpoints failed for ${this.name}: ${lastErr?.message ?? lastErr}`);
  }
}

function loadState(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // a corrupt state file must not stop the watcher from starting
  }
}

/** Write atomically so a crash mid-write cannot leave an unparseable state file. */
function saveState(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  renameSync(tmp, path);
}

async function main() {
  const args = parseArgs(process.argv);
  const cfgPath = resolve(args.config);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const statePath = resolve(dirname(cfgPath), cfg.statePath ?? 'watcher.state.json');

  const chains = new Map();
  for (const c of cfg.chains) {
    chains.set(Number(c.chainId), {
      ...c,
      chainId: Number(c.chainId),
      ep: new Endpoints(c.rpcUrls, Number(c.chainId), c.name),
    });
  }

  const prior = loadState(statePath);
  const rec = Reconciler.fromJSON(prior?.reconciler, { graceBlocks: cfg.graceBlocks ?? 200 });
  // Amounts round-trip through JSON as strings; restore them so comparisons are
  // bigint-to-bigint rather than the silent string comparison that would always
  // "match" and defeat the amount check.
  for (const m of [rec.sent, rec.pending]) {
    for (const [, v] of m) if (typeof v.amount === 'string') v.amount = BigInt(v.amount);
  }
  const cursors = new Map(Object.entries(prior?.cursors ?? {}).map(([k, v]) => [Number(k), Number(v)]));

  emit('info', 'watcher', 'start', `chains=${[...chains.values()].map((c) => c.name).join(',') } state=${statePath} grace=${rec.graceBlocks}`);

  // Prime cursors for any chain we have never scanned.
  for (const c of chains.values()) {
    if (cursors.has(c.chainId)) continue;
    const head = await c.ep.call((p) => p.getBlockNumber());
    const start = args.fromLatest ? head : Math.max(0, head - (c.backfillBlocks ?? 0));
    cursors.set(c.chainId, start);
    emit('info', c.name, 'cursor', `starting at block ${start} (head ${head})`);
  }

  const knownLimits = new Map(Object.entries(prior?.knownLimits ?? {}));
  let lastUsageCheck = 0;

  async function tick() {
    const scannedHeads = new Map();

    for (const c of chains.values()) {
      let head;
      try {
        head = await c.ep.call((p) => p.getBlockNumber());
      } catch (e) {
        emit('warn', c.name, 'rpc-down', String(e.message).slice(0, 200));
        continue;
      }
      const safe = head - (c.confirmations ?? 12);
      let from = cursors.get(c.chainId) + 1;
      if (safe < from) {
        scannedHeads.set(c.chainId, cursors.get(c.chainId));
        continue;
      }

      const span = c.maxBlockRange ?? 2000;
      while (from <= safe) {
        const to = Math.min(from + span - 1, safe);
        let logs;
        try {
          logs = await c.ep.call((p) => p.getLogs({ address: c.bridgeAddress, fromBlock: from, toBlock: to }));
        } catch (e) {
          emit('warn', c.name, 'getlogs-failed', `${from}-${to}: ${String(e.message).slice(0, 160)}`);
          break; // leave the cursor put; retry the same range next tick
        }

        for (const log of logs) {
          let parsed;
          try {
            parsed = iface.parseLog(log);
          } catch {
            continue; // an event this build does not know about
          }
          handleEvent(c, parsed, log, rec, knownLimits, cursors);
        }

        cursors.set(c.chainId, to);
        from = to + 1;
      }
      scannedHeads.set(c.chainId, cursors.get(c.chainId));
    }

    // Anything still unexplained after the source chain has moved on is reported
    // exactly once, at the loudest severity this tool has.
    for (const f of rec.overdue(scannedHeads)) {
      const src = chains.get(Number(f.srcChainId));
      const dst = chains.get(Number(f.chainId));
      emit(
        'critical',
        dst?.name ?? f.chainId,
        'UNMATCHED-EXECUTION',
        `transferId=${f.transferId} claims to originate on ${src?.name ?? f.srcChainId} but NO Sent was found after ` +
          `${f.scannedPast} further source blocks. amount=${fmtAmount(BigInt(f.amount))} recipient=${f.recipient}. ` +
          `THIS IS WHAT A FORGED QUORUM LOOKS LIKE — call pause() on ${dst?.name ?? 'the destination bridge'} now.`
      );
    }

    // Cap pressure, checked on its own slower cadence since it costs RPC calls.
    const now = Date.now();
    if (now - lastUsageCheck > (cfg.usageIntervalMs ?? 120_000)) {
      lastUsageCheck = now;
      for (const c of chains.values()) {
        for (const token of c.watchTokens ?? []) {
          try {
            const contract = new ethers.Contract(c.bridgeAddress, ABI, await c.ep.call(async (p) => p));
            const cfgT = await contract.tokenConfig(token);
            const cap = cfgT.dailyCap;
            if (cap === 0n) continue;
            for (const dir of ['outbound', 'inbound']) {
              const used = await contract[`${dir}Usage`](token);
              const u = usageSeverity(used, cap);
              // Level-type condition: say it when it changes, not every poll.
              const t = edges.transition(`cap:${c.name}:${dir}:${token}`, u?.severity ?? null);
              if (t?.kind === 'clear') {
                emit('info', c.name, 'cap-pressure-cleared', `${dir} window back under 70% of dailyCap (${fmtAmount(used)}/${fmtAmount(cap)}) token=${token}`);
              } else if (t) {
                emit(u.severity, c.name, 'cap-pressure', `${dir} window ${u.pct}% of dailyCap (${fmtAmount(used)}/${fmtAmount(cap)}) token=${token}${t.kind === 'change' ? ` (was ${t.from})` : ''}`);
              }
            }
          } catch (e) {
            emit('warn', c.name, 'usage-check-failed', String(e.message).slice(0, 160));
          }
        }
        try {
          const contract = new ethers.Contract(c.bridgeAddress, ABI, await c.ep.call(async (p) => p));
          const t = edges.transition(`paused:${c.name}`, (await contract.paused()) ? 'warn' : null);
          if (t?.kind === 'raise') emit('warn', c.name, 'state', 'bridge is PAUSED');
          else if (t?.kind === 'clear') emit('info', c.name, 'state', 'bridge UNPAUSED');
        } catch { /* covered by the rpc-down line above */ }
      }
    }

    saveState(statePath, {
      cursors: Object.fromEntries(cursors),
      reconciler: rec.toJSON(),
      knownLimits: Object.fromEntries(knownLimits),
      savedAt: new Date().toISOString(),
    });
  }

  if (args.once) {
    await tick();
    emit('info', 'watcher', 'done', 'single pass complete');
    return;
  }

  for (;;) {
    try {
      await tick();
    } catch (e) {
      emit('warn', 'watcher', 'tick-failed', String(e?.message ?? e).slice(0, 240));
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs ?? 20_000));
  }
}

function handleEvent(chain, parsed, log, rec, knownLimits, cursors) {
  const name = parsed.name;
  const a = parsed.args;
  const at = `blk=${log.blockNumber} tx=${log.transactionHash}`;

  switch (name) {
    case 'Sent': {
      rec.recordSent({
        transferId: a.transferId,
        chainId: chain.chainId,
        block: log.blockNumber,
        amount: a.amount,
        recipient: a.recipient,
        sender: a.sender,
      });
      emit('info', chain.name, 'Sent',
        `${fmtAmount(a.amount)} -> chain ${a.dstChainId} recipient=${a.recipient} fee=${fmtAmount(a.fee)} id=${a.transferId.slice(0, 18)}… ${at}`);
      return;
    }
    case 'Executed': {
      const srcHead = cursors.get(Number(a.srcChainId)) ?? 0;
      const finding = rec.recordExecuted({
        transferId: a.transferId,
        chainId: chain.chainId,
        srcChainId: Number(a.srcChainId),
        block: log.blockNumber,
        amount: a.amount,
        recipient: a.recipient,
        srcHead,
      });
      if (finding?.kind === 'amount-mismatch') {
        emit('critical', chain.name, 'AMOUNT-MISMATCH',
          `transferId=${a.transferId} Sent ${fmtAmount(finding.sentAmount)} but Executed ${fmtAmount(finding.executedAmount)} — pause() now. ${at}`);
        return;
      }
      const tag = finding?.kind === 'matched' ? 'matched' : 'awaiting source confirmation';
      emit('info', chain.name, 'Executed',
        `${fmtAmount(a.amount)} from chain ${a.srcChainId} recipient=${a.recipient} sigs=${a.signatureCount} [${tag}] id=${a.transferId.slice(0, 18)}… ${at}`);
      return;
    }
    case 'TokenLimitsChanged': {
      const key = `${chain.chainId}:${a.localToken.toLowerCase()}`;
      const prev = knownLimits.get(key);
      const sev = limitChangeSeverity({
        oldMax: prev ? BigInt(prev.max) : null,
        oldDaily: prev ? BigInt(prev.daily) : null,
        newMax: a.maxPerTransfer,
        newDaily: a.dailyCap,
      });
      knownLimits.set(key, { max: a.maxPerTransfer.toString(), daily: a.dailyCap.toString() });
      emit(sev, chain.name, 'TokenLimitsChanged',
        `token=${a.localToken} maxPerTransfer=${fmtAmount(a.maxPerTransfer)} dailyCap=${fmtAmount(a.dailyCap)} immediate=${a.immediate} ${at}`);
      return;
    }
    case 'TokenRegistered': {
      const key = `${chain.chainId}:${a.localToken.toLowerCase()}`;
      knownLimits.set(key, { max: a.maxPerTransfer.toString(), daily: a.dailyCap.toString() });
      emit('alert', chain.name, 'TokenRegistered',
        `token=${a.localToken} kind=${a.kind} remoteChain=${a.remoteChainId} remoteToken=${a.remoteToken} ` +
        `max=${fmtAmount(a.maxPerTransfer)} daily=${fmtAmount(a.dailyCap)} ${at}`);
      return;
    }
    case 'ActionQueued': {
      emit('alert', chain.name, 'ActionQueued',
        `id=${a.actionId} selector=${a.selector} eta=${new Date(Number(a.eta) * 1000).toISOString()} ` +
        `data=${a.data.slice(0, 74)}… — if you did not queue this, cancelAction(${a.actionId}) NOW. ${at}`);
      return;
    }
    default: {
      const sev = EVENT_SEVERITY[name] ?? 'info';
      const detail = parsed.fragment.inputs
        .map((inp) => `${inp.name}=${formatArg(a[inp.name])}`)
        .join(' ');
      emit(sev, chain.name, name, `${detail} ${at}`);
    }
  }
}

function formatArg(v) {
  if (typeof v === 'bigint') return v > 10n ** 12n ? fmtAmount(v) : v.toString();
  if (typeof v === 'string' && v.length > 66) return v.slice(0, 42) + '…';
  return String(v);
}

main().catch((e) => {
  emit('critical', 'watcher', 'fatal', String(e?.stack ?? e).slice(0, 500));
  process.exit(1);
});
