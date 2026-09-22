#!/usr/bin/env node
/**
 * Drive one transfer across the Ferminux bridge, end to end, with verification at
 * every step.
 *
 * This is the manual stand-in for the relayer, for controlled operator transfers —
 * the smoke test, and any hand-driven crossing before the three-custodian relayer
 * is running. It is NOT the production path and does not pretend to be: it holds
 * every validator key in one process, which is precisely the concentration the
 * real relayer exists to avoid. Use it to prove the route works, then take the
 * keys apart.
 *
 * The digest is not reconstructed locally. `hashTransfer()` is a public view on
 * the DESTINATION bridge, so this asks the contract that will verify the signature
 * exactly what to sign. Rebuilding EIP-712 by hand is how you produce signatures
 * that are perfectly valid against a domain nobody uses.
 *
 *   node crossing.mjs --from ferminux --to bsc --amount 10 --recipient 0x…
 *   node crossing.mjs --resume <sendTxHash> --from ferminux --to bsc
 *   node crossing.mjs --from ferminux --to bsc --amount 10 --recipient 0x… --dry-run
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ethers } from '../relayer/node_modules/ethers/lib.esm/index.js';

const CRED = join(homedir(), 'ferminux-network', '.credentials');

const CHAINS = {
  ferminux: {
    chainId: 3961n,
    name: 'ferminux',
    rpcs: ['https://rpc.ferminux.net'],
    bridge: '0xe162eeDa683f067d4Ebf61060Fa322332a779EF4',
    confirmations: 8,
    symbol: 'FMX',
    decimals: 18,
    gas: { gasPrice: 2_000_000_000n },
  },
  bsc: {
    chainId: 56n,
    name: 'bsc',
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://1rpc.io/bnb'],
    bridge: '0xe43951a0E421A6B3Cb9C6ae66273dc0D3c8a70ff',
    confirmations: 6,
    symbol: 'BNB',
    decimals: 18,
    gas: {},
  },
};

const BRIDGE_ABI = [
  'function send(address localToken, uint256 amount, uint64 dstChainId, address recipient) payable returns (bytes32)',
  'function execute((uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount) t, (uint8 v,bytes32 r,bytes32 s)[] sigs)',
  'function hashTransfer((uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount) t) view returns (bytes32)',
  'function transferIdOf((uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount) t) pure returns (bytes32)',
  'function processed(bytes32) view returns (bool)',
  'function paused() view returns (bool)',
  'function threshold() view returns (uint256)',
  'function getValidators() view returns (address[])',
  // NOTE the field order: `paused` is SECOND, not last. Getting it wrong decodes
  // every field shifted by one — remoteChainId reads as `paused`, so the route
  // check silently fails and a registered route looks unregistered. Verified
  // against struct TokenConfig in FerminuxBridge.sol.
  'function tokenConfig(address) view returns (uint8 kind, bool paused, uint64 remoteChainId, address remoteToken, uint256 maxPerTransfer, uint256 dailyCap)',
  'function localTokenFor(uint64 remoteChainId, address remoteToken) view returns (address)',
  'event Sent(bytes32 indexed transferId, uint64 indexed dstChainId, address indexed localToken, uint64 srcChainId, uint64 nonce, address remoteToken, address sender, address recipient, uint256 amount, uint256 fee)',
  'event Executed(bytes32 indexed transferId, uint64 indexed srcChainId, address indexed localToken, address remoteToken, address recipient, uint256 amount, uint256 signatureCount)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
];

function log(...a) { console.log(...a); }
function step(n, s) { console.log(`\n[${n}] ${s}`); }
function die(m) { console.error(`\nFAILED: ${m}`); process.exit(1); }

/** Decrypt a V3 keystore via cast, which already knows the scrypt parameters. */
function keyFrom(dir) {
  const d = join(CRED, dir);
  if (!existsSync(d)) die(`no keystore directory at ${d}`);
  // Pick the keystore by what it CONTAINS — JSON carrying a "crypto" object — not
  // by excluding the filenames we happen to expect. The exclusion version picked a
  // .DS_Store that Finder had dropped in the directory and tried to decrypt it.
  const file = readdirSync(d).find((f) => {
    try {
      const j = JSON.parse(readFileSync(join(d, f), 'utf8'));
      return j && typeof j === 'object' && ('crypto' in j || 'Crypto' in j);
    } catch { return false; }
  });
  if (!file) die(`no keystore file in ${d}`);
  const pw = readFileSync(join(d, 'password.txt'), 'utf8').trim();
  const out = execFileSync('cast', ['wallet', 'decrypt-keystore', '--keystore-dir', d, file, '--unsafe-password', pw], { encoding: 'utf8' });
  const m = out.match(/0x[0-9a-fA-F]{64}/);
  if (!m) die(`could not decrypt ${d}`);
  return m[0];
}

async function providerFor(c) {
  let last;
  for (const url of c.rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url, Number(c.chainId), { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (e) { last = e; }
  }
  die(`no working RPC for ${c.name}: ${last?.message}`);
}

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--amount') o.amount = argv[++i];
    else if (a === '--recipient') o.recipient = argv[++i];
    else if (a === '--resume') o.resume = argv[++i];
    else if (a === '--sender-key') o.senderKeyDir = argv[++i];
    else die(`unknown argument ${a}`);
  }
  if (!o.from || !o.to) die('--from and --to are required');
  if (!CHAINS[o.from] || !CHAINS[o.to]) die(`chains must be one of: ${Object.keys(CHAINS).join(', ')}`);
  if (o.from === o.to) die('--from and --to must differ');
  if (!o.resume && (!o.amount || !o.recipient)) die('--amount and --recipient are required unless --resume');
  return o;
}

async function main() {
  const a = parseArgs(process.argv);
  const src = CHAINS[a.from];
  const dst = CHAINS[a.to];

  const sp = await providerFor(src);
  const dp = await providerFor(dst);
  const sBridge = new ethers.Contract(src.bridge, BRIDGE_ABI, sp);
  const dBridge = new ethers.Contract(dst.bridge, BRIDGE_ABI, dp);

  step(1, `Preflight: ${src.name} -> ${dst.name}`);
  if (await sBridge.paused()) die(`${src.name} bridge is PAUSED`);
  if (await dBridge.paused()) die(`${dst.name} bridge is PAUSED`);

  // Resolve which token on THIS chain carries the route, rather than assuming.
  // Both directions of the FMX route are covered:
  //   ferminux -> bsc : the local token is the native coin, address(0)
  //   bsc -> ferminux : the local token is the wFMX wrapper, which is whatever
  //                     this bridge registered as the mirror of the destination's
  //                     native coin. Ask the registry instead of hard-coding it.
  const NATIVE = ethers.ZeroAddress;
  let localToken = null;
  const nativeCfg = await sBridge.tokenConfig(NATIVE).catch(() => null);
  if (nativeCfg && nativeCfg.kind !== 0n && nativeCfg.remoteChainId === dst.chainId) {
    localToken = NATIVE;
  } else {
    const mirror = await sBridge.localTokenFor(dst.chainId, NATIVE).catch(() => ethers.ZeroAddress);
    if (mirror === ethers.ZeroAddress) {
      die(`${src.name} has no route to chain ${dst.chainId} for the destination's native coin — is the route registered yet?`);
    }
    localToken = mirror;
  }
  const cfg = await sBridge.tokenConfig(localToken);
  if (cfg.kind === 0n) die(`token ${localToken} is not registered on ${src.name}`);
  const isNativeSide = localToken === NATIVE;
  const kindName = cfg.kind === 1n ? 'CANONICAL' : 'WRAPPED';
  log(`   route: localToken=${isNativeSide ? 'native' : localToken} kind=${kindName} remoteChain=${cfg.remoteChainId} remoteToken=${cfg.remoteToken}`);
  log(`   caps : maxPerTransfer=${ethers.formatUnits(cfg.maxPerTransfer, 18)}  dailyCap=${ethers.formatUnits(cfg.dailyCap, 18)}`);
  if (cfg.remoteChainId !== dst.chainId) die(`route on ${src.name} points at chain ${cfg.remoteChainId}, not ${dst.chainId}`);
  if (cfg.paused) die('this token is paused on the source bridge');

  const threshold = await dBridge.threshold();
  const validators = (await dBridge.getValidators()).map((v) => v.toLowerCase());
  log(`   dest quorum: ${threshold} of ${validators.length}`);

  let sentLog;

  if (a.resume) {
    step(2, `Resuming from source tx ${a.resume}`);
    const rc = await sp.getTransactionReceipt(a.resume);
    if (!rc) die('source transaction not found');
    sentLog = rc.logs.map((l) => { try { return sBridge.interface.parseLog(l); } catch { return null; } }).find((p) => p?.name === 'Sent');
    if (!sentLog) die('that transaction contains no Sent event');
  } else {
    const amount = ethers.parseUnits(a.amount, 18);
    if (amount > cfg.maxPerTransfer) die(`amount ${a.amount} exceeds maxPerTransfer ${ethers.formatUnits(cfg.maxPerTransfer, 18)}`);
    if (!ethers.isAddress(a.recipient)) die(`--recipient is not an address: ${a.recipient}`);

    const senderKey = keyFrom(a.senderKeyDir ?? 'premine/aznt-ops');
    const wallet = new ethers.Wallet(senderKey, sp);

    // On the native side the amount rides in msg.value. On the wrapper side the
    // bridge burns from the holder's balance and the wrapper's burn() debits the
    // holder's allowance, exactly as transferFrom would — so the wrapper side
    // needs an approve first and msg.value must be ZERO. (Sending value on the
    // wrapper side reverts "BRIDGE: unexpected value".)
    const value = isNativeSide ? amount : 0n;
    const bal = isNativeSide
      ? await sp.getBalance(wallet.address)
      : await new ethers.Contract(localToken, ERC20_ABI, sp).balanceOf(wallet.address);
    const unit = isNativeSide ? src.symbol : 'wrapped';
    log(`   sender ${wallet.address} holds ${ethers.formatUnits(bal, 18)} ${unit}`);
    if (bal < amount) die(`sender holds ${ethers.formatUnits(bal, 18)} but is trying to send ${a.amount}`);
    if (!isNativeSide) {
      const gasBal = await sp.getBalance(wallet.address);
      if (gasBal === 0n) die(`sender has no ${src.symbol} for gas on ${src.name}`);

      // The wrapper burns against an allowance. Grant exactly this transfer's
      // worth — a crossing tool has no business leaving a standing approval
      // behind, and send() consumes the whole amount, so nothing is left over.
      const token = new ethers.Contract(localToken, ERC20_ABI, sp);
      const allowed = await token.allowance(wallet.address, src.bridge);
      if (allowed < amount) {
        if (a.dryRun) {
          die(
            `sender has approved ${ethers.formatUnits(allowed, 18)} to the bridge but is sending ${a.amount}.\n` +
              `        A real run would approve first; a dry run will not broadcast one, so it stops here.`,
          );
        }
        step('1b', `Approving ${a.amount} to the bridge (the wrapper burns against an allowance)`);
        const atx = await token.connect(wallet).approve(src.bridge, amount, { ...src.gas });
        log(`   tx ${atx.hash}`);
        await atx.wait();
      }
    }

    step(2, `${isNativeSide ? 'Locking' : 'Burning'} ${a.amount} on ${src.name}`);
    if (a.dryRun) {
      // A static call runs every require() without spending anything, so the
      // route is proven callable before a single coin moves.
      await sBridge.connect(wallet).send.staticCall(localToken, amount, dst.chainId, a.recipient, { value });
      log('   dry run: send() would succeed. Nothing was broadcast.');
      return;
    }
    const tx = await sBridge.connect(wallet).send(localToken, amount, dst.chainId, a.recipient, { value, ...src.gas });
    log(`   tx ${tx.hash}`);
    const rc = await tx.wait();
    log(`   mined in block ${rc.blockNumber}`);
    sentLog = rc.logs.map((l) => { try { return sBridge.interface.parseLog(l); } catch { return null; } }).find((p) => p?.name === 'Sent');
    if (!sentLog) die('send() produced no Sent event');
  }

  const e = sentLog.args;
  const t = {
    srcChainId: e.srcChainId,
    dstChainId: e.dstChainId,
    nonce: e.nonce,
    srcToken: e.localToken,
    dstToken: e.remoteToken,
    sender: e.sender,
    recipient: e.recipient,
    amount: e.amount, // already NET of the fee
  };
  log(`   transferId ${e.transferId}`);
  log(`   net ${ethers.formatUnits(e.amount, 18)} after fee ${ethers.formatUnits(e.fee, 18)}`);

  step(3, 'Confirming the source transfer is buried');
  const target = (await sp.getBlockNumber()) + src.confirmations;
  for (;;) {
    const h = await sp.getBlockNumber();
    if (h >= target) break;
    process.stdout.write(`\r   ${h}/${target}   `);
    await new Promise((r) => setTimeout(r, 4000));
  }
  log(`\r   source at ${await sp.getBlockNumber()}, ${src.confirmations} confirmations past the lock`);

  step(4, 'Asking the DESTINATION contract what to sign');
  // Reconstructing the digest locally is how you get a signature that is valid
  // against a domain nobody verifies against. Ask the verifier instead.
  const idOnDest = await dBridge.transferIdOf(t);
  if (idOnDest !== e.transferId) die(`transferId disagrees: source says ${e.transferId}, destination computes ${idOnDest}`);
  if (await dBridge.processed(idOnDest)) die('this transfer has already been executed on the destination');
  const digest = await dBridge.hashTransfer(t);
  log(`   digest ${digest}`);

  step(5, `Collecting ${threshold} validator signatures`);
  const sigs = [];
  const signed = new Set();
  for (let i = 1; i <= 3 && sigs.length < Number(threshold); i++) {
    const pk = keyFrom(`bridge/validator${i}`);
    const w = new ethers.Wallet(pk);
    if (!validators.includes(w.address.toLowerCase())) { log(`   validator${i} ${w.address} is NOT in the destination set — skipping`); continue; }
    if (signed.has(w.address)) continue; // a repeated signer is fatal on-chain
    const sig = w.signingKey.sign(digest);
    sigs.push({ v: sig.v, r: sig.r, s: sig.s });
    signed.add(w.address);
    log(`   validator${i} ${w.address} signed`);
  }
  if (sigs.length < Number(threshold)) die(`only ${sigs.length} of ${threshold} required signatures available`);

  // Verify locally before spending gas: recover each signature against the digest
  // and confirm it lands on a distinct current validator.
  const recovered = sigs.map((s) => ethers.recoverAddress(digest, s).toLowerCase());
  if (new Set(recovered).size !== recovered.length) die('duplicate signer — execute() would revert');
  for (const r of recovered) if (!validators.includes(r)) die(`recovered ${r} is not a destination validator`);
  log(`   locally verified: ${recovered.length} distinct validators over the destination's own digest`);

  step(6, `Executing on ${dst.name}`);
  const relayerKey = keyFrom(a.from === 'ferminux' ? 'bridge/bsc-deployer' : 'premine/aznt-ops');
  const relayer = new ethers.Wallet(relayerKey, dp);
  log(`   relayed by ${relayer.address} (execute() is permissionless)`);

  const isWrapped = t.dstToken !== ethers.ZeroAddress;
  const token = isWrapped ? new ethers.Contract(t.dstToken, ERC20_ABI, dp) : null;
  const before = isWrapped ? await token.balanceOf(t.recipient) : await dp.getBalance(t.recipient);

  if (a.dryRun) {
    await dBridge.connect(relayer).execute.staticCall(t, sigs);
    log('   dry run: execute() would succeed. Nothing was broadcast.');
    return;
  }
  await dBridge.connect(relayer).execute.staticCall(t, sigs); // fail loudly before paying gas
  const tx2 = await dBridge.connect(relayer).execute(t, sigs, dst.gas);
  log(`   tx ${tx2.hash}`);
  const rc2 = await tx2.wait();
  log(`   mined in block ${rc2.blockNumber}`);

  step(7, 'Verifying the recipient actually received it');
  const after = isWrapped ? await token.balanceOf(t.recipient) : await dp.getBalance(t.recipient);
  let delta = after - before;

  // execute() is permissionless, so the relayer is often the recipient too — and
  // when the delivered asset is the destination's NATIVE coin, that same balance
  // just paid the gas. Comparing the raw delta against the transfer amount then
  // reports a perfectly correct delivery as a shortfall, exactly the false alarm
  // that makes a check worth ignoring. Add the gas back before comparing.
  const selfRelayed = !isWrapped && t.recipient.toLowerCase() === relayer.address.toLowerCase();
  if (selfRelayed) {
    const gasCost = rc2.gasUsed * rc2.gasPrice;
    log(`   recipient also relayed this tx, so it paid ${ethers.formatUnits(gasCost, 18)} in gas — adding it back`);
    delta += gasCost;
  }

  log(`   recipient balance ${ethers.formatUnits(before, 18)} -> ${ethers.formatUnits(after, 18)}  (credited ${ethers.formatUnits(delta, 18)})`);
  if (delta !== t.amount) {
    die(`credited ${ethers.formatUnits(delta, 18)} does not equal the expected ${ethers.formatUnits(t.amount, 18)}`);
  }

  log(`\nCROSSING COMPLETE — ${ethers.formatUnits(t.amount, 18)} delivered to ${t.recipient} on ${dst.name}`);
  log(`  source : ${src.name} transferId ${e.transferId}`);
  log(`  dest tx: ${tx2.hash}`);
}

main().catch((e) => die(e?.stack ?? String(e)));
