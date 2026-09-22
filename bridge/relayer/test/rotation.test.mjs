// Validator rotation, from the submitter's side.
//
// The contract rule this is written against (FerminuxBridge._verifySignatures):
//
//     require(isValidator[signer], "BRIDGE: not a validator");
//
// applied to EVERY signature in the bundle, before the threshold is counted. So
// one attestation from a validator who has since been rotated out does not get
// skipped — it reverts the whole call, taking a perfectly good quorum with it.
// A submitter that collects signatures once and replays the same set therefore
// strands transfers across a rotation, even though enough current validators
// have already signed.
//
// The rule the submitter now implements, and what is proved below:
//
//   1. the validator set is re-read from the DESTINATION on every pass, and the
//      bundle is re-sliced against it — never cached, never replayed
//   2. signatures from addresses that are no longer validators are dropped, and
//      the drop is reported rather than swallowed
//   3. a bundle already in the mempool whose signers have gone stale is noticed
//      immediately, so it can be replaced at the same nonce instead of sitting
//      out the receipt timeout on a transaction that can only revert
//   4. if the rotation takes the quorum with it, that is a WAIT — the transfer
//      is still valid and can still be signed — never an abandon
//
// No anvil: the selection rule is a pure function, and the wire half is proved
// against a fake JSON-RPC node that serves a real ABI-encoded getValidators().
// That node binds port 0 and reads the port back, the same rule the rest of this
// suite follows — the fixed ports belong to the fixtures that must be addressed
// by name, and nothing here needs to be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Interface, Wallet, ZeroAddress, getAddress } from 'ethers';

import { Alerter } from '../src/alerts.ts';
import { BRIDGE_ABI } from '../src/abi.ts';
import { ChainClient } from '../src/chain.ts';
import { INSECURE_ACKNOWLEDGEMENT, parseConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { selectSignatures, staleSigners } from '../src/submitter.ts';
import { digestFor, recoverSigner, transferIdOf } from '../src/transfer.ts';

const BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CHAIN_A = 3961;
const CHAIN_B = 56;

const iface = new Interface(BRIDGE_ABI);
const silentLogger = () => createLogger('error', 'json', {}, () => {});

/** Four deterministic validator identities. Test-only keys, obviously. */
const V = ['a1', 'b2', 'c3', 'd4'].map((seed, i) => new Wallet(`0x${seed.repeat(32).slice(0, 64 - 1)}${i + 1}`));
const [V1, V2, V3, V4] = V;

const TRANSFER = {
  srcChainId: CHAIN_A,
  dstChainId: CHAIN_B,
  nonce: 11,
  srcToken: ZeroAddress,
  dstToken: getAddress(`0x${'22'.repeat(20)}`),
  sender: getAddress(`0x${'33'.repeat(20)}`),
  recipient: getAddress(`0x${'44'.repeat(20)}`),
  amount: 5n * 10n ** 18n,
};

/** Real signatures over the real digest, so `signer` is a recovered address. */
async function signedBy(wallets) {
  const digest = digestFor(TRANSFER, BRIDGE);
  return Promise.all(
    wallets.map(async (w) => {
      const signature = w.signingKey.sign(digest).serialized;
      return { transferId: transferIdOf(TRANSFER), signer: recoverSigner(digest, signature), signature, origin: 'peer', createdAt: Date.now() };
    }),
  );
}

// ============================================================================
// The selection rule
// ============================================================================

test('rotation: a removed validator is dropped, and the remaining quorum still ships', async () => {
  const stored = await signedBy([V1, V2, V3]);
  const before = selectSignatures(stored, [V1.address, V2.address, V3.address], 2);
  assert.deepEqual(before.dropped, [], 'nothing to drop while all three are in the set');
  assert.equal(before.sigs.length, 2, 'exactly the threshold, not every signature held');

  // V1 is rotated out while these three signatures sit in the store.
  const after = selectSignatures(stored, [V2.address, V3.address, V4.address], 2);
  assert.deepEqual(after.dropped, [getAddress(V1.address)], 'the stale attestation is named, not silently skipped');
  assert.deepEqual(
    after.sigs.map((s) => s.signer).sort(),
    [getAddress(V2.address), getAddress(V3.address)].sort(),
    'and the bundle is rebuilt out of validators who are still in the set',
  );
  // The whole point: the old bundle would have reverted, this one cannot for
  // this reason.
  assert.ok(after.sigs.every((s) => [V2.address, V3.address].map(getAddress).includes(s.signer)));
});

test('rotation: a signature from an address that was NEVER a validator is dropped too', async () => {
  const stored = await signedBy([V1, V4]);
  const { sigs, dropped } = selectSignatures(stored, [V1.address, V2.address, V3.address], 1);
  assert.deepEqual(dropped, [getAddress(V4.address)]);
  assert.deepEqual(sigs.map((s) => s.signer), [getAddress(V1.address)]);
});

test('rotation: a validator ADDED after signing is usable immediately', async () => {
  const stored = await signedBy([V4]);
  const { sigs, dropped } = selectSignatures(stored, [V1.address, V4.address], 1);
  assert.deepEqual(dropped, []);
  assert.deepEqual(sigs.map((s) => s.signer), [getAddress(V4.address)]);
});

test('rotation: when the rotation takes the quorum, the bundle is short — not wrong', async () => {
  const stored = await signedBy([V1, V2]);
  const threshold = 2;
  const { sigs, dropped } = selectSignatures(stored, [V2.address, V3.address, V4.address], threshold);
  assert.deepEqual(dropped, [getAddress(V1.address)]);
  assert.equal(sigs.length, 1);
  assert.ok(sigs.length < threshold, 'the caller waits for another signature; it does not ship a doomed bundle');
});

test('rotation: address matching does not depend on the case the signer was stored in', async () => {
  const stored = (await signedBy([V1, V2])).map((s) => ({ ...s, signer: s.signer.toLowerCase() }));
  // ...and the validator set comes back from the chain checksummed.
  const { sigs, dropped } = selectSignatures(stored, [getAddress(V1.address), getAddress(V2.address)], 2);
  assert.deepEqual(dropped, [], 'a lowercase record of a current validator is not a stale signature');
  assert.equal(sigs.length, 2);
  for (const s of sigs) assert.equal(s.signer, getAddress(s.signer), 'and what goes out is checksummed');
});

test('rotation: a repeated signer is collapsed — the contract rejects duplicates outright', async () => {
  const [one] = await signedBy([V1]);
  const { sigs } = selectSignatures([one, { ...one, origin: 'other-peer' }], [V1.address], 1);
  assert.equal(sigs.length, 1);
});

test('rotation: the bundle order is numeric by address, not the host locale', async () => {
  const stored = await signedBy([V1, V2, V3, V4]);
  const validators = V.map((w) => w.address);
  const order = selectSignatures(stored, validators, 4).sigs.map((s) => BigInt(s.signer));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i], `signatures are ascending by address value: ${order.join(', ')}`);
  }
  // Same input, shuffled: the same bytes come out. A retry at the same nonce
  // rebuilds identical calldata instead of a different-but-equivalent bundle.
  const shuffled = [...stored].reverse();
  assert.deepEqual(
    selectSignatures(shuffled, validators, 4).sigs,
    selectSignatures(stored, validators, 4).sigs,
  );
});

test('rotation: an unreadable stored signer is dropped, not thrown from a poll loop', async () => {
  const stored = await signedBy([V1]);
  const { sigs, dropped } = selectSignatures([...stored, { signer: 'not-an-address', signature: '0x00' }], [V1.address], 1);
  assert.deepEqual(dropped, ['not-an-address']);
  assert.equal(sigs.length, 1);
});

// ============================================================================
// The in-flight bundle
// ============================================================================

test('rotation: a bundle already in the mempool is known to be stale the moment the set changes', () => {
  const signers = [getAddress(V1.address), getAddress(V2.address)];
  assert.deepEqual(staleSigners(signers, [V1.address, V2.address, V3.address]), [], 'nothing stale while both are validators');
  assert.deepEqual(
    staleSigners(signers, [V2.address, V3.address, V4.address]),
    [getAddress(V1.address)],
    'V1 was removed, so the transaction holding V1 can now only revert',
  );
  assert.deepEqual(staleSigners(signers, []), signers, 'an empty set makes every signature in flight stale');
});

test('rotation: an attempt recorded before signers were tracked falls back to the timeout, not to a rebuild loop', () => {
  assert.deepEqual(staleSigners(undefined, [V1.address]), [], 'unknown is not the same as none');
  assert.deepEqual(staleSigners([], [V1.address]), []);
});

// ============================================================================
// Through the wire: the set really is re-read from the destination
// ============================================================================

/**
 * A destination node that answers threshold() and getValidators() out of a
 * mutable set, so a rotation can happen between two reads of the same client.
 */
async function fakeDestination(initial, threshold) {
  const state = { validators: initial.map(getAddress), threshold, calls: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body);
      const answer = (p) => {
        if (p.method === 'eth_chainId') return { jsonrpc: '2.0', id: p.id, result: `0x${CHAIN_B.toString(16)}` };
        if (p.method === 'eth_call') {
          const data = p.params[0].data;
          if (data.startsWith(iface.getFunction('getValidators').selector)) {
            state.calls++;
            return { jsonrpc: '2.0', id: p.id, result: iface.encodeFunctionResult('getValidators', [state.validators]) };
          }
          if (data.startsWith(iface.getFunction('threshold').selector)) {
            return { jsonrpc: '2.0', id: p.id, result: iface.encodeFunctionResult('threshold', [state.threshold]) };
          }
        }
        return { jsonrpc: '2.0', id: p.id, error: { code: -32601, message: `unsupported: ${p.method}` } };
      };
      const out = Array.isArray(payload) ? payload.map(answer) : answer(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.closeIdleConnections?.();
        server.close(r);
        server.closeAllConnections?.();
      }),
  };
}

test('rotation: the submitter re-slices against a set read from the destination, mid-flight', async () => {
  const node = await fakeDestination([V1.address, V2.address, V3.address], 2);
  const cfg = parseConfig(
    JSON.stringify({
      network: 'test',
      chains: [
        {
          name: 'b',
          chainId: CHAIN_B,
          rpcUrls: [node.url],
          bridgeAddress: BRIDGE,
          confirmations: 3,
          limits: { default: { maxPerTransfer: '10000000000000000000', dailyCap: '100000000000000000000' }, tokens: {} },
        },
      ],
      // One loopback node is one witness however it is spelled; this fixture is
      // about the validator set, not about endpoint independence, so it says so.
      insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
    }),
    'x',
  );
  const client = new ChainClient(cfg.chains[0], silentLogger(), new Alerter(cfg, 'test', silentLogger()));
  try {
    await client.healthCheck();
    const stored = await signedBy([V1, V2, V3]);

    // What usableSignatures() does, with the reads going over a real socket.
    const read = async () => {
      const bridge = client.bridge();
      const [threshold, validators] = await Promise.all([bridge.threshold(), bridge.getValidators()]);
      return selectSignatures(stored, validators, Number(threshold));
    };

    const before = await read();
    assert.equal(before.sigs.length, 2);
    assert.deepEqual(before.dropped, []);

    // The rotation happens on chain, between two passes of the same submitter.
    node.state.validators = [V2.address, V3.address, V4.address].map(getAddress);

    const after = await read();
    assert.deepEqual(after.dropped, [getAddress(V1.address)], 'the removal is seen without restarting the process');
    assert.equal(after.sigs.length, 2, 'and a full quorum is still available from the current set');
    assert.ok(
      !after.sigs.some((s) => s.signer === getAddress(V1.address)),
      'the transfer is NOT stranded, and the bundle no longer contains the removed validator',
    );
    assert.ok(node.state.calls >= 2, 'the set was read again rather than cached from the first pass');

    // Raise the threshold beyond what the surviving signatures can meet: the
    // submitter must hold, not ship two signatures against a threshold of three.
    node.state.threshold = 3;
    const raised = await read();
    assert.equal(raised.sigs.length, 2);
    assert.ok(raised.sigs.length < 3);
  } finally {
    for (const e of client.endpoints) e.provider.destroy();
    await node.close();
  }
});
