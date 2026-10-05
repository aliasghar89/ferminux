#!/usr/bin/env bash
# Smoke-test the packages build.sh made, in throwaway Docker containers, on a
# build machine that is neither Windows nor a systemd host.
#
#   validator/packaging/release/smoke-docker.sh <dist dir>
#
# Linux (each tarball in <dist dir>), in a Debian 12 container running systemd:
#   - both programs start and print their versions
#   - the node has the Ferminux genesis: block 0 hash and chain id 3961, read offline
#   - validator/packaging/ci/devnet-smoke.sh: the node confirms blocks on a --dev network
#     and re-imports them after a restart
#   - validator/packaging/ci/linux-install-smoke.sh: install.sh, the systemd unit, a
#     devnet service start with the password through LoadCredential=, a failed start
#     that says why, uninstall.sh
#   A tarball for another CPU than the Docker host's runs through the host's binfmt
#   emulation (qemu); that is slower but runs the same binaries.
#
# Windows (the zip), under Wine 8 in a linux/amd64 Debian 12 container:
#   - ferminux.exe prints its version, has the Ferminux genesis (offline) and passes
#     devnet-smoke.sh, so the cgo build's secp256k1 signs and verifies blocks
#   - fmx-validator.exe prints its version
#   Wine is not Windows: services, DPAPI, ACLs and the installer are not exercised
#   here. validator/packaging/WINDOWS-TEST.md on a real PC is the Windows test.
#   Under Wine on qemu emulation, programs linked by Go's own linker (the sidecar, and
#   a plain Go hello-world just the same) often fail to start with "wine: failed to
#   start", so the sidecar gets up to 12 attempts; the cgo-linked node does not do this.
#
# Nothing here joins chain 3961 or any public network: the genesis check runs with
# --nodiscover --maxpeers 0 --nat none, the --dev networks have no p2p at all, and the
# packaging smoke registers the mainnet service without starting it and keeps the
# service on localhost while it runs install.sh again.
#
# The containers start from digest-pinned Debian images and install what they need
# themselves: no image is built or tagged, and removing the containers at the end
# leaves nothing behind but the two pulled base images. The node runs with
# --datadir.minfreedisk 0 because a Docker VM's disk can be below the node's low-disk
# guard; these runs write a few megabytes.
# Uses the current Docker context (set DOCKER_CONTEXT to pick another).
set -euo pipefail

DIST="${1:?usage: smoke-docker.sh <dist dir>}"
DIST="$(cd "$DIST" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI="$(cd "$HERE/../ci" && pwd)"
# debian:bookworm and debian:bookworm-slim (multi-platform indexes) as of 2026-09-26
DEBIAN="${SMOKE_DEBIAN:-debian@sha256:f37a335e82bca302e955fa39f9dfe28f1be618f016f8a2b56318e5a5111afc26}"
DEBIAN_SLIM="${SMOKE_DEBIAN_SLIM:-debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251}"
GENESIS="0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf chain 0xf79"
OFFLINE="--nodiscover --maxpeers 0 --nat none --ipcdisable --verbosity 2"
GENESIS_JS='eth.getBlock(0).hash + " chain " + eth.chainId()'

say() { printf '\n==> %s\n' "$*"; }
die() { echo "FAIL: $*" >&2; exit 1; }
containers=()
cleanup() { for c in ${containers[@]+"${containers[@]}"}; do docker rm -f "$c" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker not found"
echo "docker context: $(docker context show 2>/dev/null || echo default)"
( cd "$DIST" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi ) ||
  die "the archives do not match SHA256SUMS"

# wrapper <container> <path of the node program> <wrapper path> [loader]
wrapper() {
  docker exec "$1" sh -c "printf '#!/bin/sh\nexec $4 $2 --datadir.minfreedisk 0 \"\$@\"\n' > $3 && chmod +x $3"
}
genesis_check() { # genesis_check <container> <node wrapper> <datadir> <label>
  local got
  got="$(docker exec "$1" sh -c "$2 --datadir '$3' $OFFLINE --exec '$GENESIS_JS' console 2>/dev/null" | tr -d '"\r' | grep '^0x' || true)"
  [ "$got" = "$GENESIS" ] || die "$4 genesis check printed '$got'"
  echo "OK: genesis $got"
}

# ------------------------------------------------------------------ Linux
host_arch="$(docker version -f '{{.Server.Arch}}')"
for arch in amd64 arm64; do
  name="ferminux-validator-linux-$arch"
  [ -f "$DIST/$name.tar.gz" ] || die "$DIST/$name.tar.gz is missing"
  c="fmx-validator-smoke-linux-$arch"
  say "Linux $arch: $name.tar.gz in a systemd container (linux/$host_arch)"
  docker rm -f "$c" >/dev/null 2>&1 || true
  containers+=("$c")
  docker run -d --name "$c" --platform "linux/$host_arch" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock --stop-signal SIGRTMIN+3 "$DEBIAN" bash -c '
      set -e
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        systemd systemd-sysv dbus procps curl ca-certificates passwd >/dev/null
      systemctl mask getty@tty1.service console-getty.service systemd-logind.service >/dev/null 2>&1 || true
      # Docker makes / a private mount. systemd moves the LoadCredential= ramfs of a unit
      # into place from a helper namespace, which only reaches the service when / is
      # shared, as it is on any systemd host; without this the credential is empty here.
      mount --make-rshared /
      exec /lib/systemd/systemd' >/dev/null
  state=""
  for _ in $(seq 1 300); do
    state="$(docker exec "$c" sh -c 'command -v systemctl >/dev/null && systemctl is-system-running 2>/dev/null' || true)"
    case "$state" in running|degraded) break ;; esac
    sleep 1
  done
  case "$state" in running|degraded) echo "systemd: $state" ;; *) docker logs "$c" 2>&1 | tail -20; die "systemd did not come up ($state)" ;; esac

  docker exec "$c" mkdir -p /smoke
  docker cp "$DIST/$name.tar.gz" "$c:/smoke/"
  docker cp "$CI/devnet-smoke.sh" "$c:/smoke/"
  docker cp "$CI/linux-install-smoke.sh" "$c:/smoke/"
  docker exec -w /smoke "$c" tar xzf "$name.tar.gz"
  rel="/smoke/$name"
  wrapper "$c" "$rel/ferminux" /smoke/ferminux-smoke ""

  docker exec "$c" "$rel/ferminux" version | sed -n '1,7p'
  docker exec "$c" "$rel/fmx-validator" version
  genesis_check "$c" /smoke/ferminux-smoke /tmp/genesis-check "linux/$arch"
  docker exec "$c" bash /smoke/devnet-smoke.sh /smoke/ferminux-smoke
  docker exec "$c" bash /smoke/linux-install-smoke.sh "$rel"
  docker rm -f "$c" >/dev/null
done

# ------------------------------------------------------------------ Windows (Wine)
zip="$DIST/ferminux-validator-windows-amd64.zip"
[ -f "$zip" ] || die "$zip is missing"
c="fmx-validator-smoke-wine"
say "Windows: ferminux-validator-windows-amd64.zip under Wine (linux/amd64)"
docker rm -f "$c" >/dev/null 2>&1 || true
containers+=("$c")
docker run -d --name "$c" --platform linux/amd64 -e WINEDEBUG=-all "$DEBIAN_SLIM" sleep 7200 >/dev/null
echo "installing Wine in the container (slow under emulation)"
docker exec "$c" sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends wine64 unzip curl ca-certificates >/dev/null'
WINE=/usr/lib/wine/wine64
docker exec "$c" mkdir -p /smoke
docker cp "$zip" "$c:/smoke/"
docker cp "$CI/devnet-smoke.sh" "$c:/smoke/"
docker exec -w /smoke "$c" unzip -q ferminux-validator-windows-amd64.zip -d win
docker exec "$c" sh -c "$WINE wineboot -i >/dev/null 2>&1 || true"
docker exec -d "$c" /usr/lib/wine/wineserver -p
sleep 2
wrapper "$c" /smoke/win/ferminux.exe /smoke/ferminux-wine "$WINE"

out="$(docker exec "$c" /smoke/ferminux-wine version 2>/dev/null | tr -d '\r')"
echo "$out" | sed -n '1,7p'
grep -q '^Operating System: windows' <<<"$out" || die "ferminux.exe version did not run"
genesis_check "$c" /smoke/ferminux-wine 'C:\genesis-check' "windows/amd64"
docker exec "$c" bash /smoke/devnet-smoke.sh /smoke/ferminux-wine

ok=""
for i in $(seq 1 12); do
  if v="$(docker exec -w /smoke/win "$c" $WINE fmx-validator.exe version 2>/dev/null | tr -d '\r')" &&
     grep -q '^fmx-validator ' <<<"$v"; then ok="$v (attempt $i of 12)"; break; fi
done
[ -n "$ok" ] || die "fmx-validator.exe did not start under Wine in 12 attempts"
echo "OK: $ok"

say "Smoke tests passed: Linux amd64 and arm64 packages under systemd; the Windows node and sidecar under Wine."
