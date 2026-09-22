#!/usr/bin/env bash
#
# Publish a Ferminux weak-subjectivity checkpoint to the CheckpointRegistry on
# BSC, through the BSC owner multisig.
#
#   bash checkpoint.sh                      # checkpoint head - LAG, after a quorum check
#   bash checkpoint.sh <ferminux-block>     # checkpoint a specific height
#   bash checkpoint.sh --dry-run [<block>]  # everything except the multisig txs
#
# Environment:
#   CKPT_REGISTRY   address of CheckpointRegistry on BSC (required to publish;
#                   may be omitted with --dry-run)
#   CKPT_LAG        blocks below the lowest reported head to checkpoint when no
#                   height is given (default 32). The checkpoint must be a block
#                   every honest node has already settled on; picking the exact
#                   tip would race normal propagation.
#   BSC_RPC         override the BSC read endpoint
#
# WHAT THIS GUARDS. A checkpoint is the bridge validators' ceiling: they will not
# sign a Ferminux->BSC transfer whose source block is above the latest attested
# one, and they refuse outright if the hash they see at that height differs from
# what is attested. That makes the hash written here load-bearing. So this
# script reads the chosen height from ALL THREE Ferminux RPCs — which sit on
# different hosts — and REFUSES unless every one of them returns the SAME,
# non-empty hash. A disagreement means the chain is forked or a node is behind;
# either way nothing is published and a human looks at it.
#
# Two-of-three is deliberately NOT good enough here: the relayer already
# tolerates one bad provider at read time, and a checkpoint that was itself
# published on a 2/3 view would silently cement the minority's losing branch
# the moment the third node was right.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All three must answer. Order is irrelevant; every one is authoritative.
FMX_RPCS=(
  https://rpc.ferminux.net
  https://rpc.ferminux.net
  https://rpc2.ferminux.net
)
BSC_RPC="${BSC_RPC:-https://bsc-dataseed.bnbchain.org}"
LAG="${CKPT_LAG:-32}"

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
WANT="${1:-}"

for t in cast python3; do
  command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }
done

if [ "$DRY" -eq 0 ]; then
  : "${CKPT_REGISTRY:?set CKPT_REGISTRY to the CheckpointRegistry address on BSC}"
fi

die() { echo "REFUSING: $*" >&2; exit 1; }

# --- 1. heads from every RPC -------------------------------------------------
echo "Ferminux heads:"
heads=()
for rpc in "${FMX_RPCS[@]}"; do
  h=$(cast block-number --rpc-url "$rpc" 2>/dev/null) || die "$rpc did not answer — all three RPCs must be reachable"
  [[ "$h" =~ ^[0-9]+$ ]] || die "$rpc returned a non-numeric head '$h'"
  printf "  %-32s %s\n" "$rpc" "$h"
  heads+=("$h")
done

min=${heads[0]}; max=${heads[0]}
for h in "${heads[@]}"; do
  (( h < min )) && min=$h
  (( h > max )) && max=$h
done
echo "  spread: $((max - min)) blocks (min $min, max $max)"

# --- 2. choose the height ----------------------------------------------------
if [ -n "$WANT" ]; then
  [[ "$WANT" =~ ^[0-9]+$ ]] || die "block '$WANT' is not a number"
  TARGET=$WANT
  (( TARGET <= min )) || die "block $TARGET is above the lowest reported head ($min); not every node has it yet"
else
  (( min > LAG )) || die "chain too short for lag $LAG (lowest head $min)"
  TARGET=$((min - LAG))
fi
(( TARGET > 0 )) || die "block 0 cannot be checkpointed"

# --- 3. hash at that height from every RPC — must be identical ----------------
echo "Hash at block $TARGET:"
hashes=()
for rpc in "${FMX_RPCS[@]}"; do
  hash=$(cast block --rpc-url "$rpc" "$TARGET" --field hash 2>/dev/null) || die "$rpc could not serve block $TARGET"
  hash=$(echo "$hash" | tr -d '[:space:]' | tr 'A-F' 'a-f')
  [[ "$hash" =~ ^0x[0-9a-f]{64}$ ]] || die "$rpc returned malformed hash '$hash' for block $TARGET"
  [ "$hash" != "0x$(printf '0%.0s' {1..64})" ] || die "$rpc returned the zero hash for block $TARGET"
  printf "  %-32s %s\n" "$rpc" "$hash"
  hashes+=("$hash")
done
for hash in "${hashes[@]}"; do
  [ "$hash" = "${hashes[0]}" ] || die "RPCs DISAGREE on the hash at block $TARGET — the chain is forked or a node is stale. Nothing published."
done
HASH=${hashes[0]}
echo "  all three agree."

# --- 4. registry state on BSC — never move backwards --------------------------
if [ -n "${CKPT_REGISTRY:-}" ]; then
  out=$(cast call --rpc-url "$BSC_RPC" "$CKPT_REGISTRY" "latest()(uint64,bytes32,uint64)") \
    || die "could not read CheckpointRegistry $CKPT_REGISTRY on BSC"
  cur_n=$(echo "$out" | sed -n '1p' | awk '{print $1}')
  cur_h=$(echo "$out" | sed -n '2p' | tr -d ' ')
  cur_t=$(echo "$out" | sed -n '3p' | awk '{print $1}')
  if [ "$cur_n" -eq 0 ]; then
    echo "Registry: no checkpoint yet"
  else
    echo "Registry: latest $cur_n $cur_h attested $(date -r "$cur_t" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "@$cur_t")"
    (( TARGET > cur_n )) || die "block $TARGET is not above the latest checkpoint $cur_n (publish() would revert)"
    # The previously attested block must still be on OUR chain. If it is not,
    # a reorg crossed a checkpoint — that is precisely the event the registry
    # exists to detect, and the answer is not a new checkpoint.
    prev=$(cast block --rpc-url "${FMX_RPCS[0]}" "$cur_n" --field hash 2>/dev/null | tr -d '[:space:]' | tr 'A-F' 'a-f') || true
    [ "$prev" = "$cur_h" ] || die "block $cur_n on Ferminux is now $prev, but the registry attests $cur_h — REORG ACROSS A CHECKPOINT. Do not publish; investigate."
  fi
fi

DATA=$(cast calldata "publish(uint64,bytes32)" "$TARGET" "$HASH")
echo
echo "publish($TARGET, $HASH)"
echo "  calldata $DATA"

if [ "$DRY" -eq 1 ]; then
  echo "  dry run — not submitted"
  exit 0
fi

# --- 5. simulate as the multisig, then run through msig.sh -------------------
# MinimalMultisig swallows the callee's revert string, so check it here first.
MSIG=0x15D0791d49A089863243BE2C2050e5d26E1bBA9c
cast call --rpc-url "$BSC_RPC" --from "$MSIG" "$CKPT_REGISTRY" "$DATA" >/dev/null \
  || die "simulated publish() from the BSC multisig reverts — is CKPT_REGISTRY owned by $MSIG?"

bash "$HERE/msig.sh" bsc "$CKPT_REGISTRY" "$DATA"

out=$(cast call --rpc-url "$BSC_RPC" "$CKPT_REGISTRY" "latest()(uint64,bytes32,uint64)")
new_n=$(echo "$out" | sed -n '1p' | awk '{print $1}')
new_h=$(echo "$out" | sed -n '2p' | tr -d ' ')
if [ "$new_n" = "$TARGET" ] && [ "$(echo "$new_h" | tr 'A-F' 'a-f')" = "$HASH" ]; then
  echo "  checkpoint $TARGET published."
else
  echo "WARNING: multisig reported success but registry latest() is $new_n $new_h" >&2
  exit 1
fi
