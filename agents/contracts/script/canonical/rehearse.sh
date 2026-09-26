#!/usr/bin/env bash
#
# rehearse.sh — dress rehearsal of deploy.sh on an anvil fork of chain 3961.
#
#   ./rehearse.sh            (needs anvil, cast, forge, jq, python3)
#
# 1. forks the live chain with the London rule set, WITHOUT anvil's built-in
#    CREATE2 deployer, so the fork starts exactly as mainnet is today;
# 2. makes a fresh gas account and gives it exactly what `deploy.sh plan`
#    says it must hold up front, nothing more;
# 3. runs `deploy.sh apply`, then runs it again (must be a no-op);
# 4. runs verify.sh (code hashes, opcode scan, behaviour reads);
# 5. runs CanonicalSmoke.s.sol (Permit2 transfers, a Safe executing a signed
#    batch, a user operation through each EntryPoint).
# Nothing touches mainnet: the fork only reads from FORK_URL.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT=$(cd "$HERE/../.." && pwd)   # agents/contracts
FORK_URL=${FORK_URL:-https://rpc.ferminux.net}
PORT=${PORT:-8547}
RPC=http://127.0.0.1:$PORT
WORK=$(mktemp -d)
# anvil's well-known test keys (funded only on the local fork)
FUNDER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SPENDER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

anvil --fork-url "$FORK_URL" --hardfork london --chain-id 3961 --no-create2 \
  --host 127.0.0.1 --port "$PORT" >"$WORK/anvil.log" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true; rm -rf "$WORK"' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
INFO=$(cast rpc anvil_nodeInfo --rpc-url "$RPC")
echo "== anvil fork of $FORK_URL at block $(jq -r .forkConfig.forkBlockNumber <<<"$INFO"), hardfork $(jq -r .hardFork <<<"$INFO")"
[ "$(jq -r .hardFork <<<"$INFO")" = London ] || { echo "anvil is not running London"; exit 1; }

KEY=$(cast wallet new --json | jq -r '.[0].private_key')
DEPLOYER=$(cast wallet address --private-key "$KEY")
export RPC_URL=$RPC DEPLOYER

echo ""
echo "== plan (fresh deployer $DEPLOYER, empty)"
PLAN=$("$HERE/deploy.sh" plan)
echo "$PLAN"
RESERVE=$(sed -n 's/^reserve_wei=\([0-9]*\).*/\1/p' <<<"$PLAN")
[ -n "$RESERVE" ] && [ "$RESERVE" != 0 ] || { echo "plan found nothing to deploy"; exit 1; }
cast send "$DEPLOYER" --value "$RESERVE" --private-key "$FUNDER_PK" --rpc-url "$RPC" >/dev/null
echo "funded deployer with exactly $(cast from-wei "$RESERVE") FMX"

echo ""
echo "== apply"
SIGNER="--private-key $KEY" CONFIRM=deploy-canonical-3961 "$HERE/deploy.sh" apply

echo ""
echo "== apply again (must change nothing)"
AGAIN=$(SIGNER="--private-key $KEY" CONFIRM=deploy-canonical-3961 "$HERE/deploy.sh" apply)
echo "$AGAIN" | tail -2
grep -q "nothing to do" <<<"$AGAIN" || { echo "second apply was not a no-op"; exit 1; }

echo ""
echo "== verify"
"$HERE/verify.sh"

echo ""
echo "== functional smoke"
(cd "$PROJECT" && SMOKE_OWNER_PK=$FUNDER_PK SMOKE_SPENDER_PK=$SPENDER_PK \
  FOUNDRY_OUT="$WORK/out" FOUNDRY_CACHE_PATH="$WORK/cache" FOUNDRY_BROADCAST="$WORK/broadcast" \
  forge script script/canonical/CanonicalSmoke.s.sol:CanonicalSmoke --rpc-url "$RPC" --broadcast --slow 2>&1 \
  | grep -E "ok|SMOKE|Error|error|FAIL|revert" )
RUN="$WORK/broadcast/CanonicalSmoke.s.sol/3961/run-latest.json"
TOTAL=$(jq '.receipts | length' "$RUN"); OK=$(jq '[.receipts[] | select(.status == "0x1")] | length' "$RUN")
echo "smoke transactions in blocks: $OK/$TOTAL succeeded"
[ "$OK" = "$TOTAL" ] || exit 1

echo ""
echo "REHEARSAL PASSED"
