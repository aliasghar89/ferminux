#!/usr/bin/env bash
# Build the devnet image from the repo at HEAD:
#   ferminux      chain/ at HEAD + patch-devnet-params.py (devnet signers/owners/sink,
#                 1 s period), built like the release: CGO_ENABLED=0 GOTOOLCHAIN=go1.20.14
#                 go build -tags netgo,osusergo -trimpath ./cmd/ferminux (GOARCH=arm64: the
#                 devnet runs in colima on Apple silicon)
#   fmx-validator validator/ at HEAD, the release build (make cross: CGO_ENABLED=0, -trimpath)
# and the devnet genesis (chain id 39619, posaBlock 1). Output: image fmxdev:latest in the
# colima-fmxdev docker context, and evidence/00-build.log.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export DOCKER_CONTEXT=${DOCKER_CONTEXT:-colima-fmxdev}
. "$HERE/.run/devnet.env"
B="$HERE/build"
EV="$HERE/evidence/00-build.log"
rm -rf "$B"; mkdir -p "$B/img"
exec > >(tee "$EV") 2>&1
echo "# devnet build $(date -u +%FT%TZ)"
echo "repo HEAD: $(git -C "$REPO" rev-parse HEAD)"
echo "chain/ and validator/ changed files vs HEAD: $(git -C "$REPO" status --porcelain chain validator | grep -v '^?? validator/devnet/' | wc -l | tr -d ' ')"

# ---- node: HEAD source, devnet params
rsync -a --exclude build/bin --exclude .git "$REPO/chain/" "$B/chain/"
python3 "$HERE/patch-devnet-params.py" "$B/chain" "$HERE/.run/devnet.env"
echo "--- params diff (the only source change):"
( cd "$B" && diff -u "$REPO/chain/params/ferminux.go" chain/params/ferminux.go | sed -E 's#^(\+\+\+|---) [^ ]*/(chain/params/ferminux.go).*#\1 \2#' ) || true
echo "--- toolchain: $(cd "$B/chain" && GOTOOLCHAIN=go1.20.14 go version)"
( cd "$B/chain" && CGO_ENABLED=0 GOTOOLCHAIN=go1.20.14 GOOS=linux GOARCH=arm64 \
    go build -tags netgo,osusergo -trimpath -o "$B/img/ferminux" ./cmd/ferminux )

# ---- sidecar: HEAD source, unchanged
( cd "$REPO/validator" && CGO_ENABLED=0 GOTOOLCHAIN=go1.20.14 GOOS=linux GOARCH=arm64 \
    go build -trimpath -ldflags "-s -w -X main.version=$(git -C "$REPO" describe --tags --always)" \
    -o "$B/img/fmx-validator" ./cmd/fmx-validator )
echo "--- sha256"
( cd "$B/img" && shasum -a 256 ferminux fmx-validator )

# ---- genesis: chain id 39619, authority from block 1, 100M gas, the funder holds the premine
# (made once per devnet: .run/genesis.json is reused by every rebuild until net.sh wipe)
if [ -s "$HERE/.run/genesis.json" ]; then cp "$HERE/.run/genesis.json" "$B/img/genesis.json"; else
python3 - "$B/img/genesis.json" <<EOF
import json, sys, time
g = {
  "config": {"chainId": 39619, "homesteadBlock": 0, "eip150Block": 0, "eip155Block": 0, "eip158Block": 0,
             "byzantiumBlock": 0, "constantinopleBlock": 0, "petersburgBlock": 0, "istanbulBlock": 0,
             "muirGlacierBlock": 0, "berlinBlock": 0, "londonBlock": 0, "posaBlock": 1, "ethash": {}},
  "nonce": "0x0", "timestamp": hex(int(time.time())),
  "extraData": "0x" + b"Ferminux validator devnet 39619".hex(),
  "gasLimit": hex(100_000_000), "difficulty": "0x1", "baseFeePerGas": hex(1_000_000_000),
  "mixHash": "0x" + "00" * 32, "coinbase": "0x" + "00" * 20,
  "alloc": {"$FUNDER": {"balance": str(10_000_000 * 10**18)}},
}
json.dump(g, open(sys.argv[1], "w"), indent=1)
EOF
cp "$B/img/genesis.json" "$HERE/.run/genesis.json"; fi
cp "$HERE"/docker/*.sh "$B/img/"
cat > "$B/img/Dockerfile" <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache bash curl jq procps && adduser -D -u 10001 fmx \
 && mkdir -p /data /var/lib/fmx-validator && chown 10001:10001 /data /var/lib/fmx-validator
COPY ferminux fmx-validator /usr/local/bin/
COPY genesis.json /devnet/genesis.json
COPY *.sh /devnet/
RUN chmod 0755 /devnet/*.sh
EOF
docker build -q -t fmxdev:latest "$B/img"
echo "--- image fmxdev:latest built ($(docker image inspect fmxdev:latest -f '{{.Id}}'))"
docker run --rm fmxdev:latest ferminux version | sed -n '1,4p'
docker run --rm fmxdev:latest fmx-validator version
echo "--- genesis hash (fresh init):"
docker run --rm fmxdev:latest sh -c 'ferminux init --datadir /tmp/d /devnet/genesis.json 2>&1 | grep -E "Successfully wrote genesis|hash=" | tail -2'
