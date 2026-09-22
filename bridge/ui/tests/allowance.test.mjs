// Which assets the UI must approve before sending.
//
// This exists because the UI once exempted WRAPPED assets on the reasoning that
// "a burn is not a pull". After BridgeToken.burn() started debiting the holder's
// allowance, that exemption sent every bridge-back — the wFMX -> FMX return leg,
// the only way wrapped supply is ever redeemed — into a revert the user could do
// nothing about. Nothing in 103 tests noticed, because the rule lived inline in
// a component. It lives in a function now, and this is that function's test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requiresAllowance, TokenKind } from '../src/lib/bridge.ts';

const NATIVE = '0x0000000000000000000000000000000000000000';
const WFMX = '0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0';
const USDX = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

function entry({ kind, isNative, address }) {
  return {
    localToken: address,
    kind,
    paused: false,
    remoteChainId: 56,
    remoteToken: USDX,
    maxPerTransfer: 0n,
    dailyCap: 0n,
    meta: { address, name: 'Asset', symbol: 'AST', decimals: 18, isNative },
  };
}

test('allowance: a wrapped asset needs one, because burn() debits it', () => {
  const wrapped = entry({ kind: TokenKind.WRAPPED, isNative: false, address: WFMX });
  assert.equal(requiresAllowance(wrapped), true);
});

test('allowance: a canonical ERC-20 needs one, because transferFrom pulls it', () => {
  const canonical = entry({ kind: TokenKind.CANONICAL, isNative: false, address: USDX });
  assert.equal(requiresAllowance(canonical), true);
});

test('allowance: the native coin needs none — it arrives as msg.value', () => {
  const native = entry({ kind: TokenKind.CANONICAL, isNative: true, address: NATIVE });
  assert.equal(requiresAllowance(native), false);
});

test('allowance: the kind does not decide it — only nativeness does', () => {
  // The regression in one line: had this been asserted, exempting WRAPPED would
  // have failed here rather than at a user's wallet.
  for (const kind of [TokenKind.CANONICAL, TokenKind.WRAPPED]) {
    assert.equal(requiresAllowance(entry({ kind, isNative: false, address: WFMX })), true);
    assert.equal(requiresAllowance(entry({ kind, isNative: true, address: NATIVE })), false);
  }
});
