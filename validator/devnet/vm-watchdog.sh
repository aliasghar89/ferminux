#!/usr/bin/env bash
# Keeps the devnet's own colima VM (profile fmxdev) running for the length of the run. The VM has
# been stopped from outside (SIGINT to every lima host agent on the Mac, the default profile too);
# when that happens this waits a minute, starts fmxdev again (never any other profile), puts the
# Docker CLI's current context back to "default" so no other tool lands on the devnet VM by
# accident, and brings the single-seat machines back 20 s apart as run.sh does. Each restart is
# written to evidence/01-network.log.
#   nohup ./vm-watchdog.sh >> .run/watchdog.log 2>&1 &
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export DOCKER_CONTEXT=colima-fmxdev
running() { colima list 2>/dev/null | awk '$1=="fmxdev"{print $2}' | grep -q Running; }
while :; do
  if ! running; then
    t0=$(date -u +%FT%TZ)
    sleep 60
    if ! running; then
      echo "$(date -u +%FT%TZ) fmxdev found stopped (first seen $t0); starting it"
      colima start --profile fmxdev >> "$HERE/.run/colima-start.log" 2>&1
      docker context use default >/dev/null 2>&1 || true
      # the single-seat machines come back 20 s apart (a sidecar holds ~270 MB for two minutes after start)
      for c in $(docker ps --format '{{.Names}}' | grep -E '^fmxd-v'); do docker stop -t 60 "$c" >/dev/null & done; wait
      sleep 20
      for m in v04 v05 v07 v08 v09 v10 v11 v12 v01; do docker start "fmxd-$m" >/dev/null 2>&1; sleep 20; done
      b=$(cast block-number --rpc-url http://127.0.0.1:39545 2>/dev/null)
      printf '\n## stopped from outside again (first seen stopped %s); fmxdev started again by vm-watchdog.sh at %s, head %s\n' \
        "$t0" "$(date -u +%FT%TZ)" "$b" >> "$HERE/evidence/01-network.log"
      echo "$(date -u +%FT%TZ) back, head $b"
    fi
  fi
  sleep 60
done
