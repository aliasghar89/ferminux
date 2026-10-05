// The watcher process end to end, against a hand-written JSON-RPC node.
//
// reconcile.test.mjs covers the bookkeeping; this covers what watch.mjs does
// with it — which chains it believes it scans — and that can only be seen by
// running it. The fake node binds an ephemeral port on 127.0.0.1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from '../../relayer/node_modules/ethers/lib.esm/index.js';

const WATCH = fileURLToPath(new URL('../watch.mjs', import.meta.url));
const FMX = 3961;
const BASE = 8453;
const BSC = 56;
const FMX_BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const BASE_BRIDGE = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

const iface = new ethers.Interface([
  'event Executed(bytes32 indexed transferId, uint64 indexed srcChainId, address indexed localToken, address remoteToken, address recipient, uint256 amount, uint256 signatureCount)',
]);

function executedLog({ transferId, srcChainId, blockNumber }) {
  const { topics, data } = iface.encodeEventLog('Executed', [
    transferId, srcChainId, ethers.ZeroAddress, ethers.ZeroAddress, `0x${'44'.repeat(20)}`, 10n ** 18n, 2n,
  ]);
  return {
    address: FMX_BRIDGE, topics, data,
    blockNumber: ethers.toQuantity(blockNumber), blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', logIndex: '0x0', removed: false,
  };
}

/** One node serving both configured chains: head 110, `logs` on the Ferminux bridge. */
async function fakeNode(logs) {
  const answer = (p) => {
    switch (p.method) {
      case 'eth_blockNumber':
        return { result: '0x6e' };
      case 'eth_getLogs': {
        const f = p.params[0];
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        return {
          result: logs.filter(
            (l) => l.address.toLowerCase() === String(f.address).toLowerCase() && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to,
          ),
        };
      }
      case 'eth_call':
        return { result: `0x${'00'.repeat(32)}` }; // paused() == false
      default:
        return { error: { code: -32601, message: `unsupported ${p.method}` } };
    }
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const one = (p) => ({ jsonrpc: '2.0', id: p.id, ...answer(p) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.closeIdleConnections?.();
        server.close(r);
        server.closeAllConnections?.();
      }),
  };
}

/** Run one pass of the real watcher. Async: the fake node lives in this process. */
function runOnce(configPath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WATCH, '--config', configPath, '--once'], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

test('an Executed from a chain dropped from the config is UNVERIFIABLE, even with its old cursor still in the state file', async () => {
  // BSC was scanned once, then removed from the config; its cursor survives in
  // watcher.state.json because the whole map is saved back every tick. Asking
  // "do I have a cursor for it" said yes, overdue() never gets a head for it,
  // and a forged release claiming BSC went out as an INFO line.
  const dropped = `0x${'0b'.repeat(32)}`;
  const configured = `0x${'0c'.repeat(32)}`;
  const node = await fakeNode([
    executedLog({ transferId: dropped, srcChainId: BSC, blockNumber: 105 }),
    executedLog({ transferId: configured, srcChainId: BASE, blockNumber: 106 }),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'fmx-watch-'));
  try {
    const configPath = join(dir, 'watcher.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        graceBlocks: 200,
        statePath: 'watcher.state.json',
        chains: [
          { name: 'ferminux', chainId: FMX, bridgeAddress: FMX_BRIDGE, rpcUrls: [node.url], confirmations: 1 },
          { name: 'base', chainId: BASE, bridgeAddress: BASE_BRIDGE, rpcUrls: [node.url], confirmations: 1 },
        ],
      }),
    );
    writeFileSync(join(dir, 'watcher.state.json'), JSON.stringify({ cursors: { [FMX]: 100, [BASE]: 100, [BSC]: 5000 } }));

    const out = await runOnce(configPath);
    const unverifiable = out.split('\n').filter((l) => l.includes('UNVERIFIABLE-EXECUTION'));
    assert.equal(unverifiable.length, 1, out);
    assert.match(unverifiable[0], /^CRITICAL \|/);
    assert.ok(unverifiable[0].includes(`transferId=${dropped}`), unverifiable[0]);
    assert.ok(unverifiable[0].includes(`source chain ${BSC}`), unverifiable[0]);
    assert.ok(!unverifiable.some((l) => l.includes(configured)), 'a configured source chain is reconciled, not flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await node.close();
  }
});
