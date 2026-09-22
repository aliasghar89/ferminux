#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Two-chain end-to-end proof on LOCAL anvils only.
#
#   chain A = 3961 on :8560   (stands in for Ferminux)
#   chain B = 56   on :8561   (stands in for a remote EVM)
#
# Deploys a bridge on each side, wraps chain A's native coin on chain B,
# registers both sides through the timelock, then moves value A -> B -> A with
# real EIP-712 validator signatures produced by `cast wallet sign --no-hash`.
#
# NEVER point this at a public RPC. It uses anvil's well-known dev keys and
# anvil-only cheat RPCs (evm_increaseTime).
#
# Usage:  bash script/devnet-e2e.sh
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# Ports are overridable so a second operator can run this without colliding
# with an anvil that is already up: RPC_A=http://127.0.0.1:8590 bash script/devnet-e2e.sh
RPC_A=${RPC_A:-http://127.0.0.1:8560}
RPC_B=${RPC_B:-http://127.0.0.1:8561}
CHAIN_A=3961
CHAIN_B=56

# anvil deterministic dev accounts
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
V1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
V1_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
V2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
V2_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
V3=0x90F79bf6EB2c4f870365E785982E1f101E93b906
PAUSER=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
USER=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc          # anvil #5
USER_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
RECIPIENT=0x976EA74026E726554dB657fA54763abd0C3a0aa9      # anvil #6

DELAY=3600   # 1h (the contract minimum) so the devnet run is quick

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

log "0. anvil health"
cast chain-id --rpc-url "$RPC_A"
cast chain-id --rpc-url "$RPC_B"

log "1. deploy bridge on chain A ($CHAIN_A)"
BRIDGE_OWNER=$DEPLOYER FEE_COLLECTOR=$DEPLOYER BRIDGE_THRESHOLD=2 FEE_BPS=10 \
TIMELOCK_DELAY=$DELAY BRIDGE_PAUSER=$PAUSER \
BRIDGE_VALIDATOR1=$V1 BRIDGE_VALIDATOR2=$V2 BRIDGE_VALIDATOR3=$V3 \
  forge script script/DeployBridge.s.sol --rpc-url "$RPC_A" --broadcast >/tmp/fx-bridge-a.log 2>&1
BRIDGE_A=$(grep -m1 'FerminuxBridge:' /tmp/fx-bridge-a.log | awk '{print $NF}')
echo "bridge A = $BRIDGE_A"

log "2. deploy bridge on chain B ($CHAIN_B)"
# Bump chain B's deployer nonce first, so the two bridges do NOT land on the same
# address. On two fresh anvils they otherwise would, purely because the nonces
# happen to match - a coincidence nothing in this design leans on, and one that
# would make setRemoteBridge refuse with "BRIDGE: same bridge". Real deployments
# on real chains are not address-identical either; the devnet should not pretend.
cast send "$DEPLOYER" --value 0 --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null
BRIDGE_OWNER=$DEPLOYER FEE_COLLECTOR=$DEPLOYER BRIDGE_THRESHOLD=2 FEE_BPS=10 \
TIMELOCK_DELAY=$DELAY BRIDGE_PAUSER=$PAUSER \
BRIDGE_VALIDATOR1=$V1 BRIDGE_VALIDATOR2=$V2 BRIDGE_VALIDATOR3=$V3 \
  forge script script/DeployBridge.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-bridge-b.log 2>&1
BRIDGE_B=$(grep -m1 'FerminuxBridge:' /tmp/fx-bridge-b.log | awk '{print $NF}')
echo "bridge B = $BRIDGE_B"

log "3. deploy wFMX (wrapper for chain A's native coin) on chain B"
BRIDGE=$BRIDGE_B ORIGIN_CHAIN_ID=$CHAIN_A ORIGIN_TOKEN=0x0000000000000000000000000000000000000000 \
WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX WRAPPED_DECIMALS=18 \
  forge script script/DeployWrappedToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-wfmx.log 2>&1
WFMX=$(grep -m1 'BridgeToken:' /tmp/fx-wfmx.log | awk '{print $NF}')
echo "wFMX = $WFMX"

log "4. queue the wrapper bytecode pin on chain B"
# registerWrapped fails closed until the bridge knows which runtime code a
# wrapper must have. One pin covers every BridgeToken on the chain.
BRIDGE=$BRIDGE_B OWNER_KEY=$DEPLOYER_KEY ACTION=queue TOKEN_KIND=pin \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-pin-b.log 2>&1
grep -m1 'queued action id:' /tmp/fx-pin-b.log

log "5. queue each side's view of the OTHER side's bridge address"
# Mandatory: no route may be registered for a chain whose counterpart bridge is
# unknown, because send() refuses that address as a recipient. Note the two
# addresses are NOT assumed to be equal - each side is told the other's.
BRIDGE=$BRIDGE_A OWNER_KEY=$DEPLOYER_KEY ACTION=queue TOKEN_KIND=remotebridge \
REMOTE_CHAIN_ID=$CHAIN_B REMOTE_BRIDGE=$BRIDGE_B \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_A" --broadcast >/tmp/fx-rb-a.log 2>&1
grep -m1 'queued action id:' /tmp/fx-rb-a.log

BRIDGE=$BRIDGE_B OWNER_KEY=$DEPLOYER_KEY ACTION=queue TOKEN_KIND=remotebridge \
REMOTE_CHAIN_ID=$CHAIN_A REMOTE_BRIDGE=$BRIDGE_A \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-rb-b.log 2>&1
grep -m1 'queued action id:' /tmp/fx-rb-b.log

log "6. queue both registrations"
BRIDGE=$BRIDGE_A OWNER_KEY=$DEPLOYER_KEY ACTION=queue TOKEN_KIND=canonical \
LOCAL_TOKEN=0x0000000000000000000000000000000000000000 REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN=$WFMX \
MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_A" --broadcast >/tmp/fx-reg-a.log 2>&1
grep -m1 'queued action id:' /tmp/fx-reg-a.log

BRIDGE=$BRIDGE_B OWNER_KEY=$DEPLOYER_KEY ACTION=queue TOKEN_KIND=wrapped \
LOCAL_TOKEN=$WFMX REMOTE_CHAIN_ID=$CHAIN_A REMOTE_TOKEN=0x0000000000000000000000000000000000000000 \
MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-reg-b.log 2>&1
grep -m1 'queued action id:' /tmp/fx-reg-b.log

log "7. registration is timelocked - executing early must fail"
set +e
BRIDGE=$BRIDGE_A OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=1 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_A" --broadcast >/tmp/fx-early.log 2>&1
echo "early execute exit code: $? (non-zero = correctly refused)"
set -e

log "8. wait out the timelock, then execute (pin and remote bridge first)"
for RPC in "$RPC_A" "$RPC_B"; do
  cast rpc evm_increaseTime $((DELAY + 60)) --rpc-url "$RPC" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
done
# chain A: 0 = setRemoteBridge, 1 = registerCanonical
BRIDGE=$BRIDGE_A OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=0 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_A" --broadcast >/tmp/fx-exec-rb-a.log 2>&1
BRIDGE=$BRIDGE_A OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=1 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_A" --broadcast >/tmp/fx-exec-a.log 2>&1
# chain B: 0 = pin, 1 = setRemoteBridge, 2 = registerWrapped
BRIDGE=$BRIDGE_B OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=0 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-exec-pin-b.log 2>&1
BRIDGE=$BRIDGE_B OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=1 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-exec-rb-b.log 2>&1
BRIDGE=$BRIDGE_B OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=2 \
  forge script script/RegisterToken.s.sol --rpc-url "$RPC_B" --broadcast >/tmp/fx-exec-b.log 2>&1
echo "chain B wrapper pin:   $(cast call "$BRIDGE_B" 'bridgeTokenCodehash()(bytes32)' --rpc-url "$RPC_B")"
echo "chain A knows B as:    $(cast call "$BRIDGE_A" 'remoteBridge(uint64)(address)' $CHAIN_B --rpc-url "$RPC_A")"
echo "chain B knows A as:    $(cast call "$BRIDGE_B" 'remoteBridge(uint64)(address)' $CHAIN_A --rpc-url "$RPC_B")"
echo "chain A native config: $(cast call "$BRIDGE_A" 'tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))' 0x0000000000000000000000000000000000000000 --rpc-url "$RPC_A")"
echo "chain B wFMX config:   $(cast call "$BRIDGE_B" 'tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))' "$WFMX" --rpc-url "$RPC_B")"

log "8b. a send naming the DESTINATION bridge as recipient must be refused at origin"
set +e
cast send "$BRIDGE_A" 'send(address,uint256,uint64,address)' \
  0x0000000000000000000000000000000000000000 1000000000000000000 $CHAIN_B "$BRIDGE_B" \
  --value 1000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_A" >/dev/null 2>&1
echo "send-to-remote-bridge exit code: $? (non-zero = correctly refused at ORIGIN)"
set -e

log "9. user locks 10 FMX on chain A"
cast send "$BRIDGE_A" 'send(address,uint256,uint64,address)' \
  0x0000000000000000000000000000000000000000 10000000000000000000 $CHAIN_B "$RECIPIENT" \
  --value 10000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_A" >/dev/null
LOCKED=$(cast call "$BRIDGE_A" 'lockedBalance(address)(uint256)' 0x0000000000000000000000000000000000000000 --rpc-url "$RPC_A" | awk '{print $1}')
FEES=$(cast call "$BRIDGE_A" 'accruedFees(address)(uint256)' 0x0000000000000000000000000000000000000000 --rpc-url "$RPC_A" | awk '{print $1}')
NONCE=$(cast call "$BRIDGE_A" 'outboundNonce()(uint64)' --rpc-url "$RPC_A" | awk '{print $1}')
echo "locked=$LOCKED fee=$FEES nonce=$NONCE"

log "10. validators sign the transfer for chain B and anyone relays it"
T="($CHAIN_A,$CHAIN_B,$NONCE,0x0000000000000000000000000000000000000000,$WFMX,$USER,$RECIPIENT,$LOCKED)"
DIGEST=$(cast call "$BRIDGE_B" \
  'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$T" --rpc-url "$RPC_B")
echo "eip712 digest = $DIGEST"

sig_tuple() { # $1 = private key
  local s; s=$(cast wallet sign --no-hash "$DIGEST" --private-key "$1")
  echo "($((16#${s:130:2})),0x${s:2:64},0x${s:66:64})"
}
S1=$(sig_tuple "$V1_KEY"); S2=$(sig_tuple "$V2_KEY")

echo "-- a single signature must be refused (threshold is 2)"
set +e
cast send "$BRIDGE_B" \
  'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T" "[$S1]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null 2>&1
echo "   exit code: $? (non-zero = correctly refused)"
echo "-- the same validator twice must be refused"
cast send "$BRIDGE_B" \
  'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T" "[$S1,$S1]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null 2>&1
echo "   exit code: $? (non-zero = correctly refused)"
set -e

echo "-- two distinct validators: accepted"
cast send "$BRIDGE_B" \
  'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T" "[$S1,$S2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null
echo "wFMX balance of recipient: $(cast call "$WFMX" 'balanceOf(address)(uint256)' "$RECIPIENT" --rpc-url "$RPC_B")"
echo "wFMX total supply:         $(cast call "$WFMX" 'totalSupply()(uint256)' --rpc-url "$RPC_B")"
echo "locked on chain A:         $LOCKED   <- must equal the supply above"

log "11. replay of the same transfer must fail"
set +e
cast send "$BRIDGE_B" \
  'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T" "[$S1,$S2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null 2>&1
echo "exit code: $? (non-zero = correctly refused)"
set -e

log "12. send it all back: burn on B, release on A"
BAL=$(cast call "$WFMX" 'balanceOf(address)(uint256)' "$RECIPIENT" --rpc-url "$RPC_B" | awk '{print $1}')
RECIPIENT_KEY=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
cast send "$BRIDGE_B" 'send(address,uint256,uint64,address)' "$WFMX" "$BAL" $CHAIN_A "$USER" \
  --private-key "$RECIPIENT_KEY" --rpc-url "$RPC_B" >/dev/null
NONCE_B=$(cast call "$BRIDGE_B" 'outboundNonce()(uint64)' --rpc-url "$RPC_B" | awk '{print $1}')
NET_BACK=$(python3 -c "b=$BAL; print(b - b*10//10000)")   # bash ints overflow at 1e18 scale
T2="($CHAIN_B,$CHAIN_A,$NONCE_B,$WFMX,0x0000000000000000000000000000000000000000,$RECIPIENT,$USER,$NET_BACK)"
DIGEST=$(cast call "$BRIDGE_A" \
  'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$T2" --rpc-url "$RPC_A")
S1=$(sig_tuple "$V1_KEY"); S2=$(sig_tuple "$V2_KEY")
BEFORE=$(cast balance "$USER" --rpc-url "$RPC_A")
cast send "$BRIDGE_A" \
  'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T2" "[$S1,$S2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_A" >/dev/null
AFTER=$(cast balance "$USER" --rpc-url "$RPC_A")
echo "user received back: $(python3 -c "print($AFTER - $BEFORE)") wei (expected $NET_BACK)"
echo "wFMX supply now:    $(cast call "$WFMX" 'totalSupply()(uint256)' --rpc-url "$RPC_B")  <- the fee taken on B"
echo "locked on A now:    $(cast call "$BRIDGE_A" 'lockedBalance(address)(uint256)' 0x0000000000000000000000000000000000000000 --rpc-url "$RPC_A")  <- still exactly backs it"

log "13. rescue of a REGISTERED asset is timelocked, and still cannot touch collateral"
set +e
# Instant rescue is refused outright for a routed asset: its surplus is a derived
# figure, so the exit that could act on an accounting defect goes behind the same
# 48h announcement as everything else that enlarges the blast radius.
cast send "$BRIDGE_A" 'rescue(address,address,uint256)' \
  0x0000000000000000000000000000000000000000 "$DEPLOYER" 1 \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_A" >/dev/null 2>&1
echo "instant rescue of the native (registered) asset exit code: $? (non-zero = correctly refused)"
# ...and queued, matured and executed, it is still capped at surplusOf(), which is
# zero here because every wei the bridge holds is collateral or fees.
QID=$(cast call "$BRIDGE_A" 'actionCount()(uint256)' --rpc-url "$RPC_A" | awk '{print $1}')
cast send "$BRIDGE_A" 'queue(bytes)' \
  "$(cast calldata 'rescue(address,address,uint256)' 0x0000000000000000000000000000000000000000 "$DEPLOYER" 1)" \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_A" >/dev/null 2>&1
cast rpc evm_increaseTime 3700 --rpc-url "$RPC_A" >/dev/null && cast rpc evm_mine --rpc-url "$RPC_A" >/dev/null
cast send "$BRIDGE_A" 'executeAction(uint256)' "$QID" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_A" >/dev/null 2>&1
echo "timelocked rescue of collateral       exit code: $? (non-zero = still refused, surplus is 0)"
echo "locked on A unchanged: $(cast call "$BRIDGE_A" 'lockedBalance(address)(uint256)' 0x0000000000000000000000000000000000000000 --rpc-url "$RPC_A")"
set -e

log "14. pause is immediate"
cast send "$BRIDGE_A" 'pause()' --private-key 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a \
  --rpc-url "$RPC_A" >/dev/null   # anvil #4 = the pauser key
echo "paused = $(cast call "$BRIDGE_A" 'paused()(bool)' --rpc-url "$RPC_A")"
set +e
cast send "$BRIDGE_A" 'send(address,uint256,uint64,address)' \
  0x0000000000000000000000000000000000000000 1000000000000000000 $CHAIN_B "$RECIPIENT" \
  --value 1000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_A" >/dev/null 2>&1
echo "send while paused exit code: $? (non-zero = correctly refused)"
set -e
cast send "$BRIDGE_A" 'unpause()' --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_A" >/dev/null
echo "paused = $(cast call "$BRIDGE_A" 'paused()(bool)' --rpc-url "$RPC_A")"

log "DONE - bridge A = $BRIDGE_A, bridge B = $BRIDGE_B, wFMX = $WFMX"
