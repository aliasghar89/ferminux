#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# wFMX migration: retire the live bridge pair, stand up a new one, on LOCAL
# anvils only.
#
#   chain F = 3961 on :8570   (Ferminux)   — runs the OLD and NEW bridges
#   chain B = 56   on :8571   (BSC)        — runs the OLD and NEW bridges
#
# WHY A MIGRATION AT ALL. BridgeToken.burn() now debits the holder's allowance,
# so no bridge — including one installed by a later rotation — can move a
# balance nobody granted it. That changes the wrapper's runtime bytecode, which
# changes the codehash registerWrapped pins. The live wFMX cannot be upgraded
# (no proxy, deliberately) and cannot be replaced in place:
#
#   _register: require(_localTokenFor[remoteChainId][remoteToken] == address(0),
#                      "BRIDGE: remote already routed")
#
# with no unregister. And the Ferminux side's native route has the OLD wFMX
# address frozen in its TokenConfig.remoteToken, for which there is no setter.
# So BOTH bridges are redeployed. This script proves the whole sequence before
# any of it touches a chain that holds value.
#
# WHAT IT MUST PROVE, beyond "the happy path works":
#   - the unwind empties the old pair completely, with no stranded collateral
#   - the shortcuts do NOT exist, so nobody later "simplifies" the migration
#   - old and new pairs coexist during cutover WITHOUT cross-executable quorums
#   - the new wrapper refuses an unapproved burn, which is the point of all this
#
# NEVER point this at a public RPC: anvil dev keys and evm_increaseTime.
#
#   anvil --port 8570 --chain-id 3961 &
#   anvil --port 8571 --chain-id 56   &
#   bash script/wfmx-migration-e2e.sh
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
    forge script script/DeployBridge.s.sol --rpc-url "$1" --broadcast >/tmp/fx-mig-d.log 2>&1
  grep -m1 'FerminuxBridge:' /tmp/fx-mig-d.log | awk '{print $NF}'
}
bump() { cast send "$DEPLOYER" --value 0 --private-key "$DEPLOYER_KEY" --rpc-url "$1" >/dev/null; }
queue() { local b=$1 r=$2; shift 2
  if ! env BRIDGE=$b OWNER_KEY=$DEPLOYER_KEY ACTION=queue "$@" \
      forge script script/RegisterToken.s.sol --rpc-url "$r" --broadcast >/tmp/fx-mig-q.log 2>&1; then
    bad "queue failed on $b: $*"; grep -m1 -iE 'revert|error|Error' /tmp/fx-mig-q.log | sed 's/^/         /'; return 1
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
      forge script script/RegisterToken.s.sol --rpc-url "$r" --broadcast >/tmp/fx-mig-q.log 2>&1; then
    bad "$what -- could not even queue: $(grep -m1 -iE 'revert|error' /tmp/fx-mig-q.log | tr -d '\n')"; return
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
      forge script "$script" --rpc-url "$rpc" --broadcast >/tmp/fx-mig-w.log 2>&1
  grep -m1 "$marker" /tmp/fx-mig-w.log | awk '{print $NF}'
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
printf '   deployer %s funded on both (not an anvil dev key — DeployBridge refuses those)\n' "$DEPLOYER"

# =========================================================================
log "1. reconstruct the LIVE topology: old bridges, old wrapper bytecode"
# =========================================================================
OLD_F=$(deploy_bridge "$RPC_F")
for _ in 1 2 3 4 5; do bump "$RPC_B"; done; OLD_B=$(deploy_bridge "$RPC_B")
echo "   old Ferminux bridge: $OLD_F"
echo "   old BSC bridge:      $OLD_B"

OLD_WFMX=$(mk_wrapper script/legacy/DeployLegacyWrapper.s.sol "$OLD_B" "$RPC_B" 'LEGACY BridgeToken:' REHEARSAL=1)
OLD_PIN=$(cast codehash "$OLD_WFMX" --rpc-url "$RPC_B")
echo "   old wFMX:            $OLD_WFMX  (codehash $OLD_PIN)"

queue "$OLD_B" "$RPC_B" TOKEN_KIND=pin WRAPPER_CODEHASH="$(cast to-dec "$OLD_PIN")"
queue "$OLD_F" "$RPC_F" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_B REMOTE_BRIDGE="$OLD_B"
queue "$OLD_B" "$RPC_B" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_F REMOTE_BRIDGE="$OLD_F"
queue "$OLD_F" "$RPC_F" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN="$OLD_WFMX" \
      MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
queue "$OLD_B" "$RPC_B" TOKEN_KIND=wrapped LOCAL_TOKEN="$OLD_WFMX" REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
warp "$RPC_F"; warp "$RPC_B"
exec_action "$OLD_F" "$RPC_F" 0; exec_action "$OLD_F" "$RPC_F" 1
exec_action "$OLD_B" "$RPC_B" 0; exec_action "$OLD_B" "$RPC_B" 1; exec_action "$OLD_B" "$RPC_B" 2

# Put the live supply in a holder's hands, in cap-sized crossings, exactly as it
# got there: 100 FMX at a time, each one locking real collateral on Ferminux.
REMAIN=$LIVE_SUPPLY; N=0
while [ "$(bpos "$REMAIN")" = "1" ]; do
  CHUNK=$(bmin "$REMAIN" "$MAXPER")
  cast send "$OLD_F" 'send(address,uint256,uint64,address)' $ZERO "$CHUNK" $CHAIN_B "$HOLDER" \
    --value "$CHUNK" --private-key "$USER_KEY" --rpc-url "$RPC_F" >/dev/null
  N=$((N+1))
  relay "$OLD_B" "$RPC_B" "($CHAIN_F,$CHAIN_B,$N,$ZERO,$OLD_WFMX,$USER,$HOLDER,$(net_of "$CHUNK"))"
  REMAIN=$(bsub "$REMAIN" "$CHUNK")
  # The daily cap is a rolling window; the live route filled it over days.
  cast rpc evm_increaseTime 86400 --rpc-url "$RPC_F" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC_F" >/dev/null
done
OLD_SUP=$(supply "$OLD_WFMX" "$RPC_B"); OLD_LOCKED=$(locked "$OLD_F" "$RPC_F")
echo "   crossings: $N   wFMX outstanding: $OLD_SUP   FMX collateral: $OLD_LOCKED"
# Guard the guard: "0 == 0" satisfies the invariant and proves nothing. Every
# later assertion in this script is about draining this supply, so a supply that
# never arrived would make the whole run a green vacuum.
[ "$(bpos "$OLD_SUP")" = "1" ] && ok "the live supply was reconstructed, not skipped" \
                              || bad "wFMX supply is zero -- nothing was set up, so nothing below means anything"
eq "collateral exactly backs the wrapped supply" "$OLD_LOCKED" "$OLD_SUP"

# =========================================================================
log "2. the shortcuts do not exist — this is why both bridges are redeployed"
# =========================================================================
NEW_WFMX_PROBE=$(mk_wrapper script/DeployWrappedToken.s.sol "$OLD_B" "$RPC_B" 'BridgeToken:')
NEW_PIN=$(cast codehash "$NEW_WFMX_PROBE" --rpc-url "$RPC_B")
[ "$NEW_PIN" != "$OLD_PIN" ] && ok "the allowance check changed the wrapper codehash ($NEW_PIN)" \
                            || bad "codehash unchanged — the migration would be pointless"

# Even with the pin moved to the new bytecode, the old BSC bridge cannot adopt
# the new wrapper for the same remote pair. This is the once-only registry.
PIN_ID=$(next_id "$OLD_B" "$RPC_B")
queue "$OLD_B" "$RPC_B" TOKEN_KIND=pin WRAPPER_CODEHASH="$(cast to-dec "$NEW_PIN")"
warp "$RPC_B"; exec_action "$OLD_B" "$RPC_B" "$PIN_ID"
refuses_on_execute "registering a second wFMX on the old BSC bridge" "remote already routed|already registered" \
  "$OLD_B" "$RPC_B" TOKEN_KIND=wrapped LOCAL_TOKEN="$NEW_WFMX_PROBE" \
    REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN=$ZERO MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY

# And the Ferminux side cannot be re-pointed at it either: remoteToken is frozen
# in the TokenConfig and there is no setter for it. Re-registering the native
# coin is the only thing that could change it, and that is refused too.
refuses_on_execute "re-registering native FMX to name the new wrapper" "already registered|remote already routed" \
  "$OLD_F" "$RPC_F" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO \
    REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN="$NEW_WFMX_PROBE" MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
RT=$(cast call "$OLD_F" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' $ZERO --rpc-url "$RPC_F" | sed -n '4p')
eq "the old route's remoteToken is still the old wrapper" "$RT" "$OLD_WFMX"

# =========================================================================
log "3. UNWIND: bring every wFMX home on the old route"
# =========================================================================
# The live wrapper's burn() consults no allowance, so this leg needs no approve
# — and the tooling must handle BOTH shapes, because it runs against the old
# wrapper here and the new one forever after.
REMAIN=$OLD_SUP; N=0
OUT_N=$(cast call "$OLD_B" 'outboundNonce()(uint64)' --rpc-url "$RPC_B" | awk '{print $1}')
while [ "$(bpos "$REMAIN")" = "1" ]; do
  CHUNK=$(bmin "$REMAIN" "$MAXPER")
  cast send "$OLD_B" 'send(address,uint256,uint64,address)' "$OLD_WFMX" "$CHUNK" $CHAIN_F "$USER" \
    --private-key "$HOLDER_KEY" --rpc-url "$RPC_B" >/dev/null
  OUT_N=$((OUT_N+1))
  relay "$OLD_F" "$RPC_F" "($CHAIN_B,$CHAIN_F,$OUT_N,$OLD_WFMX,$ZERO,$HOLDER,$USER,$(net_of "$CHUNK"))"
  REMAIN=$(bsub "$REMAIN" "$CHUNK")
  cast rpc evm_increaseTime 86400 --rpc-url "$RPC_B" >/dev/null; cast rpc evm_mine --rpc-url "$RPC_B" >/dev/null
  cast rpc evm_increaseTime 86400 --rpc-url "$RPC_F" >/dev/null; cast rpc evm_mine --rpc-url "$RPC_F" >/dev/null
done
# A full unwind does NOT reach zero, and assuming it would is how a migration
# leaves a live claim behind. Every wrapped burn re-mints the fee to the bridge
# AS WRAPPED SUPPLY, so bringing all user balances home converts the user float
# into bridge-held float. That residue is still a claim on Ferminux collateral.
RESIDUE=$(supply "$OLD_WFMX" "$RPC_B")
WFEES=$(cast call "$OLD_B" 'accruedFees(address)(uint256)' "$OLD_WFMX" --rpc-url "$RPC_B" | awk '{print $1}')
eq "user balances are home; the residue is exactly the bridge's accrued fee" "$RESIDUE" "$WFEES"
eq "and that residue is still fully collateralised" "$(locked "$OLD_F" "$RPC_F")" "$RESIDUE"

# Sweep it. withdrawFees is NOT timelocked (owner or feeCollector), so the fee
# can be taken out and bridged home like any other balance. Each pass leaves
# 0.1% of the previous and fee_of() floors to zero below 1000 wei, so this
# terminates -- but it takes several passes, which is a thing to budget for
# rather than discover on the day.
SWEEP=0
while [ "$(bpos "$(supply "$OLD_WFMX" "$RPC_B")")" = "1" ]; do
  SWEEP=$((SWEEP+1))
  if [ "$SWEEP" -gt 12 ]; then bad "the fee sweep did not converge in 12 passes"; break; fi
  cast send "$OLD_B" 'withdrawFees(address)' "$OLD_WFMX" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null
  AMT=$(cast call "$OLD_WFMX" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC_B" | awk '{print $1}')
  [ "$(bpos "$AMT")" = "1" ] || { bad "withdrawFees paid out nothing on pass $SWEEP"; break; }
  cast send "$OLD_B" 'send(address,uint256,uint64,address)' "$OLD_WFMX" "$AMT" $CHAIN_F "$USER" \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B" >/dev/null
  OUT_N=$((OUT_N+1))
  relay "$OLD_F" "$RPC_F" "($CHAIN_B,$CHAIN_F,$OUT_N,$OLD_WFMX,$ZERO,$DEPLOYER,$USER,$(net_of "$AMT"))"
  cast rpc evm_increaseTime 86400 --rpc-url "$RPC_B" >/dev/null; cast rpc evm_mine --rpc-url "$RPC_B" >/dev/null
  cast rpc evm_increaseTime 86400 --rpc-url "$RPC_F" >/dev/null; cast rpc evm_mine --rpc-url "$RPC_F" >/dev/null
done
echo "   fee sweep converged in $SWEEP passes"
eq "wFMX supply after the sweep" "$(supply "$OLD_WFMX" "$RPC_B")" "0"
eq "FMX collateral after the sweep" "$(locked "$OLD_F" "$RPC_F")" "0"

# What is left on the old bridge must be its own native fees and nothing else —
# a leftover wei of collateral would mean somebody's claim was quietly written off.
BAL_F=$(cast balance "$OLD_F" --rpc-url "$RPC_F")
FEES_F=$(cast call "$OLD_F" 'accruedFees(address)(uint256)' $ZERO --rpc-url "$RPC_F" | awk '{print $1}')
eq "the drained bridge holds exactly its accrued native fees" "$BAL_F" "$FEES_F"

# =========================================================================
log "4. stand up the NEW pair with the allowance-checking wrapper"
# =========================================================================
bump "$RPC_F"; NEW_F=$(deploy_bridge "$RPC_F")
bump "$RPC_B"; NEW_B=$(deploy_bridge "$RPC_B")
NEW_WFMX=$(mk_wrapper script/DeployWrappedToken.s.sol "$NEW_B" "$RPC_B" 'BridgeToken:')
echo "   new Ferminux bridge: $NEW_F"
echo "   new BSC bridge:      $NEW_B"
echo "   new wFMX:            $NEW_WFMX"
DUPES=$(printf '%s\n' "$OLD_F" "$OLD_B" "$NEW_F" "$NEW_B" "$OLD_WFMX" "$NEW_WFMX" | sort | uniq -d)
[ -z "$DUPES" ] && ok "old and new deployments are all distinct addresses" || bad "address collision: $DUPES"

queue "$NEW_B" "$RPC_B" TOKEN_KIND=pin
# The Ferminux bridge needs the wrapper pin as well now. It never did before,
# because it only ever held canonical FMX -- but the BNB route makes it a MINTER
# of wBNB, and registerWrapped fails closed while the pin is unset
# ("BRIDGE: wrapper pin unset"). Easy to forget precisely because the old
# Ferminux bridge ran for months without one.
queue "$NEW_F" "$RPC_F" TOKEN_KIND=pin
queue "$NEW_F" "$RPC_F" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_B REMOTE_BRIDGE="$NEW_B"
queue "$NEW_B" "$RPC_B" TOKEN_KIND=remotebridge REMOTE_CHAIN_ID=$CHAIN_F REMOTE_BRIDGE="$NEW_F"
queue "$NEW_F" "$RPC_F" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN="$NEW_WFMX" \
      MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
queue "$NEW_B" "$RPC_B" TOKEN_KIND=wrapped LOCAL_TOKEN="$NEW_WFMX" REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=$MAXPER DAILY_CAP=$DAILY
warp "$RPC_F"; warp "$RPC_B"
exec_action "$NEW_F" "$RPC_F" 0; exec_action "$NEW_F" "$RPC_F" 1; exec_action "$NEW_F" "$RPC_F" 2
exec_action "$NEW_B" "$RPC_B" 0; exec_action "$NEW_B" "$RPC_B" 1; exec_action "$NEW_B" "$RPC_B" 2
eq "the new route registered at the SMOKE per-transfer cap" \
   "$(cast call "$NEW_F" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' $ZERO --rpc-url "$RPC_F" | sed -n '5p' | awk '{print $1}')" \
   "$MAXPER"

# =========================================================================
log "5. cutover safety: two live pairs, same chains, same validators"
# =========================================================================
# This is the Ronin-shaped question. During the cutover the old pair is drained
# but still deployed and still trusts the same three keys. If a quorum for the
# new route also executed on the old one, the migration would open the hole it
# is closing.
cast send "$NEW_F" 'send(address,uint256,uint64,address)' $ZERO $MAXPER $CHAIN_B "$HOLDER" \
  --value $MAXPER --private-key "$USER_KEY" --rpc-url "$RPC_F" >/dev/null
T="($CHAIN_F,$CHAIN_B,1,$ZERO,$NEW_WFMX,$USER,$HOLDER,$(net_of $MAXPER))"
D_NEW=$(cast call "$NEW_B" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$T" --rpc-url "$RPC_B")
D_OLD=$(cast call "$OLD_B" 'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' "$T" --rpc-url "$RPC_B")
[ "$D_NEW" != "$D_OLD" ] && ok "the same transfer hashes differently per bridge (domain binds address(this))" \
                         || bad "IDENTICAL DIGESTS — a new-route quorum would execute on the old bridge"
S1=$(sig_tuple "$V1_KEY" "$D_NEW"); S2=$(sig_tuple "$V2_KEY" "$D_NEW")
refuses "replaying the new route's quorum against the old BSC bridge" "bad signature|not a validator|unsorted|BRIDGE:" \
  cast send "$OLD_B" 'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
    "$T" "[$S1,$S2]" --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_B"
eq "the drained old wrapper minted nothing" "$(supply "$OLD_WFMX" "$RPC_B")" "0"

relay "$NEW_B" "$RPC_B" "$T"
eq "the new route delivered" "$(supply "$NEW_WFMX" "$RPC_B")" "$(net_of $MAXPER)"

# =========================================================================
log "6. the new wrapper refuses an unapproved burn — the point of the migration"
# =========================================================================
BACK=$(supply "$NEW_WFMX" "$RPC_B")
refuses "bridging wFMX home without approving the bridge" "burn exceeds allowance" \
  cast send "$NEW_B" 'send(address,uint256,uint64,address)' "$NEW_WFMX" "$BACK" $CHAIN_F "$USER" \
    --private-key "$HOLDER_KEY" --rpc-url "$RPC_B"
eq "the refused send moved nothing" "$(cast call "$NEW_WFMX" 'balanceOf(address)(uint256)' "$HOLDER" --rpc-url "$RPC_B" | awk '{print $1}')" "$BACK"

cast send "$NEW_WFMX" 'approve(address,uint256)' "$NEW_B" "$BACK" --private-key "$HOLDER_KEY" --rpc-url "$RPC_B" >/dev/null
cast send "$NEW_B" 'send(address,uint256,uint64,address)' "$NEW_WFMX" "$BACK" $CHAIN_F "$USER" \
  --private-key "$HOLDER_KEY" --rpc-url "$RPC_B" >/dev/null
ok "the approved send went through"
eq "the exit consumed exactly the approval" \
   "$(cast call "$NEW_WFMX" 'allowance(address,address)(uint256)' "$HOLDER" "$NEW_B" --rpc-url "$RPC_B" | awk '{print $1}')" "0"
OUT_N=$(cast call "$NEW_B" 'outboundNonce()(uint64)' --rpc-url "$RPC_B" | awk '{print $1}')
relay "$NEW_F" "$RPC_F" "($CHAIN_B,$CHAIN_F,$OUT_N,$NEW_WFMX,$ZERO,$HOLDER,$USER,$(net_of "$BACK"))"
# A closed round trip does NOT end at zero. Burning wrapped re-mints the fee to
# the bridge as wrapped supply, and that fee is still a claim on Ferminux
# collateral -- so the invariant to assert is supply == collateral, both equal to
# the fee. Asserting zero here would be asserting that the fee vanished.
RT_FEE=$(fee_of "$BACK")
eq "round trip closed: wrapper supply is exactly the fee" "$(supply "$NEW_WFMX" "$RPC_B")" "$RT_FEE"
eq "round trip closed: collateral still backs it exactly" "$(locked "$NEW_F" "$RPC_F")" "$RT_FEE"

# =========================================================================
log "7. the BNB route: BSC's native coin, canonical there and wrapped here"
# =========================================================================
# The mirror image of the FMX route. It is registered on the NEW pair, never the
# old one: registration is once-only, so a BNB route stood up before the
# migration would have to be abandoned with the bridges it lives on -- and it
# cannot be unregistered, so that would mean a THIRD deployment.
#
# Note what this route means economically, which the FMX route does not: the BSC
# bridge holds REAL BNB as collateral for every wBNB minted on Ferminux. The FMX
# route is collateralised in our own coin; this one is not.
WBNB=$(mk_wrapper script/DeployWrappedToken.s.sol "$NEW_F" "$RPC_F" 'BridgeToken:' \
       ORIGIN_CHAIN_ID=$CHAIN_B WRAPPED_NAME="Wrapped BNB" WRAPPED_SYMBOL=wBNB)
echo "   wBNB on Ferminux: $WBNB"
[ "$(cast call "$WBNB" 'bridge()(address)' --rpc-url "$RPC_F")" = "$NEW_F" ] \
  && ok "the new Ferminux bridge is the wBNB minter" || bad "wBNB names the wrong minter"

queue "$NEW_F" "$RPC_F" TOKEN_KIND=wrapped LOCAL_TOKEN="$WBNB" REMOTE_CHAIN_ID=$CHAIN_B REMOTE_TOKEN=$ZERO \
      MAX_PER_TRANSFER=$BNB_MAXPER DAILY_CAP=$BNB_DAILY
queue "$NEW_B" "$RPC_B" TOKEN_KIND=canonical LOCAL_TOKEN=$ZERO REMOTE_CHAIN_ID=$CHAIN_F REMOTE_TOKEN="$WBNB" \
      MAX_PER_TRANSFER=$BNB_MAXPER DAILY_CAP=$BNB_DAILY
warp "$RPC_F"; warp "$RPC_B"
exec_action "$NEW_F" "$RPC_F" 3
exec_action "$NEW_B" "$RPC_B" 3
eq "wBNB is registered WRAPPED on Ferminux" \
   "$(cast call "$NEW_F" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' "$WBNB" --rpc-url "$RPC_F" | sed -n '1p')" "2"
eq "BNB is registered CANONICAL on BSC" \
   "$(cast call "$NEW_B" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' $ZERO --rpc-url "$RPC_B" | sed -n '1p')" "1"
eq "the BNB route carries its own smoke cap, not the FMX one" \
   "$(cast call "$NEW_B" 'tokenConfig(address)(uint8,bool,uint64,address,uint256,uint256)' $ZERO --rpc-url "$RPC_B" | sed -n '5p' | awk '{print $1}')" "$BNB_MAXPER"

# BSC -> Ferminux: lock real BNB, mint wBNB.
BNB_IN=$BNB_MAXPER
BNB_NET=$(net_of "$BNB_IN")
cast send "$NEW_B" 'send(address,uint256,uint64,address)' $ZERO "$BNB_IN" $CHAIN_F "$HOLDER" \
  --value "$BNB_IN" --private-key "$USER_KEY" --rpc-url "$RPC_B" >/dev/null
BNB_N=$(cast call "$NEW_B" 'outboundNonce()(uint64)' --rpc-url "$RPC_B" | awk '{print $1}')
relay "$NEW_F" "$RPC_F" "($CHAIN_B,$CHAIN_F,$BNB_N,$ZERO,$WBNB,$USER,$HOLDER,$BNB_NET)"
eq "wBNB minted on Ferminux" "$(supply "$WBNB" "$RPC_F")" "$BNB_NET"
eq "and it is exactly backed by BNB locked on BSC" "$(locked "$NEW_B" "$RPC_B")" "$BNB_NET"
# A wrapper is an IOU, never collateral. If the Ferminux bridge ever recorded
# lockedBalance against wBNB it would be double-counting its own IOU.
eq "the Ferminux bridge holds NO collateral against its own wrapper" \
   "$(cast call "$NEW_F" 'lockedBalance(address)(uint256)' "$WBNB" --rpc-url "$RPC_F" | awk '{print $1}')" "0"

# The FMX route must not have moved. Two assets, two independent registries.
eq "the FMX route's collateral is untouched by BNB traffic" "$(locked "$NEW_F" "$RPC_F")" "$RT_FEE"

# Ferminux -> BSC: burn wBNB, release real BNB. The allowance rule applies to
# every wrapper, not just wFMX -- so this leg is approve-then-send too.
refuses "bridging wBNB back without approving the bridge" "burn exceeds allowance" \
  cast send "$NEW_F" 'send(address,uint256,uint64,address)' "$WBNB" "$BNB_NET" $CHAIN_B "$USER" \
    --private-key "$HOLDER_KEY" --rpc-url "$RPC_F"
cast send "$WBNB" 'approve(address,uint256)' "$NEW_F" "$BNB_NET" --private-key "$HOLDER_KEY" --rpc-url "$RPC_F" >/dev/null
BAL_BEFORE=$(cast balance "$USER" --rpc-url "$RPC_B")
cast send "$NEW_F" 'send(address,uint256,uint64,address)' "$WBNB" "$BNB_NET" $CHAIN_B "$USER" \
  --private-key "$HOLDER_KEY" --rpc-url "$RPC_F" >/dev/null
BACK_N=$(cast call "$NEW_F" 'outboundNonce()(uint64)' --rpc-url "$RPC_F" | awk '{print $1}')
relay "$NEW_B" "$RPC_B" "($CHAIN_F,$CHAIN_B,$BACK_N,$WBNB,$ZERO,$HOLDER,$USER,$(net_of "$BNB_NET"))"
eq "real BNB was released to the recipient" \
   "$(bsub "$(cast balance "$USER" --rpc-url "$RPC_B")" "$BAL_BEFORE")" "$(net_of "$BNB_NET")"
BNB_FEE=$(fee_of "$BNB_NET")
eq "round trip closed: wBNB supply is exactly the fee" "$(supply "$WBNB" "$RPC_F")" "$BNB_FEE"
eq "round trip closed: BNB collateral still backs it exactly" "$(locked "$NEW_B" "$RPC_B")" "$BNB_FEE"

# =========================================================================
printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[1mMIGRATION REHEARSAL: all checks passed.\033[0m\n'
  printf 'The sequence is safe to run for real. Registration is once-only — follow\n'
  printf 'the order above exactly, and re-read the caps before queueing.\n'
else
  printf '\033[1mMIGRATION REHEARSAL: %d CHECK(S) FAILED — do not run this for real.\033[0m\n' "$FAILED"
  exit 1
fi
