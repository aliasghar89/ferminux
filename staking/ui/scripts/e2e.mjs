#!/usr/bin/env node
// End-to-end data-layer test for the Ferminux staking UI.
//
// Starts a local anvil on port 8612 with --chain-id 3961, builds the REAL
// contracts in ../../contracts (FMXStaking, NodeRegistry — the same source the
// app's ABI fragments are checked against), deploys and wires them, then
// drives the SAME modules the UI imports (src/lib/*, src/config.ts — no
// browser globals):
//
//   1. forge build; the checked-in contracts/abi/*.json equal the fresh artifacts
//   2. deploy FMXStaking + NodeRegistry, initNodeRegistry, fund the reward pool
//   3. read the empty-network overview + all 4 tiers through the UI lib; every
//      tier number comes from the contract and lines up with lib/tiers.ts
//   4. premine deny list refuses a stake; the error maps to plain words
//   5. stake flexible; position, totals, weighted units, position count
//   6. stake a 25k validator-track bond (block-height lock); a year of accrual
//      matches the UI's 2.0× / 20% projection and the vault's own rate view
//   7. claim through the lib; the settled-pool mirror equals the vault's pool
//      to the wei
//   8. cooldown: requestUnstake, early withdraw refused, frozen rewards,
//      withdraw returns principal ONLY, banked rewards still claimable after
//   9. lock enforcement + emergency exit: 5% penalty + forfeited rewards land
//      in the pool exactly
//  10. register a node through the lib: enode → 64-byte pubkey + node address,
//      digest (lib == contract), node-key possession signature; wrong key and
//      non-validator positions refused; roster reads back
//  11. watchtower epoch → dispute window → finalize: roster uptime/last seen,
//      boost on, and the boosted bond accrues at 3.0× / 30%
//  12. deregister through the lib: roster empties, boost dropped
//  13. drip-cap scaling: the UI's effective APY equals the vault's
//  14. fail-closed pool: the settled pool reaches zero with no transaction,
//      accrual stops, principal intact
//  15. deposits paused: the overview says so, stake refused in plain words,
//      claims still work
//  16. kill anvil and verify port 8612 is free again
//
// Usage: npm run e2e   (needs forge + anvil on PATH)

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Wallet, ContractFactory, SigningKey, Signature, Interface, computeAddress, parseEther, formatEther } from 'ethers';

import { CHAIN_ID } from '../src/config.ts';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';
import {
  fetchVaultOverview,
  fetchTiers,
  fetchPositions,
  fetchDenied,
  settledRewardPool,
  isLocked,
  isVisiblePosition,
  stake,
  claim,
  requestUnstake,
  withdraw,
  emergencyExit,
  humanizeTxError,
  GAS_LIMITS,
} from '../src/lib/staking.ts';
import {
  fetchRoster,
  fetchRegistryParams,
  fetchBondedPositions,
  registerNode,
  deregisterNode,
  registrationDigest,
  checkPossessionSignature,
  enodePubkeyBytes,
  enodeToNodeAddress,
  REGISTER_GAS_LIMIT,
  DEREGISTER_GAS_LIMIT,
} from '../src/lib/nodes.ts';
import { TIER_IDS, TIER_SPECS } from '../src/lib/tiers.ts';
import {
  weightedUnits,
  perUnitAprBps,
  effectiveAprBps,
  projectedRewardsWei,
  runwaySeconds,
  maxStakeableWei,
  SECONDS_PER_YEAR,
} from '../src/lib/math.ts';
import { walletFromPrivateKey, sessionSigner } from '../src/lib/keys.ts';

const PORT = 8612;
const RPC = `http://127.0.0.1:${PORT}`;
// Well-known anvil dev keys (public test keys).
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];
const CONTRACTS = fileURLToPath(new URL('../../contracts', import.meta.url));
const YEAR = SECONDS_PER_YEAR;
const DAY = 86_400;
const FMX = 10n ** 18n;
// Direct (non-lib) writes pin a gas limit for the same reason the lib does:
// the accrual-timestamp write makes a bare estimate undershoot when the block
// timestamp moves between estimation and execution.
const GL = { gasLimit: 500_000n };

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)}. ${msg}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      sock.destroy();
      resolve(free);
    };
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
    setTimeout(() => done(true), 1500);
  });
}

async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    if (await probeRpc(RPC, CHAIN_ID, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil did not become ready on port ${PORT}`);
}

function artifact(name) {
  return JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, 'utf8'));
}

function near(actual, expected, partsPer10k, what) {
  const drift = actual > expected ? actual - expected : expected - actual;
  assert.ok(drift * 10_000n <= expected * partsPer10k, `${what}: ${formatEther(actual)} vs ${formatEther(expected)}`);
}

async function main() {
  assert.equal(CHAIN_ID, 3961, 'config CHAIN_ID must be 3961');

  // --- 1. the real contracts, and the ABI copies the app is checked against ---
  execFileSync('forge', ['build'], { cwd: CONTRACTS, stdio: 'pipe' });
  for (const name of ['FMXStaking', 'NodeRegistry']) {
    const committed = JSON.parse(readFileSync(`${CONTRACTS}/abi/${name}.json`, 'utf8'));
    assert.deepEqual(
      committed,
      artifact(name).abi,
      `contracts/abi/${name}.json is stale — regenerate: forge inspect ${name} abi --json > abi/${name}.json`,
    );
  }
  ok('staking/contracts built (solc 0.8.24, evm=paris); abi/*.json match the fresh artifacts');

  assert.equal(await portFree(PORT), true, `port ${PORT} must be free before the test`);
  // --balance 100M FMX per dev account: the pool funding (150k) and the 25k
  // validator bond exceed anvil's 10k default.
  const anvil = spawn(
    'anvil',
    ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--balance', '100000000', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let anvilErr = '';
  anvil.stderr.on('data', (d) => (anvilErr += d));
  const anvilExit = new Promise((resolve) => anvil.once('exit', resolve));

  try {
    await waitForAnvil();
    ok(`anvil up on :${PORT} (chain-id ${CHAIN_ID})`);

    const { provider, url } = await connectRpc(['http://127.0.0.1:9', RPC], CHAIN_ID, 1500);
    assert.equal(url, RPC);
    provider.pollingInterval = 120;
    const head = async () => provider.getBlock('latest');
    const now = async () => (await head()).timestamp;
    const advance = async (seconds) => {
      await provider.send('evm_increaseTime', [seconds]);
      await provider.send('evm_mine', []);
    };
    // Give the NEXT transaction's block an exact timestamp, so a pure mirror of the
    // contract's arithmetic can be compared to the wei.
    const pinNextTimestamp = async (ts) => provider.send('evm_setNextBlockTimestamp', [ts]);
    const gasOf = async (txPromise) => (await (await txPromise).wait()).gasUsed;

    // Wallets: deployer (vault owner + watchtower), alice (staker), bob (validator op), carol (denied)
    const [deployer, alice, bob, carol] = KEYS.map((k) => new Wallet(k, provider));
    // The UI's session-key module produces the signer the app actually uses.
    const aliceKey = walletFromPrivateKey(KEYS[1]);
    assert.equal(aliceKey.address, alice.address);
    const aliceSigner = sessionSigner(aliceKey, provider);
    ok('session-key module derives the same signer the app will use');

    // --- 2. deploy + wire + fund ---
    const stakingArt = artifact('FMXStaking');
    const vault = await new ContractFactory(stakingArt.abi, stakingArt.bytecode.object, deployer).deploy(
      deployer.address,
      [carol.address],
    );
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();
    const regArt = artifact('NodeRegistry');
    const registry = await new ContractFactory(regArt.abi, regArt.bytecode.object, deployer).deploy(
      vaultAddr,
      deployer.address,
      deployer.address,
    );
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();
    await (await vault.initNodeRegistry(registryAddr, GL)).wait();

    const POOL = 150_000n * FMX; // scaled-down pool for the test
    await (await vault.fundRewards({ value: POOL, ...GL })).wait();
    const vaultState = async () => ({
      rewardPool: await vault.rewardPool(),
      totalUnits: await vault.totalUnits(),
      dripPerYear: await vault.dripPerYear(),
      lastAccrual: await vault.lastAccrual(),
    });
    ok(`deployed FMXStaking ${vaultAddr.slice(0, 10)}… + NodeRegistry ${registryAddr.slice(0, 10)}…, wired; pool funded with ${formatEther(POOL)} FMX`);

    // --- 3. empty-network reads through the UI lib ---
    const DRIP = await vault.MAX_DRIP_PER_YEAR();
    assert.equal(DRIP, 1_200_000n * FMX);
    let overview = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(overview.totalStakedWei, 0n);
    assert.equal(overview.totalUnits, 0n);
    assert.equal(overview.totalWeightedUnitsWei, 0n);
    assert.equal(overview.positionCount, 0);
    assert.equal(overview.rewardPoolWei, POOL);
    assert.equal(overview.dripPerYearWei, DRIP);
    assert.equal(overview.cooldownSeconds, 7 * DAY);
    assert.equal(overview.emergencyPenaltyBps, 500n);
    assert.equal(overview.paused, false);
    assert.equal(runwaySeconds(overview.rewardPoolWei, overview.totalWeightedUnitsWei, DRIP), null);
    assert.equal(await vault.poolRunwaySeconds(), 2n ** 256n - 1n, 'the vault agrees: no outlay, no depletion');
    ok('overview: zero staked, full pool, indefinite runway, deposits open — real reads, no estimates');

    const tiers = await fetchTiers(provider, vaultAddr);
    assert.deepEqual(
      tiers.map((t) => [t.id, t.name, t.weightBps, t.boostedWeightBps, t.aprCapBps, t.boostedAprCapBps]),
      [
        [0, 'Flexible', 10_000n, null, 1_000n, null],
        [1, 'Locked 90 days', 15_000n, null, 1_500n, null],
        [2, 'Locked 180 days', 20_000n, null, 2_000n, null],
        [3, 'Validator track', 20_000n, 30_000n, 2_000n, 3_000n],
      ],
    );
    assert.deepEqual(
      tiers.map((t) => [t.lockSeconds, t.lockUntilBlock, t.minStakeWei]),
      [
        [0n, null, 0n],
        [await vault.LOCK_90(), null, 0n],
        [await vault.LOCK_180(), null, 0n],
        [0n, Number(await vault.VALIDATOR_LOCK_BLOCK()), await vault.MIN_VALIDATOR_STAKE()],
      ],
    );
    assert.equal(tiers[1].lockSeconds, BigInt(90 * DAY));
    assert.equal(tiers[3].lockUntilBlock, 4_680_000);
    assert.equal(tiers[3].minStakeWei, parseEther('25000'));
    assert.deepEqual(tiers.map((t) => t.id), TIER_SPECS.map((t) => t.id));
    ok('tiers: 1.0×/10%, 1.5×/15%, 2.0×/20%, validator 2.0×→3.0× boosted (min 25k, lock to block 4,680,000) — all read from the vault');

    // --- 4. deny list ---
    assert.equal(await fetchDenied(provider, vaultAddr, carol.address), true);
    assert.equal(await fetchDenied(provider, vaultAddr, alice.address), false);
    await assert.rejects(stake(carol, vaultAddr, TIER_IDS.Flexible, parseEther('1')), /staker denied/i);
    assert.match(humanizeTxError(new Error('execution reverted: "STK: staker denied"')), /premine deny list/i);
    ok('premine deny list: excluded address cannot stake; error maps to plain words');

    // --- 5. alice stakes 1,000 FMX flexible through the UI lib ---
    const aliceStake = parseEther('1000');
    const stakeGas = await gasOf(stake(aliceSigner, vaultAddr, TIER_IDS.Flexible, aliceStake));
    assert.ok(stakeGas < GAS_LIMITS.stake, `stake gas ${stakeGas} under the pinned ${GAS_LIMITS.stake}`);
    overview = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(overview.totalStakedWei, aliceStake);
    assert.equal(overview.totalUnits, aliceStake * 10n, 'vault units are amount × weight tenths');
    assert.equal(overview.totalWeightedUnitsWei, weightedUnits(aliceStake, 10_000n));
    assert.equal(overview.positionCount, 1);
    let alicePositions = await fetchPositions(provider, vaultAddr, alice.address);
    assert.equal(alicePositions.length, 1);
    assert.equal(alicePositions[0].amountWei, aliceStake);
    assert.equal(alicePositions[0].state, 'active');
    assert.equal(alicePositions[0].tier, TIER_IDS.Flexible);
    assert.equal(alicePositions[0].unlockTime, 0, 'flexible: no time lock');
    assert.equal(alicePositions[0].unlockBlock, 0, 'flexible: no block lock');
    assert.equal(isLocked(alicePositions[0], await now(), await provider.getBlockNumber()), false);
    ok(`stake(flexible 1,000 FMX): position, principal, units and position count correct (${stakeGas} gas)`);

    // --- 6. bob stakes a validator bond; a year of accrual matches UI projections ---
    await assert.rejects(stake(bob, vaultAddr, TIER_IDS.Validator, parseEther('24999')), /below validator minimum/i);
    const bond = parseEther('25000');
    await (await stake(bob, vaultAddr, TIER_IDS.Validator, bond)).wait();
    let bobPos = (await fetchPositions(provider, vaultAddr, bob.address))[0];
    assert.equal(bobPos.tier, TIER_IDS.Validator);
    assert.equal(bobPos.unlockBlock, 4_680_000);
    assert.equal(bobPos.unlockTime, 0);
    assert.equal(isLocked(bobPos, await now(), await provider.getBlockNumber()), true, 'locked until the lock block');
    await assert.rejects(requestUnstake(bob, vaultAddr, bobPos.id), /lock not expired/i);
    overview = await fetchVaultOverview(provider, vaultAddr);
    const unitsNow = weightedUnits(aliceStake, 10_000n) + weightedUnits(bond, tiers[3].weightBps);
    assert.equal(overview.totalWeightedUnitsWei, unitsNow);
    assert.equal(overview.positionCount, 2);

    const pendingStart = bobPos.pendingRewardsWei;
    await advance(Number(YEAR));
    bobPos = (await fetchPositions(provider, vaultAddr, bob.address))[0];
    // Below the drip knee the validator track pays its full base 20% cap.
    const bobApr = effectiveAprBps(tiers[3].weightBps, unitsNow, DRIP);
    assert.equal(bobApr, 2_000n);
    assert.equal((tiers[3].aprCapBps * (await vault.effectiveRateBps())) / 10_000n, bobApr, 'the vault rate view agrees');
    const expectedYear = projectedRewardsWei(bond, bobApr, YEAR); // 5,000 FMX
    assert.equal(expectedYear, 5_000n * FMX);
    // anvil block timestamps add a few seconds of skew; tolerate < 0.01%.
    near(bobPos.pendingRewardsWei - pendingStart, expectedYear, 1n, 'validator bond, one year at 2.0×');
    ok(`accrual: 25k validator bond earned ${formatEther(bobPos.pendingRewardsWei).slice(0, 9)} FMX in 1yr — the UI's 20% projection, block-height lock enforced`);

    // --- 7. claim; the UI's settled pool equals the vault's own accounting ---
    const pre = await vaultState();
    const claimAt = (await now()) + 13;
    await pinNextTimestamp(claimAt);
    const bobBefore = await provider.getBalance(bob.address);
    const claimRcpt = await (await claim(bob, vaultAddr, bobPos.id)).wait();
    const claimed = (await provider.getBalance(bob.address)) - bobBefore + claimRcpt.gasUsed * claimRcpt.gasPrice;
    assert.ok(claimed >= bobPos.pendingRewardsWei, 'claim pays at least the last pending read');
    assert.ok(claimRcpt.gasUsed < GAS_LIMITS.claim, `claim gas ${claimRcpt.gasUsed}`);
    const rawPool = await vault.rewardPool();
    assert.equal(rawPool, settledRewardPool(pre, BigInt(claimAt)), 'settled-pool mirror == the vault, to the wei');
    assert.equal((await fetchVaultOverview(provider, vaultAddr)).rewardPoolWei, rawPool);
    const bobRefetched = (await fetchPositions(provider, vaultAddr, bob.address))[0];
    assert.ok(bobRefetched.pendingRewardsWei < FMX / 100n, 'pending resets after claim');
    ok(`claim: ${formatEther(claimed).slice(0, 9)} FMX arrived; the UI's settled pool equals rewardPool() exactly`);

    // --- 8. cooldown lifecycle on the flexible position ---
    const unstakeGas = await gasOf(requestUnstake(aliceSigner, vaultAddr, alicePositions[0].id));
    assert.ok(unstakeGas < GAS_LIMITS.requestUnstake, `requestUnstake gas ${unstakeGas}`);
    alicePositions = await fetchPositions(provider, vaultAddr, alice.address);
    assert.equal(alicePositions[0].state, 'cooling');
    const tNow = await now();
    assert.ok(alicePositions[0].cooldownEnd >= tNow + 7 * DAY - 5, 'cooldown ≈ 7 days out');
    await assert.rejects(withdraw(aliceSigner, vaultAddr, alicePositions[0].id), /cooldown not over/i);
    const frozen = alicePositions[0].pendingRewardsWei;
    assert.ok(frozen > 0n, 'a year of flexible rewards banked at the request');
    await advance(3 * DAY);
    const midCooldown = await fetchPositions(provider, vaultAddr, alice.address);
    assert.equal(midCooldown[0].pendingRewardsWei, frozen, 'no rewards accrue during cooldown');
    await advance(4 * DAY + 10);
    const aliceBefore = await provider.getBalance(alice.address);
    const wRcpt = await (await withdraw(aliceSigner, vaultAddr, alicePositions[0].id)).wait();
    assert.ok(wRcpt.gasUsed < GAS_LIMITS.withdraw, `withdraw gas ${wRcpt.gasUsed}`);
    const aliceGot = (await provider.getBalance(alice.address)) - aliceBefore + wRcpt.gasUsed * wRcpt.gasPrice;
    assert.equal(aliceGot, aliceStake, 'withdraw returns principal only');
    let afterWithdraw = (await fetchPositions(provider, vaultAddr, alice.address))[0];
    assert.equal(afterWithdraw.state, 'withdrawn');
    assert.equal(afterWithdraw.pendingRewardsWei, frozen, 'banked rewards survive withdrawal');
    assert.equal(isVisiblePosition(afterWithdraw), true, 'so the position stays listed with a Claim action');
    const aliceBefore2 = await provider.getBalance(alice.address);
    const cRcpt = await (await claim(aliceSigner, vaultAddr, afterWithdraw.id)).wait();
    assert.equal((await provider.getBalance(alice.address)) - aliceBefore2 + cRcpt.gasUsed * cRcpt.gasPrice, frozen);
    afterWithdraw = (await fetchPositions(provider, vaultAddr, alice.address))[0];
    assert.equal(isVisiblePosition(afterWithdraw), false, 'nothing left: the position drops off the list');
    overview = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(overview.totalStakedWei, bond, 'only the validator bond is still staked');
    ok('cooldown: early withdraw refused; rewards frozen; withdraw returns principal only; banked rewards claimed after');

    // --- 9. lock + emergency exit on a Locked-90 position ---
    const lockAmount = parseEther('2000');
    await (await stake(aliceSigner, vaultAddr, TIER_IDS.Locked90, lockAmount)).wait();
    let locked = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.state === 'active');
    assert.equal(BigInt(locked.unlockTime - locked.startTime), tiers[1].lockSeconds, 'lockEnd = start + LOCK_90');
    assert.equal(isLocked(locked, await now(), await provider.getBlockNumber()), true);
    await assert.rejects(requestUnstake(aliceSigner, vaultAddr, locked.id), /lock not expired/i);
    assert.match(humanizeTxError(new Error('execution reverted: "STK: lock not expired"')), /still locked/i);
    await advance(10 * DAY); // accrue something to forfeit
    locked = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.id === locked.id);
    assert.ok(locked.pendingRewardsWei > 0n);
    const preExit = await vaultState();
    const exitAt = (await now()) + 7;
    await pinNextTimestamp(exitAt);
    const exitRcpt = await (await emergencyExit(aliceSigner, vaultAddr, locked.id)).wait();
    assert.ok(exitRcpt.gasUsed < GAS_LIMITS.emergencyExit, `emergencyExit gas ${exitRcpt.gasUsed}`);
    const exitEvent = exitRcpt.logs
      .map((l) => {
        try {
          return new Interface(stakingArt.abi).parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === 'EmergencyExited');
    const forfeited = exitEvent.args.forfeitedRewards;
    const penalty = (lockAmount * 500n) / 10_000n;
    assert.equal(exitEvent.args.principalPenalty, penalty);
    assert.ok(forfeited >= locked.pendingRewardsWei, 'every unclaimed reward forfeited');
    const exited = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.id === locked.id);
    assert.equal(exited.state, 'cooling');
    assert.equal(exited.amountWei, lockAmount - penalty, '5% principal penalty applied');
    assert.equal(exited.pendingRewardsWei, 0n, 'all unclaimed rewards forfeited');
    assert.equal(
      (await fetchVaultOverview(provider, vaultAddr)).rewardPoolWei,
      settledRewardPool(preExit, BigInt(exitAt)) + forfeited + penalty,
      'penalty + forfeited rewards returned to the pool, exactly',
    );
    ok(`emergency exit: ${formatEther(penalty)} FMX penalty + ${formatEther(forfeited).slice(0, 7)} FMX forfeited, both into the pool; then cooldown`);

    // --- 10. node registration + roster through the UI lib ---
    const params = await fetchRegistryParams(provider, registryAddr);
    assert.equal(params.minBondWei, parseEther('25000'));
    assert.equal(params.boostThresholdBps, 9_500n);
    assert.equal(params.disputeWindowSeconds, 7 * DAY);
    const nodeKey = new SigningKey('0x' + '5a'.repeat(32));
    const ENODE = `enode://${nodeKey.publicKey.slice(4)}@203.0.113.7:30303`;
    const pubkey = enodePubkeyBytes(ENODE);
    const nodeAddress = enodeToNodeAddress(ENODE);
    assert.equal(nodeAddress, computeAddress(nodeKey.publicKey), 'node address is the key address');
    const consensusAddr = Wallet.createRandom().address;
    const bobPosId = bobPos.id;
    const digest = registrationDigest(CHAIN_ID, registryAddr, bob.address, consensusAddr, bobPosId);
    assert.equal(digest, await registry.registrationDigest(bob.address, consensusAddr, bobPosId), 'lib digest == contract');
    const goodSig = checkPossessionSignature(nodeKey.sign(digest).serialized, digest, nodeAddress);
    assert.equal(goodSig.ok, true);

    // A wrong key is caught before any transaction, and the contract agrees.
    const wrongKey = new SigningKey('0x' + '6b'.repeat(32));
    const wrongSigHex = wrongKey.sign(digest).serialized;
    assert.equal(checkPossessionSignature(wrongSigHex, digest, nodeAddress).ok, false);
    const wrong = Signature.from(wrongSigHex);
    await assert.rejects(
      registerNode(bob, registryAddr, { pubkey, consensusAddr, positionId: bobPosId, signature: wrong }),
      /invalid possession signature/i,
    );
    // A non-validator position must be refused.
    await (await stake(aliceSigner, vaultAddr, TIER_IDS.Flexible, parseEther('50'))).wait();
    const alicePosId = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.state === 'active').id;
    const aliceDigest = registrationDigest(CHAIN_ID, registryAddr, alice.address, consensusAddr, alicePosId);
    const aliceSig = checkPossessionSignature(nodeKey.sign(aliceDigest).serialized, aliceDigest, nodeAddress);
    await assert.rejects(
      registerNode(aliceSigner, registryAddr, { pubkey, consensusAddr, positionId: alicePosId, signature: aliceSig }),
      /not a validator-track position/i,
    );
    assert.equal((await fetchBondedPositions(provider, registryAddr, [bobPosId])).size, 0);
    const regGas = await gasOf(
      registerNode(bob, registryAddr, { pubkey, consensusAddr, positionId: bobPosId, signature: goodSig }),
    );
    assert.ok(regGas < REGISTER_GAS_LIMIT, `registerNode gas ${regGas} under the pinned ${REGISTER_GAS_LIMIT}`);
    await assert.rejects(
      registerNode(bob, registryAddr, { pubkey, consensusAddr, positionId: bobPosId, signature: goodSig }),
      /node key already registered/i,
    );
    assert.deepEqual([...(await fetchBondedPositions(provider, registryAddr, [bobPosId, alicePosId]))], [bobPosId.toString()]);
    let roster = await fetchRoster(provider, registryAddr);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].id, 1n);
    assert.equal(roster[0].operator, bob.address);
    assert.equal(roster[0].consensusAddr, consensusAddr);
    assert.equal(roster[0].nodeAddress, nodeAddress);
    assert.equal(roster[0].bondWei, bond);
    assert.equal(roster[0].boosted, false);
    assert.equal(roster[0].lastSeen, 0, 'no attestation yet');
    ok(`nodes: enode + node-key signature registers (${regGas} gas); wrong key and flexible position refused; roster reads back`);

    // --- 11. watchtower epoch → dispute window → finalize → boost ---
    const epoch = BigInt(Math.floor((await now()) / DAY) - 1);
    await (await registry.postEpoch(epoch, '0x' + 'ee'.repeat(32), [1n], [9_800], GL)).wait();
    await advance(params.disputeWindowSeconds + 1);
    await (await registry.finalizeEpoch(epoch, GL)).wait();
    roster = await fetchRoster(provider, registryAddr);
    assert.equal(roster[0].uptimeBps, 9_800n);
    assert.equal(roster[0].lastSeen, Number((epoch + 1n) * BigInt(DAY)), 'last seen = end of the attested epoch');
    assert.equal(roster[0].boosted, true, '≥95% epoch switches the boost on');
    bobPos = (await fetchPositions(provider, vaultAddr, bob.address))[0];
    assert.equal(bobPos.boosted, true);
    overview = await fetchVaultOverview(provider, vaultAddr);
    const boostedApr = effectiveAprBps(tiers[3].boostedWeightBps, overview.totalWeightedUnitsWei, DRIP);
    assert.equal(boostedApr, tiers[3].boostedAprCapBps, 'boosted bond pays the 30% cap below the knee');
    const boostStart = bobPos.pendingRewardsWei;
    await advance(30 * DAY);
    bobPos = (await fetchPositions(provider, vaultAddr, bob.address))[0];
    near(bobPos.pendingRewardsWei - boostStart, projectedRewardsWei(bond, boostedApr, 30n * 86_400n), 1n, 'boosted 30 days');
    ok('watchtower epoch finalized after the dispute window: roster 98% uptime + last seen; bond accrues at 3.0× (30%)');

    // --- 12. deregister through the lib ---
    const deregGas = await gasOf(deregisterNode(bob, registryAddr, roster[0].id));
    assert.ok(deregGas < DEREGISTER_GAS_LIMIT, `deregisterNode gas ${deregGas}`);
    assert.equal((await fetchRoster(provider, registryAddr)).length, 0);
    assert.equal((await fetchPositions(provider, vaultAddr, bob.address))[0].boosted, false, 'boost dropped');
    assert.equal((await fetchBondedPositions(provider, registryAddr, [bobPosId])).size, 0, 'position free again');
    ok(`deregister: roster empty, boost dropped, position free to bond again (${deregGas} gas)`);

    // --- 13. drip-cap scaling: the UI's effective APY equals the vault's ---
    // Push weighted stake past the knee: knee = DRIP / 10% = 12M FMX at 1.0×.
    const whale = deployer;
    await provider.send('anvil_setBalance', [whale.address, '0x' + (13_000_000n * FMX).toString(16)]);
    const whaleStake = 12_000_000n * FMX;
    await (await stake(whale, vaultAddr, TIER_IDS.Flexible, whaleStake)).wait();
    overview = await fetchVaultOverview(provider, vaultAddr);
    const units = overview.totalWeightedUnitsWei;
    assert.ok(units > 12_000_000n * FMX, 'past the drip knee');
    const uiApr = effectiveAprBps(tiers[0].weightBps, units, DRIP);
    assert.ok(uiApr < tiers[0].aprCapBps, `flexible APY scales below cap (${uiApr} bps)`);
    const vaultApr = (tiers[0].aprCapBps * (await vault.effectiveRateBps())) / 10_000n;
    assert.ok(uiApr - vaultApr <= 1n && vaultApr - uiApr <= 1n, `UI ${uiApr} bps vs vault ${vaultApr} bps`);
    // Fund the pool generously so accrual is not pool-limited during this check.
    await provider.send('anvil_setBalance', [alice.address, '0x' + (2_000_000n * FMX).toString(16)]);
    await (await vault.connect(alice).fundRewards({ value: 1_000_000n * FMX, ...GL })).wait();
    const whalePosBefore = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1);
    await advance(30 * DAY);
    const whalePos = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1);
    const earned30d = whalePos.pendingRewardsWei - whalePosBefore.pendingRewardsWei;
    near(earned30d, projectedRewardsWei(whaleStake, uiApr, 30n * 86_400n), 100n, '30d accrual past the knee');
    ok(`drip cap binds: UI shows ${Number(uiApr) / 100}% effective (cap 10%), the vault's rate view agrees and it pays that`);

    // --- 14. fail-closed: the settled pool empties with no transaction; accrual stops ---
    await (await vault.fundRewards({ value: 1n, ...GL })).wait(); // settle, so raw == settled at this block
    const o = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(o.rewardPoolWei, await vault.rewardPool());
    const runway = runwaySeconds(o.rewardPoolWei, o.totalWeightedUnitsWei, DRIP);
    assert.equal(runway, await vault.poolRunwaySeconds(), 'UI runway == the vault runway view');
    await advance(Number(runway) + 30 * DAY); // run PAST depletion — and send nothing
    const afterDepletion = await fetchVaultOverview(provider, vaultAddr);
    assert.ok(await vault.rewardPool() > FMX, 'rewardPool() itself is stale until a transaction settles it');
    assert.ok(afterDepletion.rewardPoolWei < FMX, `settled pool shows it empty (${formatEther(afterDepletion.rewardPoolWei)} left)`);
    const t0 = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1).pendingRewardsWei;
    await advance(30 * DAY);
    const t1 = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1).pendingRewardsWei;
    assert.equal(t1, t0, 'no further accrual once the pool is empty — fail-closed, no IOUs');
    assert.equal((await fetchVaultOverview(provider, vaultAddr)).totalStakedWei, o.totalStakedWei, 'principal untouched');
    assert.equal(perUnitAprBps(12_000_000n * FMX, DRIP), 1_000n, 'at the exact knee the base rate still holds');
    ok("fail-closed pool: the UI's settled pool reads empty before any transaction; accrual stopped; principal intact");

    // --- 15. deposits paused: shown, refused in plain words, exits unaffected ---
    await (await vault.pauseDeposits(GL)).wait();
    assert.equal((await fetchVaultOverview(provider, vaultAddr)).paused, true);
    let pausedErr = null;
    await stake(aliceSigner, vaultAddr, TIER_IDS.Flexible, parseEther('1')).catch((e) => (pausedErr = e));
    assert.ok(pausedErr, 'stake refused while paused');
    assert.match(humanizeTxError(pausedErr), /paused by the vault owner/);
    await (await claim(whale, vaultAddr, whalePos.id)).wait(); // claims never pause
    await (await vault.unpauseDeposits(GL)).wait();
    ok('deposits paused: overview flags it, stake refused in plain words, claims still pay');

    // --- MAX-button headroom math holds against a real balance ---
    const bal = await provider.getBalance(bob.address);
    const feeData = await provider.getFeeData();
    const maxStake = maxStakeableWei(bal, feeData.maxFeePerGas ?? 1n);
    assert.ok(maxStake > 0n && maxStake < bal);
    ok('MAX math: stakeable amount leaves fee headroom against the live balance');

    provider.destroy();
  } finally {
    anvil.kill('SIGTERM');
    await Promise.race([anvilExit, new Promise((r) => setTimeout(r, 5000))]);
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
    await anvilExit;
  }

  for (let i = 0; i < 20 && !(await portFree(PORT)); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(await portFree(PORT), true, `port ${PORT} must be free after the test`);
  ok(`anvil stopped; port ${PORT} is free again`);

  console.log('\nE2E: all checks passed.');
  if (anvilErr.trim()) console.log(`(anvil stderr: ${anvilErr.trim().slice(0, 200)})`);
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
