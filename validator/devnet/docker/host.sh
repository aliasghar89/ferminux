#!/bin/bash
# One multi-seat host: a single ferminux node started by the operator, and SEATS
# fmx-validator instances attached to it over IPC (`init --node-ipc`), each with its own
# data directory, attester key, protection database and dashboard. The sidecars share the
# node's PID namespace, so each confirms the node's reorg cap from /proc. Runs as uid 10001.
# Env: HUB, BOOTNODES, NETRESTRICT, SEATS, FMX_PW.
set -uo pipefail
D=/data
IPC=$D/ferminux.ipc
umask 077
[ -d "$D/ferminux-geth/chaindata" ] || ferminux init --datadir "$D" /devnet/genesis.json
(
  while true; do
    ferminux --datadir "$D" --networkid 39619 --syncmode full --cache 256 --port 30303 --nat none \
      --netrestrict "$NETRESTRICT" --bootnodes "$BOOTNODES" --maxpeers 60 --ipcpath "$IPC" \
      --verbosity 3 >> "$D/node.log" 2>&1
    echo "node exited $? at $(date -u +%FT%TZ); restarting" >> "$D/node.log"; sleep 3
  done
) &
until [ -S "$IPC" ]; do sleep 1; done
for i in $(seq 1 "$SEATS"); do
  DD=/var/lib/fmx-validator/s$i
  N=$DD/devnet
  mkdir -p "$DD"
  [ -s "$DD/attester-password" ] || printf '%s' "$FMX_PW-s$i" > "$DD/attester-password"
  if [ ! -f "$N/config.json" ]; then
    fmx-validator init --network devnet --chain-id 39619 --data-dir "$DD" --node-ipc "$IPC" \
      --hub "$HUB" --password-file "$DD/attester-password" --dashboard "127.0.0.1:$((8570 + i))"
    jq '.minPeers = 3' "$N/config.json" > "$N/config.json.new" && mv "$N/config.json.new" "$N/config.json"
  fi
  [ -f "$N/keys/attester.json" ] || fmx-validator keys new --network devnet --data-dir "$DD" --password-file "$DD/attester-password"
  (
    # Memory: a sidecar opens its scrypt keystore once at start (N=2^18: 256 MiB) and the Go
    # runtime gives that back only at its first forced GC, about two minutes later (then it
    # runs at ~17 MB). Thirteen starting together on one small host would not fit, so the
    # host caps each sidecar's heap with the runtime's own soft limit. The node is a separate
    # process here and is not affected.
    export GOMEMLIMIT=96MiB
    while true; do
      fmx-validator run --network devnet --data-dir "$DD" >> "$DD/stdout.log" 2>&1
      echo "fmx-validator exited $? at $(date -u +%FT%TZ); restarting" >> "$DD/stdout.log"; sleep 3
    done
  ) &
  sleep 10   # stagger: each sidecar holds ~270 MB for two minutes after opening its keystore
done
wait
