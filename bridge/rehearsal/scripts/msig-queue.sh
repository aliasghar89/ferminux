#!/usr/bin/env bash
# Queue one timelocked bridge action through the owner multisig.
# Usage: env TOKEN_KIND=... [REMOTE_CHAIN_ID=... etc] msig-queue.sh <label> <bridge> <rpc>
# Runs RegisterToken.s.sol with NO OWNER_KEY (prints calldata, broadcasts nothing),
# then drives MinimalMultisig: submit (msig1, auto-confirm) -> confirm (msig2) -> execute (msig2).
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
LABEL=$1; BRIDGE=$2; RPC=$3
LOG=$R/logs/queue-$LABEL.log
cd "$(cd "$(dirname "$0")/../../contracts" && pwd)"
BRIDGE=$BRIDGE ACTION=queue forge script script/RegisterToken.s.sol --rpc-url $RPC > $LOG 2>&1
CD=$(awk '/calldata for bridge.queue\(bytes\)/{getline; gsub(/ /,""); print; exit}' $LOG)
[ -n "$CD" ] || { echo "no calldata extracted for $LABEL"; tail -20 $LOG; exit 1; }
echo "$LABEL queue-calldata: ${CD:0:74}..."
gaslog() { python3 -c "import json,sys;d=json.load(sys.stdin);print('$1,'+str(int(d['gasUsed'],16))+','+d['transactionHash'])" >> $R/logs/gas.csv; }
cast send $MSIG 'submit(address,uint256,bytes)' $BRIDGE 0 $CD --private-key $MSIG1_KEY --rpc-url $RPC --json | gaslog "$LABEL:msig-submit"
TXID=$(($(cast call $MSIG 'transactionCount()(uint256)' --rpc-url $RPC) - 1))
cast send $MSIG 'confirm(uint256)' $TXID --private-key $MSIG2_KEY --rpc-url $RPC --json | gaslog "$LABEL:msig-confirm"
cast send $MSIG 'execute(uint256)' $TXID --private-key $MSIG2_KEY --rpc-url $RPC --json | gaslog "$LABEL:msig-execute(queue)"
AID=$(($(cast call $BRIDGE 'actionCount()(uint256)' --rpc-url $RPC) - 1))
ETA=$(cast call $BRIDGE 'getAction(uint256)(bytes,uint64,bool,bool)' $AID --rpc-url $RPC | sed -n 2p)
echo "$LABEL -> queued action id $AID (msig tx $TXID), eta $ETA"
echo "$LABEL,$BRIDGE,$RPC,$AID,$TXID" >> $R/logs/actions.csv
