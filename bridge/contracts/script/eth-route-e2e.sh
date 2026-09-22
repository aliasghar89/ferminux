#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Ethereum route: two-bridge topology proof, on LOCAL anvils only.
#
#   chain F = 3961 on :8560   (Ferminux)   — runs TWO bridges
#   chain E = 1    on :8562   (Ethereum)   — the new route
#   chain B = 56   on :8561   (BSC)        — the route that is already live
#
# WHY A SECOND BRIDGE ON FERMINUX, rather than adding Ethereum to the live one:
# FerminuxBridge binds a local token to exactly one remote chain —
# `require(dstChainId == cfg.remoteChainId)` in send(). Native FMX on the live
# Ferminux bridge is already bound to chain 56. Rebinding it would tear down the
# working BSC route and move real collateral; a second instance costs nothing
# and touches nothing that already works.
#
# WHAT THAT INTRODUCES, and what this script exists to test: two bridges on the
# SAME chain, holding the SAME asset, trusting the SAME validators. If the
# signed digest did not bind the bridge address, a 2-of-3 signature set for the
# ETH route would also execute on the BSC route and drain its collateral. The
# domain separator includes address(this), so it must not — and "must not" is
# worth proving rather than reading.
#
# NEVER point this at a public RPC: anvil dev keys and evm_increaseTime.
#
#   anvil --port 8560 --chain-id 3961 &
#   anvil --port 8561 --chain-id 56   &
#   anvil --port 8562 --chain-id 1    &
#   bash script/eth-route-e2e.sh
# ---------------------------------------------------------------------------
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HERE"

RPC_F=${RPC_F:-http://127.0.0.1:8560}
RPC_B=${RPC_B:-http://127.0.0.1:8561}
RPC_E=${RPC_E:-http://127.0.0.1:8562}
CHAIN_F=3961; CHAIN_B=56; CHAIN_E=1

DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
V1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
V1_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
V2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
V2_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
V3=0x90F79bf6EB2c4f870365E785982E1f101E93b906
PAUSER=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
USER=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
USER_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
RECIPIENT=0x976EA74026E726554dB657fA54763abd0C3a0aa9
RECIPIENT_KEY=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
ZERO=0x0000000000000000000000000000000000000000
DELAY=3600
FAILED=0

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()  { printf '   PASS  %s\n' "$*"; }
bad() { printf '   FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
# Assert a command fails. Anything that must be refused goes through this, so a
# silent success can never be mistaken for a passing test.
# Assert a command fails FOR THE RIGHT REASON. Plain "it exited non-zero" is not
# evidence: a typo in the signature, an unreachable RPC or a missing binary all
# exit non-zero and would have been reported as a passing security property.
# $2 is a regex the revert output must match.
refuses() {
  local what="$1" want="$2"; shift 2
  # `out=$(cmd)` under `set -e` aborts the script when cmd fails — which is
  # every time this helper is used as intended. The `|| rc=$?` keeps the failure
  # as data instead of ending the run.
  local out rc=0
  out=$("$@" 2>&1) || rc=$?
  if [ $rc -eq 0 ]; then bad "$what — WAS ACCEPTED"; return; fi
  if printf '%s' "$out" | grep -qiE "$want"; then
    ok "$what — refused ($(printf '%s' "$out" | grep -oiE "$want" | head -1))"
  else
    bad "$what — failed, but NOT with /$want/: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
  fi
}

deploy_bridge() { # $1 rpc -> echoes address
  BRIDGE_OWNER=$DEPLOYER FEE_COLLECTOR=$DEPLOYER BRIDGE_THRESHOLD=2 FEE_BPS=10 \
  TIMELOCK_DELAY=$DELAY BRIDGE_PAUSER=$PAUSER \
  BRIDGE_VALIDATOR1=$V1 BRIDGE_VALIDATOR2=$V2 BRIDGE_VALIDATOR3=$V3 \
    forge script script/DeployBridge.s.sol --rpc-url "$1" --broadcast >/tmp/fx-eth-d.log 2>&1
  grep -m1 'FerminuxBridge:' /tmp/fx-eth-d.log | awk '{print $NF}'
}
bump() { cast send "$DEPLOYER" --value 0 --private-key "$DEPLOYER_KEY" --rpc-url "$1" >/dev/null; }
queue() { local b=$1 r=$2; shift 2
  if ! env BRIDGE=$b OWNER_KEY=$DEPLOYER_KEY ACTION=queue "$@" \
      forge script script/RegisterToken.s.sol --rpc-url "$r" --broadcast >/tmp/fx-eth-q.log 2>&1; then
    bad "queue failed on $b: $*"; grep -m1 -iE 'revert|error|Error' /tmp/fx-eth-q.log | sed 's/^/         /'; return 1
  fi; }
exec_action() { BRIDGE=$1 OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=$3 \
    forge script script/RegisterToken.s.sol --rpc-url "$2" --broadcast >/dev/null 2>&1; }
warp() { cast rpc evm_increaseTime $((DELAY + 60)) --rpc-url "$1" >/dev/null; cast rpc evm_mine --rpc-url "$1" >/dev/null; }
sig_tuple() { local s; s=$(cast wallet sign --no-hash "$2" --private-key "$1"); echo "($((16#${s:130:2})),0x${s:2:64},0x${s:66:64})"; }

log "0. three anvils"
for r in "$RPC_F" "$RPC_B" "$RPC_E"; do printf '   %s chain-id %s\n' "$r" "$(cast chain-id --rpc-url "$r")"; done

log "1. Ferminux runs TWO bridges: one per remote chain"
BRIDGE_FB=$(deploy_bridge "$RPC_F")            # Ferminux side of the BSC route
bump "$RPC_F"
BRIDGE_FE=$(deploy_bridge "$RPC_F")            # Ferminux side of the ETH route
echo "   BSC-route bridge on Ferminux: $BRIDGE_FB"
echo "   ETH-route bridge on Ferminux: $BRIDGE_FE"
[ "$BRIDGE_FB" != "$BRIDGE_FE" ] && ok "the two instances are distinct addresses" || bad "same address"

# Each chain gets a DIFFERENT number of pre-bumps so no two bridges share an
# address. On fresh anvils the deployer nonce is identical everywhere, so the
# CREATE addresses collide — and setRemoteBridge refuses to point a bridge at
# its own address ("BRIDGE: same bridge"), which is how the first run of this
# script died at registration with no message. Real chains never collide; the
# rehearsal must not depend on that luck either.
for _ in 1 2 3 4 5; do bump "$RPC_B"; done; BRIDGE_B=$(deploy_bridge "$RPC_B")
for _ in 1 2 3 4 5 6 7 8 9; do bump "$RPC_E"; done; BRIDGE_E=$(deploy_bridge "$RPC_E")
echo "   BSC bridge:      $BRIDGE_B"
echo "   Ethereum bridge: $BRIDGE_E"
DUPES=$(printf '%s\n' "$BRIDGE_FB" "$BRIDGE_FE" "$BRIDGE_B" "$BRIDGE_E" | sort | uniq -d)
[ -z "$DUPES" ] && ok "all four bridge addresses are distinct" || bad "address collision: $DUPES"

log "2. wFMX on BSC and on Ethereum"
mk_wfmx() { BRIDGE=$1 ORIGIN_CHAIN_ID=$CHAIN_F ORIGIN_TOKEN=$ZERO \
  WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX WRAPPED_DECIMALS=18 \
  forge script script/DeployWrappedToken.s.sol --rpc-url "$2" --broadcast >/tmp/fx-eth-w.log 2>&1
  grep -m1 'BridgeToken:' /tmp/fx-eth-w.log | awk '{print $NF}'; }
WFMX_B=$(mk_wfmx "$BRIDGE_B" "$RPC_B")
WFMX_E=$(mk_wfmx "$BRIDGE_E" "$RPC_E")
echo "   wFMX on BSC:      $WFMX_B"
echo "   wFMX on Ethereum: $WFMX_E"

log "3. queue every registration (both routes, both directions)"
queue "$BRIDGE_B" "$RPC_B" TOKEN_KIND=pin
queue "$BRIDGE_E" "$RPC_E" TOKEN_KIND=pin
queue "$BRIDGE_FB" "$RPC_F" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_B REMOTE_BRIDGE=$BRIDGE_B
queue "$BRIDGE_FE" "$RPC_F" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_E REMOTE_BRIDGE=$BRIDGE_E
queue "$BRIDGE_B"  "$RPC_B" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_F REMOTE_BRIDGE=$BRIDGE_FB
queue "$BRIDGE_E"  "$RPC_E" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_F REMOTE_BRIDGE=$BRIDGE_FE
queue "$BRIDGE_FB" "$RPC_F" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN=$WFMX_B \
      MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000
queue "$BRIDGE_FE" "$RPC_F" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_E REMOTE_TOKEN=$WFMX_E \
      MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000
queue "$BRIDGE_B" "$RPC_B" TOKEN_KIND=wrapped LOCAL_TOKEN=$WFMX_B REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000
queue "$BRIDGE_E" "$RPC_E" TOKEN_KIND=wrapped LOCAL_TOKEN=$WFMX_E REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000
echo "   queued"

log "4. wait out the timelock and execute"
for r in "$RPC_F" "$RPC_B" "$RPC_E"; do warp "$r"; done
exec_action "$BRIDGE_FB" "$RPC_F" 0; exec_action "$BRIDGE_FB" "$RPC_F" 1
exec_action "$BRIDGE_FE" "$RPC_F" 0; exec_action "$BRIDGE_FE" "$RPC_F" 1
exec_action "$BRIDGE_B" "$RPC_B" 0; exec_action "$BRIDGE_B" "$RPC_B" 1; exec_action "$BRIDGE_B" "$RPC_B" 2
exec_action "$BRIDGE_E" "$RPC_E" 0; exec_action "$BRIDGE_E" "$RPC_E" 1; exec_action "$BRIDGE_E" "$RPC_E" 2
echo "   ETH-route bridge knows Ethereum as: $(cast call "$BRIDGE_FE" 'remoteBridge(uint64)(address)' $CHAIN_E --rpc-url "$RPC_F")"
echo "   BSC-route bridge knows BSC as:      $(cast call "$BRIDGE_FB" 'remoteBridge(uint64)(address)' $CHAIN_B --rpc-url "$RPC_F")"

log "5. the routes are isolated by construction"
Z=$(cast call "$BRIDGE_FE" 'remoteBridge(uint64)(address)' $CHAIN_B --rpc-url "$RPC_F")
[ "$Z" = "$ZERO" ] && ok "the ETH-route bridge does not know chain 56 at all" || bad "ETH bridge knows BSC: $Z"
refuses "sending to chain 56 through the ETH-route bridge" "bad dst chain" \
  cast send "$BRIDGE_FE" 'send(address,uint256,uint64,address)' $ZERO 1000000000000000000 $CHAIN_B "$RECIPIENT" \
    --value 1000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_F"

log "6. fund BOTH routes so a drain would be visible"
cast send "$BRIDGE_FB" 'send(address,uint256,uint64,address)' $ZERO 40000000000000000000 $CHAIN_B "$RECIPIENT" \
  --value 40000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_F" >/dev/null
cast send "$BRIDGE_FE" 'send(address,uint256,uint64,address)' $ZERO 10000000000000000000 $CHAIN_E "$RECIPIENT" \
  --value 10000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_F" >/dev/null
LOCKED_FB=$(cast call "$BRIDGE_FB" 'lockedBalance(address)(uint256)' $ZERO --rpc-url "$RPC_F" | awk '{print $1}')
LOCKED_FE=$(cast call "$BRIDGE_FE" 'lockedBalance(address)(uint256)' $ZERO --rpc-url "$RPC_F" | awk '{print $1}')
NONCE_FE=$(cast call "$BRIDGE_FE" 'outboundNonce()(uint64)' --rpc-url "$RPC_F" | awk '{print $1}')
NONCE_FB=$(cast call "$BRIDGE_FB" 'outboundNonce()(uint64)' --rpc-url "$RPC_F" | awk '{print $1}')
echo "   BSC route locked: $LOCKED_FB (nonce $NONCE_FB)"
echo "   ETH route locked: $LOCKED_FE (nonce $NONCE_FE)"
[ "$NONCE_FB" = "1" ] && [ "$NONCE_FE" = "1" ] && ok "each instance keeps its own nonce space" || bad "nonces bled across instances"

log "7. Ferminux -> Ethereum: mint wFMX on chain 1"
T="($CHAIN_F,$CHAIN_E,$NONCE_FE,$ZERO,$WFMX_E,$USER,$RECIPIENT,$LOCKED_FE)"
DIG_E=$(cast call "$BRIDGE_E" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$T" --rpc-url "$RPC_E")
S1=$(sig_tuple "$V1_KEY" "$DIG_E"); S2=$(sig_tuple "$V2_KEY" "$DIG_E")
cast send "$BRIDGE_E" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T" "[$S1,$S2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_E" >/dev/null
SUP_E=$(cast call "$WFMX_E" 'totalSupply()(uint256)' --rpc-url "$RPC_E" | awk '{print $1}')
echo "   wFMX supply on Ethereum: $SUP_E"
[ "$SUP_E" = "$LOCKED_FE" ] && ok "Ethereum supply exactly equals Ferminux collateral" || bad "supply $SUP_E != locked $LOCKED_FE"

log "8. THE ATTACK: an inbound ETH-route transfer, replayed against the BSC-route bridge"
# Burn on Ethereum so there is a genuine inbound transfer to sign for.
cast send "$BRIDGE_E" 'send(address,uint256,uint64,address)' "$WFMX_E" "$SUP_E" $CHAIN_F "$USER" \
  --private-key "$RECIPIENT_KEY" --rpc-url "$RPC_E" >/dev/null
NONCE_E=$(cast call "$BRIDGE_E" 'outboundNonce()(uint64)' --rpc-url "$RPC_E" | awk '{print $1}')
NET=$(python3 -c "b=$SUP_E; print(b - b*10//10000)")
TIN="($CHAIN_E,$CHAIN_F,$NONCE_E,$WFMX_E,$ZERO,$RECIPIENT,$USER,$NET)"
# Validators sign it for the ETH-route bridge, which is the only correct target.
DIG_FE=$(cast call "$BRIDGE_FE" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$TIN" --rpc-url "$RPC_F")
A1=$(sig_tuple "$V1_KEY" "$DIG_FE"); A2=$(sig_tuple "$V2_KEY" "$DIG_FE")
DIG_FB=$(cast call "$BRIDGE_FB" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$TIN" --rpc-url "$RPC_F")
echo "   digest at the ETH-route bridge: $DIG_FE"
echo "   digest at the BSC-route bridge: $DIG_FB"
[ "$DIG_FE" != "$DIG_FB" ] && ok "the same transfer hashes differently per instance (domain binds address(this))" \
                           || bad "IDENTICAL DIGESTS — one instance's signatures would execute on the other"
BEFORE_FB=$(cast call "$BRIDGE_FB" 'lockedBalance(address)(uint256)' $ZERO --rpc-url "$RPC_F" | awk '{print $1}')

# Replaying THIS transfer at the BSC-route bridge proves little: it declares
# srcChainId=1, which that bridge has never heard of, so it is rejected on route
# configuration long before any signature is checked. That is a real property,
# but it is NOT the domain-separator isolation this script claims to prove.
refuses "an ETH-route transfer replayed on the BSC-route bridge (rejected on ROUTE, not signature)" \
  "unknown remote|bad src|remote bridge|not registered|BRIDGE:" \
  cast send "$BRIDGE_FB" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
    "$TIN" "[$A1,$A2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_F"

# The real test: a transfer the BSC-route bridge WOULD accept — correct source
# chain, correct tokens, correct route — signed over the OTHER bridge's domain.
# Now the signature is the only thing that can reject it, so a refusal here is
# the domain separator doing its job and nothing else.
log "   differential test: same transfer, only the signing domain differs"
TSAME="($CHAIN_B,$CHAIN_F,999,$WFMX_B,$ZERO,$RECIPIENT,$USER,1000000000000000000)"
D_WRONG=$(cast call "$BRIDGE_FE" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$TSAME" --rpc-url "$RPC_F")
D_RIGHT=$(cast call "$BRIDGE_FB" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$TSAME" --rpc-url "$RPC_F")
[ "$D_WRONG" != "$D_RIGHT" ] && ok "one transfer, two digests: $(printf %s "$D_WRONG" | cut -c1-14)… vs $(printf %s "$D_RIGHT" | cut -c1-14)…" || bad "digests identical"
W1=$(sig_tuple "$V1_KEY" "$D_WRONG"); W2=$(sig_tuple "$V2_KEY" "$D_WRONG")
refuses "valid validator signatures over the WRONG bridge's domain" "signature|signer|not a validator|threshold|BRIDGE:" \
  cast send "$BRIDGE_FB" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
    "$TSAME" "[$W1,$W2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_F"
# ...and the identical transfer signed over the RIGHT domain must go through,
# which is what makes the refusal above attributable to the domain and nothing else.
R1=$(sig_tuple "$V1_KEY" "$D_RIGHT"); R2=$(sig_tuple "$V2_KEY" "$D_RIGHT")
if cast send "$BRIDGE_FB" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
     "$TSAME" "[$R1,$R2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_F" >/dev/null 2>&1; then
  ok "the same transfer signed for THIS bridge is accepted — the domain was the only difference"
else
  bad "the correctly-signed transfer was also rejected — the test proves nothing about domains"
fi

AFTER_FB=$(cast call "$BRIDGE_FB" 'lockedBalance(address)(uint256)' $ZERO --rpc-url "$RPC_F" | awk '{print $1}')
python3 - "$BEFORE_FB" "$AFTER_FB" <<'EOF' || bad "BSC-route collateral moved by more than the one legitimate release"
import sys
b, a = int(sys.argv[1]), int(sys.argv[2])
# exactly one legitimate 1 FMX release above; nothing else may have moved
print(f"   BSC-route collateral {b/1e18:.6f} -> {a/1e18:.6f} FMX (one legitimate 1 FMX release)")
sys.exit(0 if b - a == 10**18 else 1)
EOF

log "9. the legitimate target accepts the very same transfer"
BEFORE_U=$(cast balance "$USER" --rpc-url "$RPC_F")
cast send "$BRIDGE_FE" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$TIN" "[$A1,$A2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_F" >/dev/null
AFTER_U=$(cast balance "$USER" --rpc-url "$RPC_F")
GOT=$(python3 -c "print($AFTER_U - $BEFORE_U)")
echo "   user received $GOT wei (expected $NET)"
[ "$GOT" = "$NET" ] && ok "round trip Ferminux -> Ethereum -> Ferminux complete" || bad "received $GOT, expected $NET"
echo "   wFMX supply on Ethereum now: $(cast call "$WFMX_E" 'totalSupply()(uint256)' --rpc-url "$RPC_E")"
echo "   ETH-route collateral now:    $(cast call "$BRIDGE_FE" 'lockedBalance(address)(uint256)' $ZERO --rpc-url "$RPC_F")"
echo "   BSC-route collateral now:    $(cast call "$BRIDGE_FB" 'lockedBalance(address)(uint256)' $ZERO --rpc-url "$RPC_F")  <- unchanged throughout"

log "10. pausing one route must not pause the other"
cast send "$BRIDGE_FE" 'pause()' --private-key 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a --rpc-url "$RPC_F" >/dev/null
PE=$(cast call "$BRIDGE_FE" 'paused()(bool)' --rpc-url "$RPC_F"); PB=$(cast call "$BRIDGE_FB" 'paused()(bool)' --rpc-url "$RPC_F")
echo "   ETH route paused=$PE   BSC route paused=$PB"
[ "$PE" = "true" ] && [ "$PB" = "false" ] && ok "routes pause independently" || bad "pause leaked across instances"
cast send "$BRIDGE_FE" 'unpause()' --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_F" >/dev/null

printf '\n\033[1m== RESULT: %s\033[0m\n' "$([ $FAILED -eq 0 ] && echo 'PASS — the Ethereum route works and cannot touch the BSC route' || echo "FAIL ($FAILED)")"
echo "   Ferminux/BSC $BRIDGE_FB   Ferminux/ETH $BRIDGE_FE   Ethereum $BRIDGE_E   wFMX(E) $WFMX_E"
[ $FAILED -eq 0 ]
