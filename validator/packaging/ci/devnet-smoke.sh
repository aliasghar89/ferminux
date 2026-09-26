#!/usr/bin/env bash
# CI smoke test: starts the built ferminux binary on a throwaway, local-only
# --dev network and checks that it both produces new blocks and re-imports
# its own chain data after a restart.
#
# This never touches chain 3961 or any public network. --dev mode disables
# p2p entirely (chain/cmd/utils/flags.go: "--dev mode can't use p2p
# networking") and uses an ephemeral single-signer Clique network whose
# genesis is generated in memory - it exists only to prove the binary
# starts, seals blocks and can reload a datadir, independent of mainnet
# genesis, bootnodes or peers.
#
# Usage: devnet-smoke.sh <path-to-ferminux-binary> [port]
set -euo pipefail

node_exe="${1:?usage: devnet-smoke.sh <path-to-ferminux-binary> [port]}"
port="${2:-8547}"

if [ ! -x "$node_exe" ]; then
  echo "'$node_exe' is not an executable file." >&2
  exit 1
fi
node_exe="$(cd "$(dirname "$node_exe")" && pwd)/$(basename "$node_exe")"

data_dir="$(mktemp -d -t fmx-devnet.XXXXXX)"
pid=""

cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$data_dir"
}
trap cleanup EXIT

block_number() {
  curl -fsS -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "http://127.0.0.1:$port" | sed -E 's/.*"result":"0x([0-9a-fA-F]*)".*/\1/'
}

hex_to_dec() {
  # An empty/zero-length hex string is height 0 (genesis).
  if [ -z "$1" ]; then echo 0; else echo $((16#$1)); fi
}

wait_for_rpc() {
  local timeout=30 waited=0 raw
  while [ "$waited" -lt "$timeout" ]; do
    if raw="$(block_number 2>/dev/null)"; then
      hex_to_dec "$raw"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "Node RPC on port $port did not answer within ${timeout}s." >&2
  return 1
}

start_node() {
  local log_suffix="$1"
  "$node_exe" \
    --dev --dev.period 1 \
    --datadir "$data_dir" \
    --http --http.addr 127.0.0.1 --http.port "$port" --http.api eth,net,web3 \
    --ipcdisable \
    --verbosity 2 \
    >"$data_dir/stdout-$log_suffix.log" 2>"$data_dir/stderr-$log_suffix.log" &
  pid=$!
}

stop_node() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  pid=""
}

on_fail() {
  echo "FAIL: $1" >&2
  for f in "$data_dir"/*.log; do
    [ -f "$f" ] || continue
    echo "--- $(basename "$f") ---" >&2
    tail -n 60 "$f" >&2 || true
  done
  exit 1
}

echo "==> Starting a throwaway --dev network (datadir: $data_dir)"
start_node "1"
height1="$(wait_for_rpc)" || on_fail "node never answered RPC"
echo "    initial height: $height1"
sleep 8
height2="$(hex_to_dec "$(block_number)")" || on_fail "node stopped answering RPC"
echo "    height after 8s: $height2"
stop_node
if [ "$height2" -le "$height1" ]; then
  on_fail "node did not produce new blocks (height stayed at $height1)"
fi
echo "OK: node produces blocks."

sleep 2

echo "==> Restarting against the same datadir to check it imports existing blocks"
start_node "2"
height3="$(wait_for_rpc)" || on_fail "node never answered RPC on restart"
echo "    height on restart: $height3"
stop_node
if [ "$height3" -lt "$height2" ]; then
  on_fail "node did not import its own chain data on restart (had $height2, now $height3)"
fi
echo "OK: node imports its previously produced blocks on restart."

echo "==> Devnet smoke test passed."
