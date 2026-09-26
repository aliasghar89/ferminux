#!/usr/bin/env bash
#
# deploy.sh — put the standard shared contracts on chain 3961 at their
# canonical addresses, skipping any that are already there.
#
#   ./deploy.sh plan     read-only: what is deployed, what is missing, exact cost
#   ./deploy.sh apply    deploy whatever is missing (needs CONFIRM, see below)
#
# What it deploys (manifest.json, artifacts/):
#   1. Deterministic CREATE2 deployer 0x4e59…956C   presigned keyless tx
#   2. Multicall3                     0xcA11…CA11   presigned keyless tx
#   3. Permit2, Safe 1.3.0 (9 contracts), EntryPoint v0.6 and v0.7
#                                     through the CREATE2 deployer, with the
#                                     same salt and initcode as their original
#                                     deployments (Ethereum mainnet, BNB Chain, ...)
#
# Environment:
#   RPC_URL              chain RPC (default https://rpc.ferminux.net)
#   UNPROTECTED_RPC_URL  an RPC that accepts pre-EIP-155 transactions, used only
#                        for the two presigned keyless transactions (default:
#                        RPC_URL). Our nodes refuse them by default; README.md
#                        "Broadcasting the keyless transactions" says how to
#                        stand up a short-lived local relay for this.
#   DEPLOYER             address of the funded gas account (plan and apply)
#   SIGNER               cast wallet options for that account (apply only), e.g.
#                        "--account ops-deployer --password-file ~/.pw" or "--ledger"
#   CONFIRM              must be "deploy-canonical-<chainid>" for apply
#   EXPECTED_CHAIN_ID    default 3961
#   PRIORITY_FEE         tip in wei (default 1000000000 = 1 gwei)
#   MAX_FEE              max fee per gas in wei (default 2000000000 = 2 gwei)
#
# Exit status: 0 when everything in the manifest is (now) deployed and matches
# its canonical code hash; non-zero on any failure. Nothing is sent in plan mode.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST="$HERE/manifest.json"
MODE=${1:-plan}
RPC_URL=${RPC_URL:-https://rpc.ferminux.net}
UNPROTECTED_RPC_URL=${UNPROTECTED_RPC_URL:-$RPC_URL}
EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-3961}
PRIORITY_FEE=${PRIORITY_FEE:-1000000000}
MAX_FEE=${MAX_FEE:-2000000000}
RECEIPT_TIMEOUT=${RECEIPT_TIMEOUT:-300}
FUND_GAS=21000
EMPTY_CODEHASH=0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470

for bin in cast jq python3; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 2; }
done
case "$MODE" in plan|apply) ;; *) echo "usage: $0 plan|apply" >&2; exit 2 ;; esac

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
fmx()  { cast from-wei "$1" ether; }
add()  { python3 -c 'import sys; print(sum(int(a) for a in sys.argv[1:]))' "$@"; }
mul()  { python3 -c 'import sys; print(int(sys.argv[1]) * int(sys.argv[2]))' "$1" "$2"; }
sub0() { python3 -c 'import sys; print(max(0, int(sys.argv[1]) - int(sys.argv[2])))' "$1" "$2"; }
lt()   { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) < int(sys.argv[2]) else 1)' "$1" "$2"; }
lower(){ tr 'A-F' 'a-f' <<<"$1"; }
mf()   { jq -r "$1" "$MANIFEST"; }

codehash() {  # address -> keccak of runtime code (EMPTY_CODEHASH when none)
  local code; code=$(cast code "$1" --rpc-url "$RPC_URL")
  if [ "$code" = "0x" ]; then echo "$EMPTY_CODEHASH"; else cast keccak "$code"; fi
}

# state <address> <expected codehash>  ->  deployed | missing | CONFLICT
state() {
  local h; h=$(codehash "$1")
  if [ "$h" = "$EMPTY_CODEHASH" ]; then echo missing
  elif [ "$(lower "$h")" = "$(lower "$2")" ]; then echo deployed
  else echo CONFLICT; fi
}

wait_receipt() {  # tx hash -> prints receipt JSON once it is in a block, via RPC_URL
  local hash=$1 waited=0 r
  while :; do
    r=$(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$RPC_URL" 2>/dev/null || echo null)
    if [ -n "$r" ] && [ "$r" != "null" ]; then echo "$r"; return 0; fi
    [ "$waited" -ge "$RECEIPT_TIMEOUT" ] && return 1
    sleep 3; waited=$((waited + 3))
  done
}

# ---------------------------------------------------------------- preflight --
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
[ "$CHAIN_ID" = "$EXPECTED_CHAIN_ID" ] || die "RPC_URL is chain $CHAIN_ID, expected $EXPECTED_CHAIN_ID"
if [ "$UNPROTECTED_RPC_URL" != "$RPC_URL" ]; then
  UCHAIN=$(cast chain-id --rpc-url "$UNPROTECTED_RPC_URL")
  [ "$UCHAIN" = "$CHAIN_ID" ] || die "UNPROTECTED_RPC_URL is chain $UCHAIN, expected $CHAIN_ID"
fi
[ -n "${DEPLOYER:-}" ] || die "set DEPLOYER to the funded gas account's address"
DEPLOYER=$(cast to-check-sum-address "$DEPLOYER")
BASEFEE=$(cast base-fee --rpc-url "$RPC_URL")
lt "$BASEFEE" "$MAX_FEE" || die "base fee $BASEFEE wei is not below MAX_FEE $MAX_FEE wei; raise MAX_FEE"
EFFECTIVE=$(add "$BASEFEE" "$PRIORITY_FEE")   # per-gas price paid at today's base fee

say "chain $CHAIN_ID  block $(cast block-number --rpc-url "$RPC_URL")  base fee $BASEFEE wei  tip $PRIORITY_FEE wei  max fee $MAX_FEE wei"
say "rpc $RPC_URL"
[ "$UNPROTECTED_RPC_URL" != "$RPC_URL" ] && say "keyless relay $UNPROTECTED_RPC_URL"
say "deployer $DEPLOYER  balance $(fmx "$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL")") FMX"
say ""

EXPECT_TOTAL=0   # wei the deployer is expected to spend
RESERVE_TOTAL=0  # wei the deployer must hold up front (gas limits at MAX_FEE)
MISSING=0
CONFLICTS=0
printf '%-44s %-44s %-9s %s\n' CONTRACT ADDRESS STATE "COST (FMX, at today's base fee)"

N_KEYLESS=$(mf '.keyless | length')
for i in $(seq 0 $((N_KEYLESS - 1))); do
  name=$(mf ".keyless[$i].name"); addr=$(mf ".keyless[$i].address")
  signer=$(mf ".keyless[$i].signer"); need=$(mf ".keyless[$i].fundingWei")
  st=$(state "$addr" "$(mf ".keyless[$i].runtimeCodehash")")
  cost=""
  if [ "$st" = missing ]; then
    MISSING=$((MISSING + 1))
    nonce=$(cast nonce "$signer" --rpc-url "$RPC_URL")
    [ "$nonce" = 0 ] || { st="BURNED"; CONFLICTS=$((CONFLICTS + 1)); }
    bal=$(cast balance "$signer" --rpc-url "$RPC_URL")
    topup=$(sub0 "$need" "$bal")
    fundgas=0; [ "$topup" = 0 ] || fundgas=$FUND_GAS
    EXPECT_TOTAL=$(add "$EXPECT_TOTAL" "$topup" "$(mul "$fundgas" "$EFFECTIVE")")
    RESERVE_TOTAL=$(add "$RESERVE_TOTAL" "$topup" "$(mul "$fundgas" "$MAX_FEE")")
    cost="$(fmx "$topup") to $signer, which pays up to $(mf ".keyless[$i].gasLimit") gas x 100 gwei"
  fi
  [ "$st" = CONFLICT ] && CONFLICTS=$((CONFLICTS + 1))
  printf '%-44s %-44s %-9s %s\n' "$name" "$addr" "$st" "$cost"
done

N_C2=$(mf '.create2 | length')
for i in $(seq 0 $((N_C2 - 1))); do
  name=$(mf ".create2[$i].name"); addr=$(mf ".create2[$i].address")
  st=$(state "$addr" "$(mf ".create2[$i].runtimeCodehash")")
  cost=""
  if [ "$st" = missing ]; then
    MISSING=$((MISSING + 1))
    gl=$(mf ".create2[$i].gasLimit"); gu=$(mf ".create2[$i].gasUsed // .create2[$i].gasLimit")
    EXPECT_TOTAL=$(add "$EXPECT_TOTAL" "$(mul "$gu" "$EFFECTIVE")")
    RESERVE_TOTAL=$(add "$RESERVE_TOTAL" "$(mul "$gl" "$MAX_FEE")")
    cost="$(fmx "$(mul "$gu" "$EFFECTIVE")") ($gu gas)"
  fi
  [ "$st" = CONFLICT ] && CONFLICTS=$((CONFLICTS + 1))
  printf '%-44s %-44s %-9s %s\n' "$name" "$addr" "$st" "$cost"
done

DEPLOYER_BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL")
say ""
say "missing: $MISSING   expected spend: $(fmx "$EXPECT_TOTAL") FMX   must hold up front: $(fmx "$RESERVE_TOTAL") FMX"
say "reserve_wei=$RESERVE_TOTAL expected_wei=$EXPECT_TOTAL"
[ "$CONFLICTS" = 0 ] || die "$CONFLICTS address(es) hold different code or have a burned keyless nonce; stop and investigate (README.md, 'Conflicts')"
if [ "$MISSING" = 0 ]; then say "nothing to do: every contract is deployed with its canonical code"; exit 0; fi
if lt "$DEPLOYER_BAL" "$RESERVE_TOTAL"; then
  short=$(sub0 "$RESERVE_TOTAL" "$DEPLOYER_BAL")
  [ "$MODE" = plan ] && { say "deployer is short by $(fmx "$short") FMX"; exit 0; }
  die "deployer holds $(fmx "$DEPLOYER_BAL") FMX, needs $(fmx "$RESERVE_TOTAL") FMX up front"
fi
[ "$MODE" = plan ] && { say "plan only; nothing sent. Run '$0 apply' to deploy."; exit 0; }

# -------------------------------------------------------------------- apply --
[ "${CONFIRM:-}" = "deploy-canonical-$CHAIN_ID" ] || die "set CONFIRM=deploy-canonical-$CHAIN_ID to broadcast"
[ -n "${SIGNER:-}" ] || die "set SIGNER to cast wallet options for $DEPLOYER"
read -r -a SIGNER_ARGS <<<"$SIGNER"
FROM=$(cast wallet address "${SIGNER_ARGS[@]}")
[ "$(lower "$FROM")" = "$(lower "$DEPLOYER")" ] || die "SIGNER resolves to $FROM, not DEPLOYER $DEPLOYER"
# A re-run while an earlier run's transaction is still pending would read the
# old balances and send it again: a second keyless top-up is stranded for good.
PENDING_NONCE=$(cast nonce "$DEPLOYER" --block pending --rpc-url "$RPC_URL")
LATEST_NONCE=$(cast nonce "$DEPLOYER" --block latest --rpc-url "$RPC_URL")
[ "$PENDING_NONCE" = "$LATEST_NONCE" ] || die "$DEPLOYER has $((PENDING_NONCE - LATEST_NONCE)) pending transaction(s); wait until they are in a block, then run again"
START_BAL=$DEPLOYER_BAL

send() {  # to value calldata gaslimit -> sets TX_HASH, TX_GAS; dies unless status 1
  local out
  out=$(cast send "$1" ${3:+"$3"} --value "$2" --gas-limit "$4" \
        --priority-gas-price "$PRIORITY_FEE" --gas-price "$MAX_FEE" \
        --rpc-url "$RPC_URL" "${SIGNER_ARGS[@]}" --timeout "$RECEIPT_TIMEOUT" --json) \
    || die "cast send to $1 failed"
  TX_HASH=$(jq -r .transactionHash <<<"$out"); TX_GAS=$(jq -r .gasUsed <<<"$out")
  [ "$(jq -r .status <<<"$out")" = 0x1 ] || die "transaction $TX_HASH reverted"
}

check_deployed() {  # name address codehash
  [ "$(state "$2" "$3")" = deployed ] || die "$1: code at $2 does not match codehash $3 after deployment"
}

say ""
say "== keyless deployments"
for i in $(seq 0 $((N_KEYLESS - 1))); do
  name=$(mf ".keyless[$i].name"); addr=$(mf ".keyless[$i].address")
  signer=$(mf ".keyless[$i].signer"); need=$(mf ".keyless[$i].fundingWei")
  hash=$(mf ".keyless[$i].runtimeCodehash"); raw=$(tr -d ' \n\r' <"$HERE/$(mf ".keyless[$i].rawTx")")
  txhash=$(mf ".keyless[$i].txHash")
  [ "$(state "$addr" "$hash")" = deployed ] && { say "$name: already deployed, skipped"; continue; }
  [ "$(cast nonce "$signer" --rpc-url "$RPC_URL")" = 0 ] || die "$name: signer $signer nonce is not 0"

  bal=$(cast balance "$signer" --rpc-url "$RPC_URL")
  topup=$(sub0 "$need" "$bal")
  if [ "$topup" != 0 ]; then
    # Zero-cost probe before spending anything: submit the presigned tx while its
    # signer cannot pay. A relay that accepts pre-EIP-155 transactions answers
    # "insufficient funds" (nothing enters the pool); one that refuses them says
    # so, and we stop here with nothing spent.
    probe=$(cast publish "$raw" --rpc-url "$UNPROTECTED_RPC_URL" --async 2>&1 || true)
    if grep -qi 'insufficient funds' <<<"$probe"; then
      say "$name: relay accepts pre-EIP-155 transactions (probe rejected only for funds)"
    elif grep -qiE 'replay-protected|eip-?155|unprotected' <<<"$probe"; then
      die "$name: $UNPROTECTED_RPC_URL refuses pre-EIP-155 transactions ($probe). Nothing was spent. Point UNPROTECTED_RPC_URL at a relay started with --rpc.allow-unprotected-txs (README.md)."
    elif grep -qi "$txhash" <<<"$probe" || grep -qi 'already known' <<<"$probe"; then
      say "$name: presigned tx is already pending on the relay"
    else
      die "$name: unexpected answer from $UNPROTECTED_RPC_URL: $probe"
    fi
    send "$signer" "$topup" "" "$FUND_GAS"
    say "$name: funded $signer with $(fmx "$topup") FMX (tx $TX_HASH)"
  fi
  # The relay validates against its own state: wait until it has imported the
  # funding block, or it would answer "insufficient funds" to the real submit.
  # A failed read (relay still syncing) counts as 0, so the loop keeps waiting.
  waited=0
  while lt "$(cast balance "$signer" --rpc-url "$UNPROTECTED_RPC_URL" 2>/dev/null || echo 0)" "$need"; do
    [ "$waited" -ge "$RECEIPT_TIMEOUT" ] && die "$name: relay $UNPROTECTED_RPC_URL never saw the funding (is it synced?)"
    sleep 2; waited=$((waited + 2))
  done

  out=$(cast publish "$raw" --rpc-url "$UNPROTECTED_RPC_URL" --async 2>&1 || true)
  if ! grep -qi "$txhash" <<<"$out" && ! grep -qi 'already known' <<<"$out"; then
    die "$name: relay did not take the presigned tx: $out"
  fi
  rcpt=$(wait_receipt "$txhash") || die "$name: $txhash not in a block within ${RECEIPT_TIMEOUT}s (is the relay peered?)"
  [ "$(jq -r .status <<<"$rcpt")" = 0x1 ] || die "$name: presigned tx $txhash reverted"
  check_deployed "$name" "$addr" "$hash"
  say "$name: deployed at $addr (tx $txhash, gas $(cast to-dec "$(jq -r .gasUsed <<<"$rcpt")"))"
done

say ""
say "== CREATE2 deployments via $(mf .create2Deployer)"
C2=$(mf .create2Deployer)
check_deployed create2-deployer "$C2" "$(mf '.keyless[] | select(.name=="create2-deployer") | .runtimeCodehash')"
for i in $(seq 0 $((N_C2 - 1))); do
  name=$(mf ".create2[$i].name"); addr=$(mf ".create2[$i].address")
  hash=$(mf ".create2[$i].runtimeCodehash"); salt=$(mf ".create2[$i].salt")
  init=$(tr -d ' \n\r' <"$HERE/$(mf ".create2[$i].initcode")")
  gl=$(mf ".create2[$i].gasLimit")
  [ "$(lower "$(cast keccak "$init")")" = "$(lower "$(mf ".create2[$i].initcodeHash")")" ] || die "$name: initcode file does not match manifest hash"
  [ "$(state "$addr" "$hash")" = deployed ] && { say "$name: already deployed, skipped"; continue; }
  data="$salt${init#0x}"
  # Dry run first: the deployer returns the 20-byte address it would create.
  sim=$(cast call "$C2" "$data" --from "$DEPLOYER" --gas-limit "$gl" --rpc-url "$RPC_URL") \
    || die "$name: eth_call of the deployment reverted"
  [ "$(lower "0x${sim: -40}")" = "$(lower "$addr")" ] || die "$name: dry run would deploy to 0x${sim: -40}, not $addr"
  send "$C2" 0 "$data" "$gl"
  check_deployed "$name" "$addr" "$hash"
  say "$name: deployed at $addr (tx $TX_HASH, gas $(cast to-dec "$TX_GAS"))"
done

END_BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL")
say ""
say "done. deployer spent $(fmx "$(sub0 "$START_BAL" "$END_BAL")") FMX; balance now $(fmx "$END_BAL") FMX"
say "next: RPC_URL=$RPC_URL $HERE/verify.sh"
