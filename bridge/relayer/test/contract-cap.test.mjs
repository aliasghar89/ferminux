// A transfer refused as over_contract_cap is not refused for ever.
//
// send() has already locked or burned the funds on the source chain by the
// time a validator sees the destination's maxPerTransfer is too low. The fix
// on chain is for the owner to raise that cap; before, the validator never
// looked at the transfer again, so raising it changed nothing. Run against
// both store backends, because the revisit depends on the store's reason
// filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZeroAddress, getAddress } from 'ethers';

import { openStore } from '../src/db.ts';
import { createLogger } from '../src/logger.ts';
import { CONTRACT_CAP_RECHECK_MS, revisitContractCapRejections } from '../src/validator.ts';

const SRC = 3961;
const DST = 56;
const DOWN = 137;
const TOKEN = getAddress(`0x${'22'.repeat(20)}`);
const OTHER_TOKEN = getAddress(`0x${'55'.repeat(20)}`);
const E18 = 10n ** 18n;

const silent = () => createLogger('error', 'json', {}, () => {});

function row(id, { amount, reason, dstChainId = DST, dstToken = TOKEN, status = 'rejected' }) {
  const now = Date.now();
  return {
    transferId: `0x${id.repeat(32)}`,
    transfer: {
      srcChainId: SRC,
      dstChainId,
      nonce: 1,
      srcToken: ZeroAddress,
      dstToken,
      sender: getAddress(`0x${'33'.repeat(20)}`),
      recipient: getAddress(`0x${'44'.repeat(20)}`),
      amount,
    },
    fee: 0n,
    srcBlockNumber: 10,
    srcBlockHash: `0x${'aa'.repeat(32)}`,
    srcTxHash: `0x${'bb'.repeat(32)}`,
    srcLogIndex: 0,
    status,
    reason,
    firstSeenAt: now,
    confirmedAt: now,
    executedAt: null,
    executedTxHash: null,
    updatedAt: now,
  };
}

/** A destination whose registry answers with whatever `caps` holds now. */
function destination(caps) {
  const reads = [];
  return {
    reads,
    client: {
      name: 'b',
      healthyEndpoints: [{}],
      readTokenConfig: async (token) => {
        reads.push(token);
        const cap = caps[getAddress(token)];
        if (cap instanceof Error) throw cap;
        return { kind: 2, paused: false, remoteChainId: BigInt(SRC), remoteToken: ZeroAddress, maxPerTransfer: cap, dailyCap: 1000n * E18 };
      },
    },
  };
}

test('the contract cap is re-checked on a slow timer, not every tick', () => {
  assert.ok(CONTRACT_CAP_RECHECK_MS >= 10_000 && CONTRACT_CAP_RECHECK_MS <= 5 * 60_000);
});

for (const driver of ['sqlite', 'journal']) {
  const withStore = async (fn) => {
    const dir = mkdtempSync(join(tmpdir(), `fmx-cap-${driver}-`));
    const store = await openStore(join(dir, 'relayer.db'), driver);
    try {
      await fn(store);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test(`[${driver}] an over_contract_cap rejection goes back to confirmed once the destination cap covers it`, async () => {
    await withStore(async (store) => {
      const fits = row('01', { amount: 5n * E18, reason: 'over_contract_cap: amount 5000000000000000000 exceeds the destination contract\'s maxPerTransfer 1000000000000000000' });
      const still = row('02', { amount: 20n * E18, reason: 'over_contract_cap: amount 20000000000000000000 exceeds the destination contract\'s maxPerTransfer 1000000000000000000' });
      const local = row('03', { amount: 2n * E18, reason: 'over_local_per_transfer_cap: amount 2000000000000000000 exceeds the local destination per-transfer cap 1000000000000000000' });
      const unhealthy = row('04', { amount: 2n * E18, dstChainId: DOWN, reason: 'over_contract_cap: amount 2000000000000000000 exceeds the destination contract\'s maxPerTransfer 1' });
      const otherToken = row('05', { amount: 2n * E18, dstToken: OTHER_TOKEN, reason: 'over_contract_cap: amount 2000000000000000000 exceeds the destination contract\'s maxPerTransfer 1' });
      const signed = row('06', { amount: 2n * E18, status: 'signed', reason: null });
      for (const r of [fits, still, local, unhealthy, otherToken, signed]) store.putTransfer(r);

      const caps = { [TOKEN]: 1n * E18, [OTHER_TOKEN]: new Error('rpc timeout') };
      const dst = destination(caps);
      const chains = new Map([
        [DST, dst.client],
        [DOWN, { name: 'down', healthyEndpoints: [], readTokenConfig: async () => assert.fail('an unhealthy chain is not read') }],
      ]);

      // Cap not raised yet: nothing moves, and one read per token covers every row on it.
      assert.deepEqual(await revisitContractCapRejections(store, chains, silent()), []);
      assert.deepEqual(dst.reads.sort(), [TOKEN, OTHER_TOKEN].sort());
      assert.equal(store.getTransfer(fits.transferId).status, 'rejected');

      // The owner raises the destination cap to 10 tokens.
      caps[TOKEN] = 10n * E18;
      dst.reads.length = 0;
      const moved = await revisitContractCapRejections(store, chains, silent());
      assert.deepEqual(moved, [fits.transferId]);
      assert.equal(dst.reads.filter((t) => t === TOKEN).length, 1, 'one registry read for the token, not one per row');

      const back = store.getTransfer(fits.transferId);
      assert.equal(back.status, 'confirmed', 'within the new cap: back in line for a full verification');
      assert.equal(back.reason, null);
      assert.ok(store.listTransfers({ status: ['confirmed'] }).some((t) => t.transferId === fits.transferId));

      assert.equal(store.getTransfer(still.transferId).status, 'rejected', 'still above the raised cap');
      assert.equal(store.getTransfer(local.transferId).status, 'rejected', "this node's own cap is not the contract's and is not revisited");
      assert.equal(store.getTransfer(unhealthy.transferId).status, 'rejected', 'no healthy endpoint: decide nothing');
      assert.equal(store.getTransfer(otherToken.transferId).status, 'rejected', 'a failed read is not a raised cap');
      assert.equal(store.getTransfer(signed.transferId).status, 'signed');

      // Nothing left that fits: a further pass is a no-op.
      assert.deepEqual(await revisitContractCapRejections(store, chains, silent()), []);
    });
  });
}
