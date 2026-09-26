#!/bin/bash
# Devnet ferminux node (a signer or the public-style rpc node). Runs as uid 10001.
#   ROLE=signer: SIGNER_ADDR, SIGNER_PK (devnet key, imported once into the keystore),
#                confirming blocks with the mainnet signer unit's flags: IPC only, --mine,
#                --miner.threads=-1, --miner.gaslimit 100000000, etherbase = own address.
#   ROLE=rpc:    HTTP on the container address (published to the host's 127.0.0.1 only),
#                archive, no keys.
# Common: NODEKEY (fixed, so enodes are known), BOOTNODES, NETRESTRICT.
set -euo pipefail
D=/data
if [ ! -d "$D/ferminux-geth/chaindata" ]; then
  ferminux init --datadir "$D" /devnet/genesis.json
fi
COMMON=(--datadir "$D" --networkid 39619 --syncmode full --port 30303 --nat none
        --netrestrict "$NETRESTRICT" --bootnodes "$BOOTNODES" --nodekeyhex "$NODEKEY"
        --maxpeers 60 --ipcpath "$D/ferminux.ipc" --verbosity 3)
case "$ROLE" in
  signer)
    if ! ls "$D/keystore"/UTC--* >/dev/null 2>&1; then
      umask 077
      printf '%s' "devnet-signer" > "$D/password"
      printf '%s' "${SIGNER_PK#0x}" > /tmp/k && ferminux account import --datadir "$D" --password "$D/password" /tmp/k && rm -f /tmp/k
    fi
    exec ferminux "${COMMON[@]}" --unlock "$SIGNER_ADDR" --password "$D/password" \
      --miner.etherbase "$SIGNER_ADDR" --miner.extradata "fmxdev-$HOSTNAME" --miner.gaslimit 100000000 \
      --mine --miner.threads=-1 ;;
  rpc)
    exec ferminux "${COMMON[@]}" --gcmode archive \
      --http --http.addr 0.0.0.0 --http.port 8545 --http.api eth,net,web3,clique,txpool \
      --http.vhosts '*' --http.corsdomain '*' ;;
  *) echo "ROLE must be signer or rpc" >&2; exit 2 ;;
esac
