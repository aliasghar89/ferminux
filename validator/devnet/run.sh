#!/usr/bin/env bash
# Start the devnet from nothing and hand over to driver.sh, detached (it runs for about 48 h):
#   keys.sh (once) -> build.sh -> net.sh up -> driver.sh (nohup, with caffeinate so the Mac stays awake)
# Progress: tail -f .run/driver.out ; evidence: evidence/*.log
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
export DOCKER_CONTEXT=${DOCKER_CONTEXT:-colima-fmxdev}
[ -s .run/devnet.env ] || ./keys.sh
[ -f .run/steps/deploy.done ] || {
  [ -s build/img/ferminux ] || ./build.sh
  EV=evidence/01-network.log
  {
    echo "# devnet up $(date -u +%FT%TZ)"
    ./net.sh up
    sleep 30
    echo "--- heads (block, hash, peers):"; ./net.sh heads
    echo "--- engine:"
    docker logs fmxd-sig1 2>&1 | grep -E "proof-of-authority engine armed|Initialised chain configuration|Chain ID|authority fork" | head -4
    echo "--- signer command line (the mainnet signer unit's flags; IPC only, no HTTP):"
    docker exec fmxd-sig1 sh -c 'tr "\0" " " < /proc/$(pgrep -o -f "ferminux --datadir")/cmdline' | sed -E 's/--nodekeyhex [0-9a-f]+/--nodekeyhex <devnet>/; s/--bootnodes [^ ]+/--bootnodes <sig1,sig2,sig3,rpc>/'
    echo; echo "--- clique signers at head:"
    docker exec fmxd-sig1 ferminux attach --exec 'clique.getSigners()' /data/ferminux.ipc
    echo "--- 20 consecutive blocks (number, time, signer):"
    docker exec fmxd-rpc ferminux attach --exec 'var h=eth.blockNumber, o=[]; for (var i=h-19;i<=h;i++){var b=eth.getBlock(i); o.push(i+" "+b.timestamp+" "+clique.getSigner(b.hash))}; o.join("\n")' /data/ferminux.ipc | tr -d '"' | sed 's/\\n/\n/g'
  } 2>&1 | tee "$EV"
}
# own session, so it outlives the shell that started it
nohup python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' ./driver.sh >> .run/driver.out 2>&1 &
DPID=$!
echo "$DPID" > .run/driver.pid
nohup caffeinate -dimsu -w "$DPID" >/dev/null 2>&1 &
echo "driver running (pid $DPID); tail -f $HERE/.run/driver.out"
