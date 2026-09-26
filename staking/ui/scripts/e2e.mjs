#!/usr/bin/env node
// End-to-end data-layer test for the Ferminux staking UI.
//
// Starts a local anvil on port 8612 with --chain-id 3961, compiles the fixture
// contracts (fixtures/ — DESIGN.md-faithful stand-ins until the production
// contracts land in /staking/contracts), then drives the SAME modules the UI
// imports (src/lib/*, src/config.ts — no browser globals):
//
//   1. deploy StakingVaultFixture + NodeRegistryFixture; fund the reward pool
//   2. read the empty-network overview + all 4 tiers through the UI lib
//   3. stake flexible; assert position, totals, staker count, weighted units
//   4. stake a 25k validator-track bond; advance time; pendingRewards accrues
//      and matches the UI's own APY projection math
//   5. claim through the lib; the claimed FMX arrives; pool shrinks by it
//   6. cooldown: beginUnstake, early withdraw reverts, +7d, withdraw pays out
//   7. lock enforcement: beginUnstake on a still-locked position reverts;
//      emergencyExit forfeits rewards + 5% principal into the pool
//   8. register a node through the lib (enode → bytes32 id), read the roster,
//      watchtower attests uptime, roster shows lastSeen/uptime; a non-eligible
//      position is refused
//   9. drip-cap scaling: stake enough that the cap binds and the UI's
//      effectiveAprBps matches what the vault actually pays
//  10. fail-closed pool: accrual stops at the pool floor, principal intact
//  11. kill anvil and verify port 8612 is free again
//
// Usage: npm run e2e

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Wallet, ContractFactory, parseEther, formatEther } from 'ethers';

import { CHAIN_ID } from '../src/config.ts';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';
import {
  fetchVaultOverview,
  fetchTiers,
  fetchPositions,
  fetchDenied,
  stake,
  claim,
  beginUnstake,
  withdraw,
  emergencyExit,
  humanizeTxError,
} from '../src/lib/staking.ts';
import { fetchRoster, fetchRegistryParams, registerNode, enodeToId } from '../src/lib/nodes.ts';
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
const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const YEAR = SECONDS_PER_YEAR;
const FMX = 10n ** 18n;

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
  return JSON.parse(readFileSync(`${FIXTURES}/out/${name}.sol/${name}.json`, 'utf8'));
}

async function main() {
  assert.equal(CHAIN_ID, 3961, 'config CHAIN_ID must be 3961');

  execFileSync('forge', ['build'], { cwd: FIXTURES, stdio: 'pipe' });
  ok('fixture contracts compiled (solc 0.8.24, evm=paris)');

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
    const now = async () => (await provider.getBlock('latest')).timestamp;
    const advance = async (seconds) => {
      await provider.send('evm_increaseTime', [seconds]);
      await provider.send('evm_mine', []);
    };

    // Wallets: deployer/watchtower, alice (staker), bob (validator op), carol (denied)
    const [deployer, alice, bob, carol] = KEYS.map((k) => new Wallet(k, provider));
    // The UI's session-key module produces the signer the app actually uses.
    const aliceKey = walletFromPrivateKey(KEYS[1]);
    assert.equal(aliceKey.address, alice.address);
    const aliceSigner = sessionSigner(aliceKey, provider);
    ok('session-key module derives the same signer the app will use');

    // --- 1. deploy + fund ---
    const DRIP = 1_200_000n * FMX; // 1.2M FMX/yr (DESIGN §1)
    const COOLDOWN = 7 * 86_400;
    const VALIDATOR_LOCK = 365 * 86_400;
    const vaultArt = artifact('StakingVaultFixture');
    const vaultFactory = new ContractFactory(vaultArt.abi, vaultArt.bytecode.object, deployer);
    const vaultDeploy = await vaultFactory.deploy(DRIP, COOLDOWN, VALIDATOR_LOCK, [carol.address]);
    await vaultDeploy.waitForDeployment();
    const vaultAddr = await vaultDeploy.getAddress();

    const regArt = artifact('NodeRegistryFixture');
    const regFactory = new ContractFactory(regArt.abi, regArt.bytecode.object, deployer);
    const regDeploy = await regFactory.deploy(vaultAddr, 3, parseEther('25000'), deployer.address);
    await regDeploy.waitForDeployment();
    const registryAddr = await regDeploy.getAddress();

    const POOL = 150_000n * FMX; // scaled-down pool for the test
    await (await vaultDeploy.connect(deployer).fundPool({ value: POOL })).wait();
    ok(`deployed vault ${vaultAddr.slice(0, 10)}… + registry ${registryAddr.slice(0, 10)}…; pool funded with ${formatEther(POOL)} FMX`);

    // --- 2. empty-network reads through the UI lib ---
    let overview = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(overview.totalStakedWei, 0n);
    assert.equal(overview.totalWeightedUnitsWei, 0n);
    assert.equal(overview.stakerCount, 0);
    assert.equal(overview.rewardPoolWei, POOL);
    assert.equal(overview.dripPerYearWei, DRIP);
    assert.equal(overview.cooldownSeconds, COOLDOWN);
    assert.equal(overview.emergencyPenaltyBps, 500n);
    assert.equal(runwaySeconds(overview.rewardPoolWei, overview.totalWeightedUnitsWei, DRIP), null);
    ok('overview: zero staked, full pool, indefinite runway — real reads, no estimates');

    const tiers = await fetchTiers(provider, vaultAddr);
    assert.equal(tiers.length, 4);
    assert.deepEqual(
      tiers.map((t) => [t.lockSeconds, t.weightBps, t.aprCapBps]),
      [
        [0n, 10_000n, 1_000n],
        [BigInt(90 * 86_400), 15_000n, 1_500n],
        [BigInt(180 * 86_400), 20_000n, 2_000n],
        [BigInt(VALIDATOR_LOCK), 30_000n, 3_000n],
      ],
    );
    assert.equal(tiers[3].minStakeWei, parseEther('25000'));
    assert.equal(tiers[3].requiresNode, true);
    ok('tiers: 4 DESIGN.md tiers (1.0×/10% … 3.0×/30%, validator min 25k + node)');

    assert.equal(await fetchDenied(provider, vaultAddr, carol.address), true);
    assert.equal(await fetchDenied(provider, vaultAddr, alice.address), false);
    await assert.rejects(stake(carol.connect(provider), vaultAddr, 0, parseEther('1')), /denied/i);
    assert.match(humanizeTxError(new Error('execution reverted: "SV: denied address"')), /excluded from staking/i);
    ok('premine deny list: excluded address cannot stake; error maps to plain words');

    // --- 3. alice stakes 1,000 FMX flexible through the UI lib ---
    const aliceStake = parseEther('1000');
    await (await stake(aliceSigner, vaultAddr, 0, aliceStake)).wait();
    overview = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(overview.totalStakedWei, aliceStake);
    assert.equal(overview.totalWeightedUnitsWei, weightedUnits(aliceStake, 10_000n));
    assert.equal(overview.stakerCount, 1);
    let alicePositions = await fetchPositions(provider, vaultAddr, alice.address);
    assert.equal(alicePositions.length, 1);
    assert.equal(alicePositions[0].amountWei, aliceStake);
    assert.equal(alicePositions[0].state, 'active');
    assert.equal(alicePositions[0].tier, 0);
    assert.equal(alicePositions[0].unlockTime, alicePositions[0].startTime, 'flexible: no lock');
    ok('stake(flexible 1,000 FMX): position, totals, staker count and weighted units all correct');

    // --- 4. bob stakes a validator bond; a year of accrual matches UI projections ---
    await assert.rejects(stake(bob, vaultAddr, 3, parseEther('24999')), /below tier minimum/i);
    const bond = parseEther('25000');
    await (await stake(bob, vaultAddr, 3, bond)).wait();
    overview = await fetchVaultOverview(provider, vaultAddr);
    const unitsNow = weightedUnits(aliceStake, 10_000n) + weightedUnits(bond, 30_000n);
    assert.equal(overview.totalWeightedUnitsWei, unitsNow);
    assert.equal(overview.stakerCount, 2);

    await advance(Number(YEAR)); // one year
    const bobPositions = await fetchPositions(provider, vaultAddr, bob.address);
    const bobPos = bobPositions[0];
    // Below the drip knee, the validator tier pays its full 30% cap.
    assert.equal(effectiveAprBps(30_000n, unitsNow, DRIP), 3_000n);
    const expectedYear = projectedRewardsWei(bond, 3_000n, YEAR); // 7,500 FMX (DESIGN §7.2)
    assert.equal(expectedYear, 7_500n * FMX);
    const drift = bobPos.pendingRewardsWei > expectedYear
      ? bobPos.pendingRewardsWei - expectedYear
      : expectedYear - bobPos.pendingRewardsWei;
    // anvil block timestamps add a few seconds of skew; tolerate < 0.01%.
    assert.ok(drift * 10_000n < expectedYear, `accrued ${formatEther(bobPos.pendingRewardsWei)} ≈ projected 7500`);
    ok(`accrual: 25k validator bond earned ${formatEther(bobPos.pendingRewardsWei).slice(0, 9)} FMX in 1yr — matches the UI's 30% projection`);

    // --- 5. claim pays out; raw pool drops by the payout; the UI's headroom
    //        view (pool minus already-owed rewards) barely moves, because the
    //        claimed rewards were already counted as owed — no double-count.
    const headroomBefore = (await fetchVaultOverview(provider, vaultAddr)).rewardPoolWei;
    const rawPoolBefore = await vaultDeploy.rewardPool();
    const bobBefore = await provider.getBalance(bob.address);
    const claimRcpt = await (await claim(bob, vaultAddr, bobPos.id)).wait();
    const gas = claimRcpt.gasUsed * claimRcpt.gasPrice;
    const bobAfter = await provider.getBalance(bob.address);
    const claimed = bobAfter - bobBefore + gas;
    assert.ok(claimed >= bobPos.pendingRewardsWei, 'claim pays at least the last pending read');
    const rawPoolAfter = await vaultDeploy.rewardPool();
    assert.equal(rawPoolBefore - rawPoolAfter, claimed, 'raw pool drops by exactly the payout');
    const headroomAfter = (await fetchVaultOverview(provider, vaultAddr)).rewardPoolWei;
    const headroomDrift = headroomBefore > headroomAfter ? headroomBefore - headroomAfter : headroomAfter - headroomBefore;
    assert.ok(headroomDrift < FMX, 'headroom view unchanged by the claim (rewards were already owed)');
    const bobRefetched = await fetchPositions(provider, vaultAddr, bob.address);
    assert.ok(bobRefetched[0].pendingRewardsWei < FMX / 100n, 'pending resets after claim');
    ok(`claim: ${formatEther(claimed).slice(0, 9)} FMX arrived; pool accounting exact (no double-count)`);

    // --- 6. cooldown lifecycle on the flexible position ---
    await (await beginUnstake(aliceSigner, vaultAddr, alicePositions[0].id)).wait();
    alicePositions = await fetchPositions(provider, vaultAddr, alice.address);
    assert.equal(alicePositions[0].state, 'cooling');
    const tNow = await now();
    assert.ok(alicePositions[0].cooldownEnd >= tNow + COOLDOWN - 5, 'cooldown ≈ 7 days out');
    await assert.rejects(withdraw(aliceSigner, vaultAddr, alicePositions[0].id), /cooldown not over/i);
    // No accrual during cooldown: pending is frozen.
    const frozen = alicePositions[0].pendingRewardsWei;
    await advance(3 * 86_400);
    const midCooldown = await fetchPositions(provider, vaultAddr, alice.address);
    assert.equal(midCooldown[0].pendingRewardsWei, frozen, 'no rewards accrue during cooldown');
    await advance(4 * 86_400 + 10);
    const aliceBefore = await provider.getBalance(alice.address);
    const wRcpt = await (await withdraw(aliceSigner, vaultAddr, alicePositions[0].id)).wait();
    const wGas = wRcpt.gasUsed * wRcpt.gasPrice;
    const aliceGot = (await provider.getBalance(alice.address)) - aliceBefore + wGas;
    assert.equal(aliceGot, aliceStake + frozen, 'withdraw pays principal + frozen rewards exactly');
    overview = await fetchVaultOverview(provider, vaultAddr);
    assert.equal(overview.stakerCount, 1, 'alice no longer counted as a staker');
    ok('cooldown: early withdraw refused; rewards frozen during cooldown; principal + rewards paid after 7d');

    // --- 7. lock + emergency exit on a Locked-90 position ---
    const lockAmount = parseEther('2000');
    await (await stake(aliceSigner, vaultAddr, 1, lockAmount)).wait();
    let locked = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.state === 'active');
    await assert.rejects(beginUnstake(aliceSigner, vaultAddr, locked.id), /still locked/i);
    await advance(10 * 86_400); // accrue something to forfeit
    locked = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.id === locked.id);
    assert.ok(locked.pendingRewardsWei > 0n);
    const poolPreExit = (await fetchVaultOverview(provider, vaultAddr)).rewardPoolWei;
    await (await emergencyExit(aliceSigner, vaultAddr, locked.id)).wait();
    const exited = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.id === locked.id);
    const penalty = (lockAmount * 500n) / 10_000n;
    assert.equal(exited.state, 'cooling');
    assert.equal(exited.amountWei, lockAmount - penalty, '5% principal penalty applied');
    assert.equal(exited.pendingRewardsWei, 0n, 'all unclaimed rewards forfeited');
    const poolPostExit = (await fetchVaultOverview(provider, vaultAddr)).rewardPoolWei;
    assert.ok(
      poolPostExit >= poolPreExit + penalty,
      `penalty + forfeited rewards returned to the pool (${formatEther(poolPostExit - poolPreExit)})`,
    );
    ok('emergency exit: forfeits accrued rewards + 5% of principal into the pool, then cooldown');

    // --- 8. node registration + roster through the UI lib ---
    const params = await fetchRegistryParams(provider, registryAddr);
    assert.equal(params.minBondWei, parseEther('25000'));
    assert.equal(params.validatorTier, 3);
    const ENODE =
      'enode://a979fb575495b8d6db44f750317d0f4622bf4c2aa3365d6af7c284339968eef29b69ad0dce72a4d8db5ebb4968de0e3bec910127f134779fbcb0cb6d3331163c@203.0.113.7:30303';
    const enodeId = enodeToId(ENODE);
    assert.ok(enodeId);
    const consensusAddr = Wallet.createRandom().address;
    const bobPosId = (await fetchPositions(provider, vaultAddr, bob.address))[0].id;
    // A non-validator position must be refused.
    await (await stake(aliceSigner, vaultAddr, 0, parseEther('50'))).wait();
    const alicePosId = (await fetchPositions(provider, vaultAddr, alice.address)).find((p) => p.state === 'active').id;
    await assert.rejects(
      registerNode(aliceSigner, registryAddr, alicePosId, consensusAddr, enodeId),
      /not a validator-track position/i,
    );
    await (await registerNode(bob, registryAddr, bobPosId, consensusAddr, enodeId)).wait();
    await assert.rejects(registerNode(bob, registryAddr, bobPosId, consensusAddr, enodeId), /already has a node/i);
    let roster = await fetchRoster(provider, registryAddr);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].operator, bob.address);
    assert.equal(roster[0].consensusAddr, consensusAddr);
    assert.equal(roster[0].enodeId, enodeId);
    assert.equal(roster[0].bondWei, bond);
    assert.equal(roster[0].active, true);
    assert.equal(roster[0].lastSeen, 0, 'no attestation yet');
    ok('nodes: validator position registers (consensus addr + enode id); flexible position refused; roster reads back');

    // Watchtower attests; roster shows lastSeen + uptime.
    const registry = regDeploy.connect(deployer);
    await (await registry.attest([0], [9_800])).wait();
    roster = await fetchRoster(provider, registryAddr);
    assert.equal(roster[0].uptimeBps, 9_800n);
    assert.ok(roster[0].lastSeen > 0);
    ok('watchtower attestation: roster lastSeen + uptime (98%) visible through the UI lib');

    // --- 9. drip-cap scaling: the UI's effective APY equals what the vault pays ---
    // Push weighted units past the knee: knee = DRIP/10% = 12M units.
    const whale = deployer; // holds ~10k FMX less deploys… anvil accounts have 10k; use setBalance
    await provider.send('anvil_setBalance', [whale.address, '0x' + (13_000_000n * FMX).toString(16)]);
    const whaleStake = 12_000_000n * FMX; // ×1.0 → 12M units + existing ≈ just past the knee
    await (await stake(whale, vaultAddr, 0, whaleStake)).wait();
    overview = await fetchVaultOverview(provider, vaultAddr);
    const units = overview.totalWeightedUnitsWei;
    assert.ok(units > 12_000_000n * FMX, 'past the drip knee');
    const uiApr = effectiveAprBps(10_000n, units, DRIP);
    assert.ok(uiApr < 1_000n, `flexible APY scales below cap (${uiApr} bps)`);
    // Fund the pool generously so accrual is not pool-limited during this check.
    await provider.send('anvil_setBalance', [alice.address, '0x' + (2_000_000n * FMX).toString(16)]);
    await (await vaultDeploy.connect(aliceSigner).fundPool({ value: 1_000_000n * FMX })).wait();
    const whalePosBefore = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1);
    await advance(30 * 86_400);
    const whalePos = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1);
    const earned30d = whalePos.pendingRewardsWei - whalePosBefore.pendingRewardsWei;
    const projected30d = projectedRewardsWei(whaleStake, uiApr, 30n * 86_400n);
    const skew = earned30d > projected30d ? earned30d - projected30d : projected30d - earned30d;
    assert.ok(skew * 100n < projected30d, `30d accrual ${formatEther(earned30d)} within 1% of UI projection ${formatEther(projected30d)}`);
    ok(`drip cap binds: UI shows ${Number(uiApr) / 100}% effective (cap 10%) and the vault pays exactly that`);

    // --- 10. fail-closed: accrual stops at the pool floor; principal intact ---
    const o = await fetchVaultOverview(provider, vaultAddr);
    // Outlay is now the full drip (cap binds): pool runway in seconds.
    const runway = runwaySeconds(o.rewardPoolWei, o.totalWeightedUnitsWei, DRIP);
    await advance(Number(runway) + 30 * 86_400); // run PAST depletion
    const afterDepletion = await fetchVaultOverview(provider, vaultAddr);
    assert.ok(afterDepletion.rewardPoolWei < FMX, `pool empty (${formatEther(afterDepletion.rewardPoolWei)} left)`);
    const t0 = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1).pendingRewardsWei;
    await advance(30 * 86_400);
    const t1 = (await fetchPositions(provider, vaultAddr, whale.address)).at(-1).pendingRewardsWei;
    assert.equal(t1, t0, 'no further accrual once the pool is empty — fail-closed, no IOUs');
    assert.equal((await fetchVaultOverview(provider, vaultAddr)).totalStakedWei, o.totalStakedWei, 'principal untouched');
    ok('fail-closed pool: accrual stopped at depletion; every stakers principal intact');

    // --- MAX-button headroom math holds against a real balance ---
    const bal = await provider.getBalance(bob.address);
    const feeData = await provider.getFeeData();
    const maxStake = maxStakeableWei(bal, feeData.maxFeePerGas ?? 1n);
    assert.ok(maxStake > 0n && maxStake < bal);
    ok('MAX math: stakeable amount leaves fee headroom against the live balance');

    // Sanity: perUnitAprBps at the exact knee equals the base rate.
    assert.equal(perUnitAprBps(12_000_000n * FMX, DRIP), 1_000n);

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
