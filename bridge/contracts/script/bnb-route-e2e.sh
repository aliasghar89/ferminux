#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# wFMX migration: retire the live bridge pair, stand up a new one, on LOCAL
# anvils only.
#
#   chain F = 3961 on :8570   (Ferminux)   — mints wBNB
#   chain B = 56   on :8571   (BSC)        — locks real BNB
#
# THE DECISION THIS IMPLEMENTS (2026-08-27). The PancakeSwap wFMX/BNB pool is
# live with the multisig holding 100% of the LP, so wFMX 0x73e6… is no longer
# replaceable for free: migrating to an allowance-checking wrapper would mean
# pulling that LP, re-seeding at a new address, and orphaning anyone who bought
# in between. The live wFMX therefore STAYS as it is, scanner flag and all, and
# the BNB route is added to the EXISTING bridge pair.
#
# THAT IS ONLY POSSIBLE BECAUSE OF AN ASYMMETRY, and it is the thing this script
# exists to prove. The wrapper codehash pin is PER BRIDGE, not per chain-pair:
#
#   BSC bridge      pin = OLD BridgeToken  (wFMX lives there, already registered)
#   Ferminux bridge pin = UNSET            (it has never minted a wrapper)
#
# So Ferminux can pin the NEW allowance-checking bytecode for wBNB while BSC
# keeps the old pin for wFMX. Two wrappers, two bytecodes, one live bridge pair.
# If setting the Ferminux pin could disturb the wFMX route, the whole plan is
# wrong — so that is asserted directly rather than reasoned about.
#
# WHAT IT MUST PROVE:
#   - pinning Ferminux does not touch BSC's pin or the live FMX route
#   - the BNB route registers on the EXISTING bridges, at BNB-sized caps
#   - BNB crosses both ways and stays exactly collateralised
#   - wBNB refuses an unapproved burn — the allowance fix reaches the new asset
#   - FMX collateral is untouched by BNB traffic throughout
#
# NEVER point this at a public RPC: anvil dev keys and evm_increaseTime.
#
#   anvil --port 8570 --chain-id 3961 &
#   anvil --port 8571 --chain-id 56   &
#   bash script/bnb-route-e2e.sh
# ---------------------------------------------------------------------------
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HERE"

RPC_F=${RPC_F:-http://127.0.0.1:8570}
RPC_B=${RPC_B:-http://127.0.0.1:8571}
CHAIN_F=3961; CHAIN_B=56

# NOT an anvil dev key. DeployBridge.s.sol refuses the well-known keys on any
# chain id it does not recognise as local — and this rehearsal runs on the REAL
# ids 3961 and 56 on purpose, because the EIP-712 domain binds chainid and a
# rehearsal on invented ids would prove the wrong digests. So the deployer is a
# throwaway key, funded below via anvil_setBalance.
DEPLOYER_KEY=0x00000000000000000000000000000000000000000000000000000000f3721111
DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
# Every role is a throwaway key too, for the same reason as the deployer:
# DeployBridge refuses each anvil dev account by name off a local chain id. The
# validators in particular must have KNOWN keys, because this script signs real
# quorums with them.
V1_KEY=0x00000000000000000000000000000000000000000000000000000000f3720001
V2_KEY=0x00000000000000000000000000000000000000000000000000000000f3720002
V3_KEY=0x00000000000000000000000000000000000000000000000000000000f3720003
PAUSER_KEY=0x00000000000000000000000000000000000000000000000000000000f3720004
USER_KEY=0x00000000000000000000000000000000000000000000000000000000f3720005
HOLDER_KEY=0x00000000000000000000000000000000000000000000000000000000f3720006
V1=$(cast wallet address --private-key $V1_KEY)
V2=$(cast wallet address --private-key $V2_KEY)
V3=$(cast wallet address --private-key $V3_KEY)
PAUSER=$(cast wallet address --private-key $PAUSER_KEY)
USER=$(cast wallet address --private-key $USER_KEY)
HOLDER=$(cast wallet address --private-key $HOLDER_KEY)
ZERO=0x0000000000000000000000000000000000000000
DELAY=3600
# The live numbers, to the wei, read off mainnet 2026-08-27. The rehearsal
# unwinds the amount that actually has to be unwound, not a round number.
LIVE_SUPPLY=499510989000000000000     # wFMX totalSupply on BSC
MAXPER=100000000000000000000          # 100 FMX  — SMOKE cap, per deploy-remote-chain.md 5.1
DAILY=500000000000000000000           # 500 FMX  — SMOKE cap
# The BNB route's smoke caps are sized by BLAST RADIUS, not by copying the FMX
# numbers. 100 FMX is about $19 at the $0.19 reference; 100 BNB would be about
# $60,000. These are the BNB amounts with a comparable radius. Registration is
# once-only, so a cap copied across assets is a mistake that cannot be undone --
# only raised later by timelocked setTokenLimits, which is the safe direction.
BNB_MAXPER=50000000000000000          # 0.05 BNB
BNB_DAILY=250000000000000000          # 0.25 BNB
FAILED=0

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()  { printf '   PASS  %s\n' "$*"; }
bad() { printf '   FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }

# Assert a command fails FOR THE RIGHT REASON. "exited non-zero" is not
# evidence: a typo, a dead RPC or a missing binary all exit non-zero and would
# otherwise be reported as a passing security property.
refuses() {
  local what="$1" want="$2"; shift 2
  local out rc=0
  out=$("$@" 2>&1) || rc=$?
  if [ $rc -eq 0 ]; then bad "$what — WAS ACCEPTED"; return; fi
  if printf '%s' "$out" | grep -qiE "$want"; then
    ok "$what — refused ($(printf '%s' "$out" | grep -oiE "$want" | head -1))"
  else
    bad "$what — failed, but NOT with /$want/: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
  fi
}

eq() { # $1 label  $2 got  $3 want
  [ "$2" = "$3" ] && ok "$1 = $2" || bad "$1: got $2, want $3"
}

deploy_bridge() { # $1 rpc -> echoes address
  DEPLOYER_KEY=$DEPLOYER_KEY \
  BRIDGE_OWNER=$DEPLOYER FEE_COLLECTOR=$DEPLOYER BRIDGE_THRESHOLD=2 FEE_BPS=10 \
  TIMELOCK_DELAY=$DELAY BRIDGE_PAUSER=$PAUSER \
  BRIDGE_VALIDATOR1=$V1 BRIDGE_VALIDATOR2=$V2 BRIDGE_VALIDATOR3=$V3 \
    forge script script/DeployBridge.s.sol --rpc-url "$1" --broadcast >/tmp/fx-bnb-d.log 2>&1
  grep -m1 'FerminuxBridge:' /tmp/fx-bnb-d.log | awk '{print $NF}'
}
bump() { cast send "$DEPLOYER" --value 0 --private-key "$DEPLOYER_KEY" --rpc-url "$1" >/dev/null; }
queue() { local b=$1 r=$2; shift 2
  if ! env BRIDGE=$b OWNER_KEY=$DEPLOYER_KEY ACTION=queue "$@" \
      forge script script/RegisterToken.s.sol --rpc-url "$r" --broadcast >/tmp/fx-bnb-q.log 2>&1; then
    bad "queue failed on $b: $*"; grep -m1 -iE 'revert|error|Error' /tmp/fx-bnb-q.log | sed 's/^/         /'; return 1
  fi; }
exec_action() { BRIDGE=$1 OWNER_KEY=$DEPLOYER_KEY ACTION=execute ACTION_ID=$3 \
    forge script script/RegisterToken.s.sol --rpc-url "$2" --broadcast >/dev/null 2>&1; }
warp() { cast rpc evm_increaseTime $((DELAY + 60)) --rpc-url "$1" >/dev/null; cast rpc evm_mine --rpc-url "$1" >/dev/null; }
sig_tuple() { local s; s=$(cast wallet sign --no-hash "$2" --private-key "$1"); echo "($((16#${s:130:2})),0x${s:2:64},0x${s:66:64})"; }
supply() { cast call "$1" 'totalSupply()(uint256)' --rpc-url "$2" | awk '{print $1}'; }
locked() { cast call "$1" 'lockedBalance(address)(uint256)' "$ZERO" --rpc-url "$2" | awk '{print $1}'; }
net_of() { python3 -c "b=$1; print(b - b*10//10000)"; }
fee_of() { python3 -c "b=$1; print(b*10//10000)"; }
# bash arithmetic is 64-bit; every amount here is wei and overflows it. The
# first run of this script reported "[: 499510989000000000000: integer expected"
# and then PASSED every downstream check against a supply of zero.
bsub()  { python3 -c "print($1 - $2)"; }
bmin()  { python3 -c "print(min($1, $2))"; }
bpos()  { python3 -c "print(1 if $1 > 0 else 0)"; }

# The id the NEXT queue() on this bridge will take. Hardcoding ids drifts the
# moment a step is inserted.
next_id() { cast call "$1" 'actionCount()(uint256)' --rpc-url "$2" | awk '{print $1}'; }

# Queue an action, wait out the timelock, and assert EXECUTING it reverts for the
# named reason. Registration guards live in the inner onlySelf call, so a bad
# registration QUEUES cleanly and only fails when it executes -- 48h later, on a
# real chain. Testing the queue alone reports a guard as absent when it is not.
refuses_on_execute() { # $1 what  $2 regex  $3 bridge  $4 rpc  [queue env...]
  local what=$1 want=$2 b=$3 r=$4; shift 4
  local id; id=$(next_id "$b" "$r")
  if ! env BRIDGE=$b OWNER_KEY=$DEPLOYER_KEY ACTION=queue "$@" \
      forge script script/RegisterToken.s.sol --rpc-url "$r" --broadcast >/tmp/fx-bnb-q.log 2>&1; then
    bad "$what -- could not even queue: $(grep -m1 -iE 'revert|error' /tmp/fx-bnb-q.log | tr -d '\n')"; return
  fi
  warp "$r"
  refuses "$what" "$want" \
    cast send "$b" 'executeAction(uint256)' "$id" --private-key "$DEPLOYER_KEY" --rpc-url "$r"
}

# Deploy a wrapper and echo its address. The forge output goes to a FILE before
# it is grepped: piping forge straight into `grep -m1` makes grep exit early,
# forge take SIGPIPE, and `set -o pipefail` kill the whole run — which looked
# exactly like the deploy failing silently.
mk_wrapper() { # $1 script  $2 bridge  $3 rpc  $4 log-marker  [extra env...]
  local script=$1 bridge=$2 rpc=$3 marker=$4; shift 4
  env DEPLOYER_KEY="$DEPLOYER_KEY" BRIDGE="$bridge" ORIGIN_CHAIN_ID=$CHAIN_F ORIGIN_TOKEN=$ZERO \
      WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX "$@" \
      forge script "$script" --rpc-url "$rpc" --broadcast >/tmp/fx-bnb-w.log 2>&1
  grep -m1 "$marker" /tmp/fx-bnb-w.log | awk '{print $NF}'
}

# Relay one transfer: sign the DESTINATION bridge's own digest and execute it.
relay() { # $1 dstBridge  $2 dstRpc  $3 tuple
  local dig s1 s2
  dig=$(cast call "$1" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$3" --rpc-url "$2")
  s1=$(sig_tuple "$V1_KEY" "$dig"); s2=$(sig_tuple "$V2_KEY" "$dig")
  cast send "$1" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
    "$3" "[$s1,$s2]" --private-key "$DEPLOYER_KEY" --rpc-url "$2" >/dev/null
}

log "0. two anvils"
for r in "$RPC_F" "$RPC_B"; do printf '   %s chain-id %s\n' "$r" "$(cast chain-id --rpc-url "$r")"; done
for r in "$RPC_F" "$RPC_B"; do
  for a in "$DEPLOYER" "$USER" "$HOLDER" "$PAUSER"; do
    cast rpc anvil_setBalance "$a" 0x21e19e0c9bab2400000 --rpc-url "$r" >/dev/null
  done
done

# =========================================================================
log "1. reconstruct the LIVE pair: old bridges, OLD wFMX bytecode, FMX route up"
# =========================================================================
BR_F=$(deploy_bridge "$RPC_F")
for _ in 1 2 3 4 5; do bump "$RPC_B"; done; BR_B=$(deploy_bridge "$RPC_B")
WFMX=$(mk_wrapper script/legacy/DeployLegacyWrapper.s.sol "$BR_B" "$RPC_B" 'LEGACY BridgeToken:' REHEARSAL=1)
OLD_PIN=$(cast codehash "$WFMX" --rpc-url "$RPC_B")
echo "   Ferminux bridge: $BR_F"
echo "   BSC bridge:      $BR_B"
echo "   wFMX (old code): $WFMX"

queue "$BR_B" "$RPC_B" TOKEN_KIND=pin WRAPPER_CODEHASH="$(cast to-dec "$OLD_PIN")"
queue "$BR_F" "$RPC_F" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_B REMOTE_BRIDGE="$BR_B"
queue "$BR_B" "$RPC_B" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_F REMOTE_BRIDGE="$BR_F"
queue "$BR_F" "$RPC_F" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN="$WFMX" \
      MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
queue "$BR_B" "$RPC_B" TOKEN_KIND=wrapped LOCAL_TOKEN="$WFMX" REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
warp "$RPC_F"; warp "$RPC_B"
exec_action "$BR_F" "$RPC_F" 0; exec_action "$BR_F" "$RPC_F" 1
exec_action "$BR_B" "$RPC_B" 0; exec_action "$BR_B" "$RPC_B" 1; exec_action "$BR_B" "$RPC_B" 2

# Real wFMX in circulation, standing in for the PancakeSwap pool + holders.
cast send "$BR_F" 'send(address,uint256,uint64,address)' $ZERO $MAXPER $CHAIN_B "$HOLDER" \
  --value $MAXPER --private-key "$USER_KEY" --rpc-url "$RPC_F" >/dev/null
relay "$BR_B" "$RPC_B" "($CHAIN_F,$CHAIN_B,1,$ZERO,$WFMX,$USER,$HOLDER,$(net_of $MAXPER))"
FMX_SUPPLY=$(supply "$WFMX" "$RPC_B"); FMX_LOCKED=$(locked "$BR_F" "$RPC_F")
eq "wFMX in circulation, exactly collateralised" "$FMX_LOCKED" "$FMX_SUPPLY"
[ "$(bpos "$FMX_SUPPLY")" = "1" ] && ok "the live route was reconstructed, not skipped" \
                                  || bad "no wFMX supply — everything below would be vacuous"
eq "the Ferminux bridge has NO wrapper pin yet — the asymmetry the plan rests on" \
   "$(cast call "$BR_F" 'bridgeTokenCodehash()(bytes32)' --rpc-url "$RPC_F")" \
   "0x0000000000000000000000000000000000000000000000000000000000000000"

# =========================================================================
log "2. ONE timelock window: deploy, queue everything, wait once"
# =========================================================================
# The naive order costs two 48h waits: pin the wrapper, wait, then register.
# It does not have to. queue() only STORES calldata — the guards it will fail
# on (the pin, the registry) are checked at EXECUTE. So the wrapper can be
# deployed first, all three actions queued together, and one delay served for
# the lot. The only ordering that matters is at execution: the pin must land
# before registerWrapped, which is the same block, in sequence.
#
# That turns the BNB route from "48h, then another 48h" into a single wait.
T0=$(cast block latest --field timestamp --rpc-url "$RPC_F")

WBNB=$(mk_wrapper script/DeployWrappedToken.s.sol "$BR_F" "$RPC_F" 'BridgeToken:' \
       ORIGIN_CHAIN_ID=$CHAIN_B WRAPPED_NAME="Wrapped BNB" WRAPPED_SYMBOL=wBNB)
echo "   wBNB on Ferminux: $WBNB   (deploying needs no timelock)"
eq "wBNB names the live Ferminux bridge as its minter" \
   "$(cast call "$WBNB" 'bridge()(address)' --rpc-url "$RPC_F")" "$BR_F"

PIN_ID=$(next_id "$BR_F" "$RPC_F")
queue "$BR_F" "$RPC_F" TOKEN_KIND=pin                      # defaults to the CURRENT BridgeToken
W_ID=$(next_id "$BR_F" "$RPC_F")
queue "$BR_F" "$RPC_F" TOKEN_KIND=wrapped LOCAL_TOKEN="$WBNB" REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=$BNB_MAXPER DAILY_CAP=$BNB_DAILY
B_ID=$(next_id "$BR_B" "$RPC_B")
queue "$BR_B" "$RPC_B" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN="$WBNB" \
      MAX_PER_TRANSFER=$BNB_MAXPER DAILY_CAP=$BNB_DAILY
ok "all three actions queued before any waiting"

# Queueing alone must change NOTHING — that is what makes the announcement
# window meaningful rather than a formality.
eq "queueing did not set the pin" \
   "$(cast call "$BR_F" 'bridgeTokenCodehash()(bytes32)' --rpc-url "$RPC_F")" \
   "0x0000000000000000000000000000000000000000000000000000000000000000"
eq "queueing did not register wBNB" \
   "$(cast call "$BR_F" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' "$WBNB" --rpc-url "$RPC_F" | sed -n 1p)" "0"

# ONE wait, both chains.
warp "$RPC_F"; warp "$RPC_B"

# Execution order is the only ordering constraint: the pin must land before the
# registration that checks it.
exec_action "$BR_F" "$RPC_F" "$PIN_ID"
NEW_PIN=$(cast call "$BR_F" 'bridgeTokenCodehash()(bytes32)' --rpc-url "$RPC_F")
[ "$NEW_PIN" != "$OLD_PIN" ] && ok "Ferminux pins the allowance-checking bytecode, BSC does not" \
                             || bad "the two pins are identical — the wrappers would be the same code"
eq "BSC's pin is UNCHANGED — wFMX's registration is untouched" \
   "$(cast call "$BR_B" 'bridgeTokenCodehash()(bytes32)' --rpc-url "$RPC_B")" "$OLD_PIN"

exec_action "$BR_F" "$RPC_F" "$W_ID"
exec_action "$BR_B" "$RPC_B" "$B_ID"

T1=$(cast block latest --field timestamp --rpc-url "$RPC_F")
ELAPSED=$((T1 - T0))
echo "   elapsed: ${ELAPSED}s across the whole route (one delay is ${DELAY}s)"
[ "$ELAPSED" -lt $((DELAY * 2)) ] && ok "the entire route cost ONE timelock window, not two or three" \
                                 || bad "took ${ELAPSED}s — more than a single delay, the batching did not work"

eq "wBNB is WRAPPED on Ferminux" \
   "$(cast call "$BR_F" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' "$WBNB" --rpc-url "$RPC_F" | sed -n 1p)" "2"
eq "BNB is CANONICAL on BSC" \
   "$(cast call "$BR_B" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' $ZERO --rpc-url "$RPC_B" | sed -n 1p)" "1"
eq "the BNB route carries BNB-sized caps, not the FMX ones" \
   "$(cast call "$BR_B" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' $ZERO --rpc-url "$RPC_B" | sed -n 5p | awk '{print $1}')" "$BNB_MAXPER"

# The live route must still work after re-pinning the other side.
cast send "$BR_F" 'send(address,uint256,uint64,address)' $ZERO 1000000000000000000 $CHAIN_B "$HOLDER" \
  --value 1000000000000000000 --private-key "$USER_KEY" --rpc-url "$RPC_F" >/dev/null
relay "$BR_B" "$RPC_B" "($CHAIN_F,$CHAIN_B,2,$ZERO,$WFMX,$USER,$HOLDER,$(net_of 1000000000000000000))"
eq "FMX -> wFMX still crosses after the re-pin" \
   "$(supply "$WFMX" "$RPC_B")" "$(python3 -c "print($FMX_SUPPLY + $(net_of 1000000000000000000))")"
FMX_SUPPLY=$(supply "$WFMX" "$RPC_B")

# =========================================================================
log "4. BNB crosses, and the FMX route never notices"
# =========================================================================
BNB_NET=$(net_of "$BNB_MAXPER")
cast send "$BR_B" 'send(address,uint256,uint64,address)' $ZERO "$BNB_MAXPER" $CHAIN_F "$HOLDER" \
  --value "$BNB_MAXPER" --private-key "$USER_KEY" --rpc-url "$RPC_B" >/dev/null
BN=$(cast call "$BR_B" 'outboundNonce()(uint64)' --rpc-url "$RPC_B" | awk '{print $1}')
relay "$BR_F" "$RPC_F" "($CHAIN_B,$CHAIN_F,$BN,$ZERO,$WBNB,$USER,$HOLDER,$BNB_NET)"
eq "wBNB minted on Ferminux" "$(supply "$WBNB" "$RPC_F")" "$BNB_NET"
eq "backed exactly by BNB locked on BSC" "$(locked "$BR_B" "$RPC_B")" "$BNB_NET"
eq "a wrapper is never its own collateral" \
   "$(cast call "$BR_F" 'lockedBalance(address)(uint256)' "$WBNB" --rpc-url "$RPC_F" | awk '{print $1}')" "0"
eq "the FMX route's collateral is untouched by BNB traffic" "$(locked "$BR_F" "$RPC_F")" "$FMX_SUPPLY"
eq "and wFMX supply is untouched too" "$(supply "$WFMX" "$RPC_B")" "$FMX_SUPPLY"

# =========================================================================
log "5. wBNB refuses an unapproved burn — the allowance fix reaches the new asset"
# =========================================================================
refuses "bridging wBNB back without approving the bridge" "burn exceeds allowance" \
  cast send "$BR_F" 'send(address,uint256,uint64,address)' "$WBNB" "$BNB_NET" $CHAIN_B "$USER" \
    --private-key "$HOLDER_KEY" --rpc-url "$RPC_F"
eq "the refused send moved nothing" \
   "$(cast call "$WBNB" 'balanceOf(address)(uint256)' "$HOLDER" --rpc-url "$RPC_F" | awk '{print $1}')" "$BNB_NET"

cast send "$WBNB" 'approve(address,uint256)' "$BR_F" "$BNB_NET" --private-key "$HOLDER_KEY" --rpc-url "$RPC_F" >/dev/null
BAL_BEFORE=$(cast balance "$USER" --rpc-url "$RPC_B")
cast send "$BR_F" 'send(address,uint256,uint64,address)' "$WBNB" "$BNB_NET" $CHAIN_B "$USER" \
  --private-key "$HOLDER_KEY" --rpc-url "$RPC_F" >/dev/null
FN=$(cast call "$BR_F" 'outboundNonce()(uint64)' --rpc-url "$RPC_F" | awk '{print $1}')
relay "$BR_B" "$RPC_B" "($CHAIN_F,$CHAIN_B,$FN,$WBNB,$ZERO,$HOLDER,$USER,$(net_of "$BNB_NET"))"
eq "real BNB released to the recipient" \
   "$(bsub "$(cast balance "$USER" --rpc-url "$RPC_B")" "$BAL_BEFORE")" "$(net_of "$BNB_NET")"
eq "the exit consumed exactly the approval" \
   "$(cast call "$WBNB" 'allowance(address,address)(uint256)' "$HOLDER" "$BR_F" --rpc-url "$RPC_F" | awk '{print $1}')" "0"
BNB_FEE=$(fee_of "$BNB_NET")
eq "round trip closed: wBNB supply is exactly the fee" "$(supply "$WBNB" "$RPC_F")" "$BNB_FEE"
eq "round trip closed: BNB collateral still backs it" "$(locked "$BR_B" "$RPC_B")" "$BNB_FEE"

# The old wrapper must STILL have no allowance requirement — it is unchanged
# code and the pool depends on it behaving exactly as it always has.
cast send "$BR_B" 'send(address,uint256,uint64,address)' "$WFMX" 1000000000000000000 $CHAIN_F "$USER" \
  --private-key "$HOLDER_KEY" --rpc-url "$RPC_B" >/dev/null
ok "wFMX still bridges home with NO approval — the live pool's token is unchanged"

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[1mBNB ROUTE REHEARSAL: all checks passed.\033[0m\n'
  printf 'Safe to run against the live pair. Registration is once-only: confirm the\n'
  printf 'BNB caps with the operator before queueing, and keep the BSC pin as it is.\n'
else
  printf '\033[1mBNB ROUTE REHEARSAL: %d CHECK(S) FAILED — do not run this for real.\033[0m\n' "$FAILED"
  exit 1
fi
