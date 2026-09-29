// The page's transactions carry gas headroom over the node's estimate (src/lib/wallet.ts).
//
// A node estimates on its latest block. A pool that already traded in that
// block's second skips its price-accumulator writes in the estimate and makes
// them when the transaction lands later, so a bare estimate can run out of gas
// in the pair (seen on the anvil fork at "Remove 50%"). Every limit the page
// asks for is the estimate plus a quarter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserProvider } from 'ethers';

import { GAS_HEADROOM_PCT, withGasHeadroom } from '../src/lib/wallet.ts';

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ROUTER = '0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f';

function wallet(estimate) {
  const sent = [];
  const eth = {
    async request({ method, params }) {
      switch (method) {
        case 'eth_chainId':
          return '0xf79';
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [ME];
        case 'eth_estimateGas':
          return '0x' + estimate.toString(16);
        case 'eth_sendTransaction':
          sent.push(params[0]);
          return '0x' + 'ab'.repeat(32);
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { eth, sent };
}

test('gas: the page asks for the estimate plus a quarter, on every transaction it sends', async () => {
  assert.equal(GAS_HEADROOM_PCT, 25n);
  const { eth, sent } = wallet(164_037n);
  const provider = withGasHeadroom(new BrowserProvider(eth));
  assert.equal(await provider.estimateGas({ from: ME, to: ROUTER, data: '0x' }), 164_037n + 41_009n);
  const signer = await provider.getSigner();
  await signer.sendUncheckedTransaction({ to: ROUTER, data: '0xbaa2abde' });
  assert.equal(BigInt(sent[0].gas), 205_046n, 'the limit the wallet is handed');
  // A limit the caller set is left alone.
  await signer.sendUncheckedTransaction({ to: ROUTER, data: '0x', gasLimit: 50_000n });
  assert.equal(BigInt(sent[1].gas), 50_000n);
});
