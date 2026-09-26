#!/usr/bin/env bash
# Build the explorer (explorer/web at HEAD, unchanged) pointed at the devnet and render its validator
# pages: VITE_RPC = the devnet rpc node, VITE_VALIDATOR_HUB / _LENS = the devnet hub and lens. The build
# runs in a copy under build/explorer (the repo's own explorer/web/dist is never written).
#   explorer.sh <evidence subdir> <path> [path...]      e.g. explorer.sh explorer-seats /validators /validators/2
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT="$HERE/evidence/${1:?evidence subdir}"; shift
B="$HERE/build/explorer"
mkdir -p "$B"
rsync -a --delete --exclude node_modules --exclude dist --exclude test-results "$REPO/explorer/web/" "$B/"
ln -sfn "$REPO/explorer/web/node_modules" "$B/node_modules"
HUB=$(jq -r .validatorHub "$HERE/.run/deployments.json"); LENS=$(jq -r .validatorHubLens "$HERE/.run/deployments.json")
( cd "$B" && npx tsc --noEmit && VITE_RPC=http://127.0.0.1:39545 VITE_VALIDATOR_HUB="$HUB" VITE_VALIDATOR_HUB_LENS="$LENS" npx vite build >/dev/null )
test -s "$B/dist/validators.html" || { echo "build did not switch the validator pages on"; exit 1; }
echo "explorer built at $(git -C "$REPO" rev-parse --short HEAD) with VITE_RPC=http://127.0.0.1:39545 VITE_VALIDATOR_HUB=$HUB VITE_VALIDATOR_HUB_LENS=$LENS"
node "$HERE/explorer-check.mjs" "$B/dist" "$OUT" "$@"
