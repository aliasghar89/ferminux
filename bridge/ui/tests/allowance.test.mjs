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

import { LEGACY_WRAPPER_CODEHASH, requiresAllowance, TokenKind } from '../src/lib/bridge.ts';

const NATIVE = '0x0000000000000000000000000000000000000000';
const WFMX = '0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0';
const USDX = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

function entry({ kind, isNative, address, codehash = null }) {
  return {
    localToken: address,
    kind,
    paused: false,
    remoteChainId: 56,
    remoteToken: USDX,
    maxPerTransfer: 0n,
    dailyCap: 0n,
    meta: { address, name: 'Asset', symbol: 'AST', decimals: 18, isNative, codehash },
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

test('allowance: the LIVE legacy wFMX (burn ignores allowance) needs none — recognised by exact codehash only', () => {
  // BridgeTokenLegacy.burn() never reads allowance: an approve() there was an
  // extra transaction and a standing allowance nothing would ever consume.
  const legacy = entry({ kind: TokenKind.WRAPPED, isNative: false, address: WFMX, codehash: LEGACY_WRAPPER_CODEHASH });
  assert.equal(requiresAllowance(legacy), false);
  assert.equal(requiresAllowance(entry({ kind: TokenKind.WRAPPED, isNative: false, address: WFMX, codehash: LEGACY_WRAPPER_CODEHASH.toUpperCase().replace('0X', '0x') })), false);
  // Unknown, unreadable or new-wrapper code keeps the approval: skipping it on
  // src/BridgeToken.sol would revert every return leg.
  assert.equal(requiresAllowance(entry({ kind: TokenKind.WRAPPED, isNative: false, address: WFMX, codehash: null })), true);
  assert.equal(requiresAllowance(entry({ kind: TokenKind.WRAPPED, isNative: false, address: WFMX, codehash: `0x${'ab'.repeat(32)}` })), true);
  // The exemption is for the WRAPPED burn path only.
  assert.equal(requiresAllowance(entry({ kind: TokenKind.CANONICAL, isNative: false, address: WFMX, codehash: LEGACY_WRAPPER_CODEHASH })), true);
});
