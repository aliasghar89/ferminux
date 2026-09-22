#!/usr/bin/env bash
# Execute one matured timelocked action through the owner multisig.
# Usage: msig-exec.sh <label> <bridge> <rpc> <actionId>
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
LABEL=$1; BRIDGE=$2; RPC=$3; AID=$4
gaslog() { python3 -c "import json,sys;d=json.load(sys.stdin);print('$1,'+str(int(d['gasUsed'],16))+','+d['transactionHash'])" >> $R/logs/gas.csv; }
CD=$(cast calldata 'executeAction(uint256)' $AID)
cast send $MSIG 'submit(address,uint256,bytes)' $BRIDGE 0 $CD --private-key $MSIG1_KEY --rpc-url $RPC --json | gaslog "$LABEL:msig-submit"
TXID=$(($(cast call $MSIG 'transactionCount()(uint256)' --rpc-url $RPC) - 1))
cast send $MSIG 'confirm(uint256)' $TXID --private-key $MSIG2_KEY --rpc-url $RPC --json | gaslog "$LABEL:msig-confirm"
cast send $MSIG 'execute(uint256)' $TXID --private-key $MSIG2_KEY --rpc-url $RPC --json | gaslog "$LABEL:msig-execute(executeAction)"
EXECED=$(cast call $BRIDGE 'getAction(uint256)(bytes,uint64,bool,bool)' $AID --rpc-url $RPC | sed -n 3p)
echo "$LABEL: action $AID executed=$EXECED (msig tx $TXID)"
