#!/usr/bin/env bash
#
# verify.sh — read-only checklist for the standard shared contracts.
#
#   RPC_URL=https://rpc.ferminux.net ./verify.sh
#
# For every contract in manifest.json it checks, with eth_getCode and eth_call
# only (nothing is sent):
#   1. code is present and its keccak matches the canonical runtime code hash
#      (the code on Ethereum mainnet and BNB Chain; for Permit2, that code with the two
#      per-chain immutables, chain id and EIP-712 domain separator, set for
#      this chain);
#   2. the code on chain has no opcode the London rule set lacks (opscan.py);
#   3. a behaviour read: the CREATE2 deployer predicts the right address,
#      Multicall3 reports this chain id, Permit2's domain separator is this
#      chain's, both Safe singletons are version 1.3.0 and locked (threshold
#      1), the fallback handler answers ERC-165, and each EntryPoint's
#      SenderCreator exists with its canonical code.
# Prints PASS/FAIL per check; exit status 1 if any check fails.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST="$HERE/manifest.json"
RPC_URL=${RPC_URL:-https://rpc.ferminux.net}
EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-3961}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FAILS=0; PASSES=0

mf()    { jq -r "$1" "$MANIFEST"; }
lower() { tr 'A-F' 'a-f' <<<"$1"; }
pass()  { PASSES=$((PASSES + 1)); printf 'PASS  %-42s %s\n' "$1" "$2"; }
fail()  { FAILS=$((FAILS + 1)); printf 'FAIL  %-42s %s\n' "$1" "$2"; }
check() {  # name description actual expected
  if [ "$(lower "$3")" = "$(lower "$4")" ]; then pass "$1" "$2"; else fail "$1" "$2: got $3, want $4"; fi
}
call()  { cast call "$@" --rpc-url "$RPC_URL" 2>/dev/null || echo "call-reverted"; }

CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
check chain "chain id" "$CHAIN_ID" "$EXPECTED_CHAIN_ID"
echo "rpc $RPC_URL  block $(cast block-number --rpc-url "$RPC_URL")"

code_checks() {  # name address expected-codehash
  local code; code=$(cast code "$2" --rpc-url "$RPC_URL")
  if [ "$code" = "0x" ]; then fail "$1" "no code at $2"; return 1; fi
  check "$1" "runtime code hash at $2" "$(cast keccak "$code")" "$3"
  local f="$TMP/${1//\//-}.hex"
  echo "$code" >"$f"
  if scan=$(python3 "$HERE/opscan.py" "$f" 2>&1); then
    pass "$1" "London-safe opcodes, solc ${scan##* solc=}"
  else
    fail "$1" "opcode scan: $scan"
  fi
}

for i in $(seq 0 $(($(mf '.keyless | length') - 1))); do
  code_checks "$(mf ".keyless[$i].name")" "$(mf ".keyless[$i].address")" "$(mf ".keyless[$i].runtimeCodehash")" || true
done
for i in $(seq 0 $(($(mf '.create2 | length') - 1))); do
  name=$(mf ".create2[$i].name")
  code_checks "$name" "$(mf ".create2[$i].address")" "$(mf ".create2[$i].runtimeCodehash")" || true
  sc=$(mf ".create2[$i].senderCreator.address // empty")
  if [ -n "$sc" ]; then
    code_checks "$name/SenderCreator" "$sc" "$(mf ".create2[$i].senderCreator.runtimeCodehash")" || true
  fi
done

# behaviour reads
C2=0x4e59b44847b379578588920cA78FbF26c0B4956C
SALT=0x0000000000000000000000000000000000000000000000000000000000000001
INIT=0x69602a60005260206000f3600052600a6016f3
want=$(cast create2 --deployer "$C2" --salt "$SALT" --init-code "$INIT")
got=$(call "$C2" "$SALT${INIT#0x}")
check create2-deployer "eth_call deploy predicts the CREATE2 address" "0x${got: -40}" "$want"

check multicall3 "getChainId()" "$(call 0xcA11bde05977b3631167028862bE2a173976CA11 'getChainId()(uint256)')" "$CHAIN_ID"

P2=0x000000000022D473030F116dDEE9F6B43aC78BA3
DOMAIN=$(cast keccak "$(cast abi-encode 'f(bytes32,bytes32,uint256,address)' \
  "$(cast keccak 'EIP712Domain(string name,uint256 chainId,address verifyingContract)')" \
  "$(cast keccak Permit2)" "$CHAIN_ID" "$P2")")
check permit2 "DOMAIN_SEPARATOR() is this chain's" "$(call "$P2" 'DOMAIN_SEPARATOR()(bytes32)')" "$DOMAIN"

for s in safe-1.3.0:0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552 safe-l2-1.3.0:0x3E5c63644E683549055b9Be8653de26E0B4CD36E; do
  check "${s%%:*}" "VERSION()" "$(call "${s#*:}" 'VERSION()(string)')" '"1.3.0"'
  check "${s%%:*}" "singleton locked (threshold 1)" "$(call "${s#*:}" 'getThreshold()(uint256)')" 1
done
check safe-compatibility-fallback-handler-1.3.0 "supportsInterface(ERC-165)" \
  "$(call 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4 'supportsInterface(bytes4)(bool)' 0x01ffc9a7)" true
check safe-proxy-factory-1.3.0 "proxyRuntimeCode() hash" \
  "$(cast keccak "$(call 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2 'proxyRuntimeCode()(bytes)')")" \
  0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000
for ep in entrypoint-0.6:0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 entrypoint-0.7:0x0000000071727De22E5E9d8BAf0edAc6f37da032; do
  check "${ep%%:*}" "getNonce(0x…01, 0)" "$(call "${ep#*:}" 'getNonce(address,uint192)(uint256)' 0x0000000000000000000000000000000000000001 0)" 0
done

echo ""
echo "$PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ]
