#!/bin/bash
# One validator machine: fmx-validator supervising its own ferminux node, the way the
# Linux package runs it (packaging/linux/install.sh: `install --node-path ... --password-file`),
# with the devnet chain id. Runs as uid 10001 (the service user). Env: HUB, BOOTNODES,
# NETRESTRICT, FMX_PW (this machine's keystore password, devnet only).
set -euo pipefail
DD=/var/lib/fmx-validator
N=$DD/devnet
PW=$DD/attester-password
umask 077
[ -s "$PW" ] || printf '%s' "$FMX_PW" > "$PW"
if [ ! -f "$N/config.json" ]; then
  fmx-validator init --network devnet --chain-id 39619 --data-dir "$DD" \
    --node-path /usr/local/bin/ferminux --hub "$HUB" --password-file "$PW" --dashboard 127.0.0.1:8570
  # the mainnet readiness floor (3 peers) instead of the devnet preset's 0, and the devnet bootnodes
  ea=$(jq -nc --arg b "$BOOTNODES" --arg n "$NETRESTRICT" '["--bootnodes",$b,"--netrestrict",$n]')
  jq --argjson ea "$ea" '.minPeers = 3 | .node.extraArgs = $ea' "$N/config.json" > "$N/config.json.new"
  mv "$N/config.json.new" "$N/config.json"
fi
[ -d "$N/node/ferminux-geth/chaindata" ] || ferminux init --datadir "$N/node" /devnet/genesis.json
[ -f "$N/keys/attester.json" ] || fmx-validator keys new --network devnet --data-dir "$DD" --password-file "$PW"
exec fmx-validator run --network devnet --data-dir "$DD"
