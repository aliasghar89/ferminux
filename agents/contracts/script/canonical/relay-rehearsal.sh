#!/usr/bin/env bash
#
# relay-rehearsal.sh — rehearse the keyless broadcast on our own node software.
#
#   ./relay-rehearsal.sh      (needs chain/build/bin/ferminux, cast, jq, python3)
#
# The CREATE2 deployer and Multicall3 transactions are pre-EIP-155 (no chain
# id), and a ferminux node refuses those over RPC unless it was started with
# --rpc.allow-unprotected-txs (chain/internal/fmxapi/api.go, SubmitTransaction).
# That flag only gates RPC submission: the transaction pool and block building
# accept them, so one short-lived relay node that has the flag is enough, and
# the signers need no change.
#
# This script proves that on two throwaway local nodes built from this repo:
#   A  authority signer, stock flags (no --rpc.allow-unprotected-txs)
#   B  relay with --rpc.allow-unprotected-txs, peered only with A
# and runs deploy.sh against them twice:
#   1. keyless relay = A  -> deploy.sh must stop at its zero-cost probe with
#      "refuses pre-EIP-155 transactions" and spend nothing;
#   2. keyless relay = B  -> everything deploys; the presigned transactions
#      reach A over p2p and A seals them.
# then verify.sh against A and a third, no-op, deploy.sh run.
#
# Isolation: private genesis (network id 396100, fresh signer), --nodiscover,
# --netrestrict 127.0.0.1/32, no bootnodes, RPC on 127.0.0.1 only. The genesis
# keeps chain id 3961 so Permit2's chain-specific code hash matches mainnet's
# expectation; the chain cannot meet mainnet (different genesis, loopback only)
# and its keys are generated here and hold nothing anywhere else.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
FERMINUX=${FERMINUX:-$REPO/chain/build/bin/ferminux}
NETWORK_ID=396100
PORT_A=${PORT_A:-30471}; PORT_B=${PORT_B:-30472}
HTTP_A=${HTTP_A:-8671};  HTTP_B=${HTTP_B:-8672}
AUTH_A=${AUTH_A:-8681};  AUTH_B=${AUTH_B:-8682}
RPC_A=http://127.0.0.1:$HTTP_A
RPC_B=http://127.0.0.1:$HTTP_B
WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 1; rm -rf "$WORK"; }
trap cleanup EXIT

[ -x "$FERMINUX" ] || { echo "no node binary at $FERMINUX (build: cd chain && GOTOOLCHAIN=go1.20.14 make ferminux)"; exit 2; }
"$FERMINUX" version | sed -n '1,2p'

SEALER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
SEALER=$(cast wallet address --private-key "$SEALER_KEY")
DEPLOYER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")

python3 - "$WORK/genesis.json" "$SEALER" "$DEPLOYER" <<'EOF'
import json, sys
path, signer, deployer = sys.argv[1], sys.argv[2][2:].lower(), sys.argv[3][2:].lower()
forks = ["homesteadBlock", "eip150Block", "eip155Block", "eip158Block", "byzantiumBlock",
         "constantinopleBlock", "petersburgBlock", "istanbulBlock", "muirGlacierBlock",
         "berlinBlock", "londonBlock"]
cfg = {"chainId": 3961, **{f: 0 for f in forks}, "clique": {"period": 2, "epoch": 30000}}
json.dump({
    "config": cfg,
    "difficulty": "0x1",
    "gasLimit": "0x5f5e100",
    "baseFeePerGas": "0x7",
    "extraData": "0x" + "00" * 32 + signer + "00" * 65,
    "alloc": {deployer: {"balance": hex(10**18)}},
}, open(path, "w"), indent=1)
EOF

echo "pw" >"$WORK/pw"
echo "${SEALER_KEY#0x}" >"$WORK/signer.key"
for n in a b; do "$FERMINUX" --datadir "$WORK/$n" init "$WORK/genesis.json" >"$WORK/init-$n.log" 2>&1; done
"$FERMINUX" --datadir "$WORK/a" account import --password "$WORK/pw" "$WORK/signer.key" >/dev/null 2>&1
rm -f "$WORK/signer.key"

COMMON=(--networkid "$NETWORK_ID" --nodiscover --netrestrict 127.0.0.1/32 --bootnodes "" --nat none
        --authrpc.addr 127.0.0.1 --maxpeers 2 --syncmode full --ipcdisable --http --http.addr 127.0.0.1
        --http.api eth,net,web3,txpool,admin,clique --verbosity 2)
"$FERMINUX" --datadir "$WORK/a" "${COMMON[@]}" --port "$PORT_A" --http.port "$HTTP_A" --authrpc.port "$AUTH_A" \
  --mine --miner.etherbase "$SEALER" --unlock "$SEALER" --password "$WORK/pw" --allow-insecure-unlock \
  --miner.gasprice 1000000000 >"$WORK/a.log" 2>&1 &
PIDS+=($!)
"$FERMINUX" --datadir "$WORK/b" "${COMMON[@]}" --port "$PORT_B" --http.port "$HTTP_B" --authrpc.port "$AUTH_B" \
  --rpc.allow-unprotected-txs >"$WORK/b.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 60); do
  cast chain-id --rpc-url "$RPC_A" >/dev/null 2>&1 && cast chain-id --rpc-url "$RPC_B" >/dev/null 2>&1 && break
  sleep 1
done
ENODE_A=$(cast rpc admin_nodeInfo --rpc-url "$RPC_A" | jq -r .enode)
cast rpc admin_addPeer "$ENODE_A" --rpc-url "$RPC_B" >/dev/null
for _ in $(seq 1 60); do
  [ "$(cast rpc net_peerCount --rpc-url "$RPC_B" | tr -d '"')" != 0x0 ] && [ "$(cast block-number --rpc-url "$RPC_A")" -ge 2 ] && break
  sleep 1
done
echo "A (signer, stock RPC) block $(cast block-number --rpc-url "$RPC_A"), peers $(cast rpc net_peerCount --rpc-url "$RPC_A")"
echo "B (relay, --rpc.allow-unprotected-txs) peers $(cast rpc net_peerCount --rpc-url "$RPC_B")"

export RPC_URL=$RPC_A DEPLOYER SIGNER="--private-key $DEPLOYER_KEY" CONFIRM=deploy-canonical-3961
BAL0=$(cast balance "$DEPLOYER" --rpc-url "$RPC_A")

echo ""
echo "== 1. keyless relay = A (stock flags): must refuse before spending anything"
if OUT=$(UNPROTECTED_RPC_URL=$RPC_A "$HERE/deploy.sh" apply 2>&1); then
  echo "$OUT" | tail -5; echo "FAIL: deploy.sh succeeded through a node without the flag"; exit 1
fi
echo "$OUT" | grep -E "ERROR" | sed 's/^/   /'
grep -q "refuses pre-EIP-155" <<<"$OUT" || { echo "FAIL: unexpected error"; exit 1; }
[ "$(cast balance "$DEPLOYER" --rpc-url "$RPC_A")" = "$BAL0" ] || { echo "FAIL: FMX was spent"; exit 1; }
echo "   deployer balance unchanged ($(cast from-wei "$BAL0") FMX)"

echo ""
echo "== 2. keyless relay = B: full deployment, receipts read from A"
UNPROTECTED_RPC_URL=$RPC_B "$HERE/deploy.sh" apply

echo ""
echo "== 3. again (must change nothing)"
UNPROTECTED_RPC_URL=$RPC_B "$HERE/deploy.sh" apply | tail -1

echo ""
echo "== verify against A"
RPC_URL=$RPC_A "$HERE/verify.sh" | tail -1

# The two presigned transactions were submitted only to B; A sealed them.
for h in $(jq -r '.keyless[].txHash' "$HERE/manifest.json"); do
  blk=$(cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC_A" | jq -r .blockNumber)
  by=$(cast rpc clique_getSigner "$blk" --rpc-url "$RPC_A" 2>/dev/null | tr -d '"' || true)
  echo "presigned $h: submitted only to B, sealed by A in block $(cast to-dec "$blk") (sealer ${by:-unknown})"
  [ "$(tr 'A-F' 'a-f' <<<"$by")" = "$(tr 'A-F' 'a-f' <<<"$SEALER")" ] || { echo "FAIL: not sealed by A"; exit 1; }
done
echo ""
echo "RELAY REHEARSAL PASSED"
