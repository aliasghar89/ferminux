#!/usr/bin/env bash
# The devnet's machines, in the colima-fmxdev docker context:
#   fmxd-sig1..3   the three signers (ferminux --mine, IPC only)
#   fmxd-rpc       a node with HTTP that confirms no blocks, published on the host at 127.0.0.1:39545 only
#   fmxd-v01..v12  twelve validator machines: fmx-validator supervising its own ferminux node
#   fmxd-h1, h2    two multi-seat hosts: one ferminux node and 11 / 13 fmx-validator instances
#                  attached to it over IPC
# All on the internal bridge network fmxdev (172.30.39.0/24), discovery restricted to it.
#
#   net.sh up | down | wipe | ps | heads | peers | v <nn> (start one validator machine)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export DOCKER_CONTEXT=${DOCKER_CONTEXT:-colima-fmxdev}
RUN="$HERE/.run"
. "$RUN/devnet.env"
IMG=fmxdev:latest
NET=fmxdev
SUB=172.30.39
NETRESTRICT=$SUB.0/24

# fixed node keys for the signers and the rpc node, so every node can be given their enodes
if [ ! -s "$RUN/nodekeys.env" ]; then
  umask 077
  for n in sig1 sig2 sig3 rpc; do
    k=$(openssl rand -hex 32)
    echo "NK_$n=$k"
    echo "NP_$n=$(cast wallet public-key --raw-private-key "0x$k" | sed 's/^0x//')"
  done > "$RUN/nodekeys.env"
fi
. "$RUN/nodekeys.env"
ip_of() { case $1 in sig1) echo $SUB.11;; sig2) echo $SUB.12;; sig3) echo $SUB.13;; rpc) echo $SUB.20;;
                      h1) echo $SUB.121;; h2) echo $SUB.122;; v05b) echo $SUB.131;;
                      v[0-9][0-9]) echo "$SUB.$((100 + 10#${1#v}))";; esac; }
enode() { eval "echo enode://\$NP_$1@$(ip_of "$1"):30303"; }
BOOTNODES="$(enode sig1),$(enode sig2),$(enode sig3),$(enode rpc)"
HUB=${HUB:-$(jq -r .validatorHub "$RUN/deployments.json" 2>/dev/null || true)}

# remove a container, stopping it gracefully first: a node killed outright loses its recent
# state and rewinds, and a signer rewound that way confirms a stale block at startup
gone() { docker stop -t 60 "$1" >/dev/null 2>&1 || true; docker rm "$1" >/dev/null 2>&1 || true; }
net_up() {
  docker network inspect $NET >/dev/null 2>&1 || docker network create --subnet $SUB.0/24 $NET >/dev/null
}
node_run() { # name role [extra docker args]
  local n=$1 role=$2; shift 2
  gone "fmxd-$n"
  docker run -d --name "fmxd-$n" --hostname "$n" --network $NET --ip "$(ip_of "$n")" --user 10001:10001 \
    --restart unless-stopped --init -v "fmxd-$n:/data" \
    -e ROLE="$role" -e NODEKEY="$(eval echo \$NK_$n)" -e BOOTNODES="$BOOTNODES" -e NETRESTRICT="$NETRESTRICT" \
    "$@" "$IMG" /devnet/node.sh >/dev/null
  echo "fmxd-$n ($role) up at $(ip_of "$n")"
}
validator_run() { # vNN
  local n=$1
  [ -n "$HUB" ] || { echo "no hub yet (.run/deployments.json)"; exit 1; }
  gone "fmxd-$n"
  docker run -d --name "fmxd-$n" --hostname "$n" --network $NET --ip "$(ip_of "$n")" --user 10001:10001 \
    --restart unless-stopped --init -v "fmxd-$n:/var/lib/fmx-validator" \
    -e HUB="$HUB" -e BOOTNODES="$BOOTNODES" -e NETRESTRICT="$NETRESTRICT" -e FMX_PW="devnet-$n-pass" \
    "$IMG" /devnet/validator.sh >/dev/null
  echo "fmxd-$n (fmx-validator, supervised node) up at $(ip_of "$n")"
}
host_run() { # hN seats
  local n=$1 seats=$2
  [ -n "$HUB" ] || { echo "no hub yet (.run/deployments.json)"; exit 1; }
  gone "fmxd-$n"
  docker run -d --name "fmxd-$n" --hostname "$n" --network $NET --ip "$(ip_of "$n")" --user 10001:10001 \
    --restart unless-stopped --init -v "fmxd-$n-node:/data" -v "fmxd-$n:/var/lib/fmx-validator" \
    -e HUB="$HUB" -e BOOTNODES="$BOOTNODES" -e NETRESTRICT="$NETRESTRICT" -e FMX_PW="devnet-$n-pass" -e SEATS="$seats" \
    "$IMG" /devnet/host.sh >/dev/null
  echo "fmxd-$n (node + $seats fmx-validator instances over IPC) up at $(ip_of "$n")"
}
q() { docker exec "fmxd-$1" ferminux attach --exec "$2" /data/ferminux.ipc 2>/dev/null | tr -d '"'; }

case "${1:-}" in
  up)
    net_up
    for s in 1 2 3; do node_run "sig$s" signer -e SIGNER_ADDR="$(eval echo \$SIGNER$s)" -e SIGNER_PK="$(eval echo \$SIGNER${s}_PK)"; done
    node_run rpc rpc -p 127.0.0.1:39545:8545 ;;
  validators)
    # staggered: a sidecar holds ~270 MB for its first two minutes (the scrypt keystore is
    # opened once; the Go runtime hands the memory back at its first forced GC), so 36 at
    # once would not fit the devnet VM
    host_run h1 11; sleep 20; host_run h2 13
    for i in $(seq -w 1 12); do sleep 20; validator_run "v$i"; done ;;
  v) validator_run "v$2" ;;
  h) host_run "$2" "$3" ;;
  down) docker ps -a --format '{{.Names}}' | grep '^fmxd-' | xargs -r docker stop -t 30 ;;
  wipe)
    docker ps -a --format '{{.Names}}' | grep '^fmxd-' | xargs -r docker rm -f  # wipe: the data goes too
    docker volume ls -q | grep '^fmxd-' | xargs -r docker volume rm >/dev/null
    docker network rm $NET >/dev/null 2>&1 || true
    rm -rf "$RUN/steps" "$RUN/state.env" "$RUN/deployments.json" "$RUN/genesis.json" "$RUN/attesters.txt" "$RUN/seatmap.txt" "$RUN"/ks-* "$RUN"/pw-*
    echo "wiped; run build.sh for a fresh genesis" ;;
  ps) docker ps -a --filter name=fmxd- --format 'table {{.Names}}\t{{.Status}}' ;;
  heads)
    for n in sig1 sig2 sig3 rpc; do echo "$n $(q $n 'eth.blockNumber + " " + eth.getBlock("latest").hash + " peers=" + net.peerCount')"; done ;;
  enodes) echo "$BOOTNODES" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
