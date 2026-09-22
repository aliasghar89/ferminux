// Durable state, both backends.
//
// The property that matters: after a kill -9 the process must come back knowing
// exactly what it had already done — where each chain was scanned to, which
// transfers it signed, and which transaction it had already signed and possibly
// broadcast. Every test below is run against BOTH the SQLite and the journal
// backend, because "it works on the one we use in prod" is how the other one
// rots until the day you need it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.ts';

const TRANSFER = {
  srcChainId: 3961,
  dstChainId: 56,
  nonce: 1,
  srcToken: '0x0000000000000000000000000000000000000000',
  dstToken: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  sender: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  recipient: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  amount: 9990000000000000000n,
};
const ID = '0xe68c83e60233111e9eb70f8c32630bec2ebe43abe4d1e278faeb6106f9274b5b';

function storedTransfer(overrides = {}) {
  const now = Date.now();
  return {
    transferId: ID,
    transfer: TRANSFER,
    fee: 10000000000000000n,
    srcBlockNumber: 5,
    srcBlockHash: `0x${'aa'.repeat(32)}`,
    srcTxHash: `0x${'bb'.repeat(32)}`,
    srcLogIndex: 0,
    status: 'seen',
    reason: null,
    firstSeenAt: now,
    confirmedAt: null,
    executedAt: null,
    executedTxHash: null,
    updatedAt: now,
    ...overrides,
  };
}

for (const driver of ['sqlite', 'journal']) {
  const withStore = async (fn) => {
    const dir = mkdtempSync(join(tmpdir(), `fmx-relayer-${driver}-`));
    const path = join(dir, 'relayer.db');
    try {
      let store = await openStore(path, driver);
      const reopen = async () => {
        store.close();
        store = await openStore(path, driver);
        return store;
      };
      await fn(store, reopen);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test(`[${driver}] the driver is the one we asked for`, async () => {
    await withStore(async (store) => assert.equal(store.driver, driver));
  });

  test(`[${driver}] scan cursors survive a restart`, async () => {
    await withStore(async (store, reopen) => {
      assert.equal(store.getCursor(3961), null, 'no cursor before the first scan');
      store.setCursor(3961, 1234);
      store.setCursor(56, 99);
      const fresh = await reopen();
      assert.equal(fresh.getCursor(3961), 1234);
      assert.equal(fresh.getCursor(56), 99);
    });
  });

  test(`[${driver}] a transfer and its bigint amounts round-trip exactly`, async () => {
    await withStore(async (store, reopen) => {
      store.putTransfer(storedTransfer());
      const fresh = await reopen();
      const got = fresh.getTransfer(ID);
      assert.equal(got.transfer.amount, TRANSFER.amount);
      assert.equal(typeof got.transfer.amount, 'bigint');
      assert.equal(got.fee, 10000000000000000n);
      assert.equal(got.srcBlockHash, `0x${'aa'.repeat(32)}`);
      assert.equal(got.status, 'seen');
    });
  });

  test(`[${driver}] status transitions and executed marking persist`, async () => {
    await withStore(async (store, reopen) => {
      store.putTransfer(storedTransfer());
      store.setTransferStatus(ID, 'confirmed');
      assert.ok(store.getTransfer(ID).confirmedAt > 0, 'confirmedAt is stamped once');
      store.setTransferStatus(ID, 'signed');
      store.markExecuted(ID, `0x${'cc'.repeat(32)}`);

      const fresh = await reopen();
      const got = fresh.getTransfer(ID);
      assert.equal(got.status, 'executed');
      assert.equal(got.executedTxHash, `0x${'cc'.repeat(32)}`);
      assert.ok(got.executedAt > 0);
    });
  });

  test(`[${driver}] a rejection reason is kept verbatim`, async () => {
    await withStore(async (store) => {
      store.putTransfer(storedTransfer());
      store.setTransferStatus(ID, 'rejected', 'over_local_per_transfer_cap: amount 5 exceeds 1');
      assert.match(store.getTransfer(ID).reason, /over_local_per_transfer_cap/);
    });
  });

  test(`[${driver}] one signature per signer, first write wins`, async () => {
    await withStore(async (store, reopen) => {
      const sig = (signer, signature, origin) => ({ transferId: ID, signer, signature, origin, createdAt: Date.now() });
      store.putSignature(sig('0x1111111111111111111111111111111111111111', '0xaa', 'local'));
      store.putSignature(sig('0x1111111111111111111111111111111111111111', '0xbb', 'peer-2'));
      store.putSignature(sig('0x2222222222222222222222222222222222222222', '0xcc', 'peer-2'));

      const fresh = await reopen();
      const sigs = fresh.getSignatures(ID);
      assert.equal(sigs.length, 2, 'a repeated signer never occupies two slots');
      assert.equal(sigs.find((s) => s.signer.endsWith('1111')).signature, '0xaa', 'the first write stands');
    });
  });

  test(`[${driver}] a submission survives a crash with its nonce and raw bytes`, async () => {
    await withStore(async (store, reopen) => {
      const attempt = {
        txHash: `0x${'dd'.repeat(32)}`,
        raw: '0x02f8b1',
        maxFeePerGas: '3000000000',
        maxPriorityFeePerGas: '1000000000',
        gasLimit: '250000',
        sentAt: Date.now(),
      };
      store.putSubmission({
        transferId: ID,
        dstChainId: 56,
        accountNonce: 7,
        attempts: [attempt],
        status: 'pending',
        minedTxHash: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // kill -9 happens here
      const fresh = await reopen();
      const pending = fresh.listSubmissions('pending');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].accountNonce, 7, 'the nonce is what makes retries mutually exclusive');
      assert.equal(pending[0].attempts[0].txHash, attempt.txHash);
      assert.equal(pending[0].attempts[0].raw, '0x02f8b1', 'the exact bytes can be re-broadcast');
    });
  });

  test(`[${driver}] escalation appends attempts and keeps the same nonce`, async () => {
    await withStore(async (store) => {
      const mk = (hash, fee) => ({ txHash: hash, raw: '0x', maxFeePerGas: fee, maxPriorityFeePerGas: '1', gasLimit: '1', sentAt: Date.now() });
      const base = {
        transferId: ID,
        dstChainId: 56,
        accountNonce: 3,
        attempts: [mk('0x01', '100')],
        status: 'pending',
        minedTxHash: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.putSubmission(base);
      store.putSubmission({ ...base, attempts: [...base.attempts, mk('0x02', '125')] });
      const got = store.getSubmission(ID);
      assert.equal(got.attempts.length, 2);
      assert.equal(got.accountNonce, 3, 'every attempt shares one nonce');
      assert.deepEqual(got.attempts.map((a) => a.txHash), ['0x01', '0x02']);
    });
  });

  test(`[${driver}] volume windows persist across a restart`, async () => {
    await withStore(async (store, reopen) => {
      store.putWindow({ key: '3961:0x0:out', used: 12345678901234567890n, updatedAt: 1_700_000_000_000 });
      const fresh = await reopen();
      const w = fresh.getWindow('3961:0x0:out');
      assert.equal(w.used, 12345678901234567890n, 'a validator cannot reset its own cap by restarting');
      assert.equal(w.updatedAt, 1_700_000_000_000);
    });
  });

  test(`[${driver}] listTransfers filters by status and destination`, async () => {
    await withStore(async (store) => {
      store.putTransfer(storedTransfer());
      store.putTransfer(storedTransfer({ transferId: `0x${'ee'.repeat(32)}`, status: 'signed' }));
      store.putTransfer(
        storedTransfer({
          transferId: `0x${'ff'.repeat(32)}`,
          status: 'signed',
          transfer: { ...TRANSFER, dstChainId: 137 },
        }),
      );
      assert.equal(store.listTransfers({ status: ['signed'] }).length, 2);
      assert.equal(store.listTransfers({ status: ['signed'], dstChainId: 56 }).length, 1);
      assert.equal(store.listTransfers({ status: ['seen', 'signed'] }).length, 3);
      assert.equal(store.counts().transfers_signed, 2);
    });
  });
}
