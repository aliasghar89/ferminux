#!/usr/bin/env bash
# Runbook §4.1 post-deploy verification for one bridge: verify-bridge.sh <bridge> <rpc>
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/env.sh"
B=$1; RPC=$2
echo "owner:     $(cast call $B 'owner()(address)' --rpc-url $RPC)"
echo "threshold: $(cast call $B 'threshold()(uint256)' --rpc-url $RPC)"
echo "validators: $(cast call $B 'getValidators()(address[])' --rpc-url $RPC)"
echo "timelock:  $(cast call $B 'timelockDelay()(uint64)' --rpc-url $RPC)"
echo "feeBps:    $(cast call $B 'feeBps()(uint256)' --rpc-url $RPC)"
echo "collector: $(cast call $B 'feeCollector()(address)' --rpc-url $RPC)"
echo "isPauser:  $(cast call $B 'isPauser(address)(bool)' $PAUSER --rpc-url $RPC)"
echo "paused:    $(cast call $B 'paused()(bool)' --rpc-url $RPC)"
echo "domainSep: $(cast call $B 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url $RPC)"
