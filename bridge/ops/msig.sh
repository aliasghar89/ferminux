#!/usr/bin/env bash
#
# Run one action through a chain's owner multisig: submit, confirm, execute.
#
#   bash msig.sh <fmx|bsc> <target-contract> <calldata>
#
# Each chain has its OWN MinimalMultisig deployed on it, at a different address,
# though both are controlled by the same three owner keys. That distinction is
# load-bearing: the BSC bridge was once bricked by setting its owner to the
# Ferminux multisig's address, which has no code on BSC, making every owner
# function permanently uncallable. Never point a chain at the other's multisig.
#
# BEFORE USING THIS ON ANYTHING IRREVERSIBLE: simulate the inner call first.
# MinimalMultisig discards the callee's revert data and reports only
# "MSIG: call failed", so a failed registration tells you nothing about which
# check failed. The bridge's onlySelf setters can be simulated by calling them
# AS the bridge:
#
#   cast call --rpc-url $RPC --from $BRIDGE $BRIDGE "registerCanonical(...)" ...
#
# which returns 0x if it would succeed, or the real "BRIDGE: ..." string.
set -euo pipefail

CH="${1:?usage: msig.sh <fmx|bsc> <target> <calldata>}"
TARGET="${2:?target contract required}"
DATA="${3:?calldata required}"

case "$CH" in
  fmx)
    RPC=https://rpc.ferminux.net
    MSIG=0x910BD467D8576277f8f96DF47428377FFD94fEfe
    # The miner enforces a 1 gwei floor; the default estimate is below it on an
    # otherwise empty chain, so transactions sit unmined without this.
    EXTRA=(--gas-price 2gwei --priority-gas-price 1gwei)
    ;;
  bsc)
    RPC=https://bsc-dataseed.bnbchain.org
    MSIG=0x15D0791d49A089863243BE2C2050e5d26E1bBA9c
    EXTRA=()
    ;;
  *) echo "unknown chain '$CH' — expected fmx or bsc" >&2; exit 2 ;;
esac

CRED="$HOME/ferminux-network/.credentials/premine"
[ -d "$CRED" ] || { echo "no credentials at $CRED" >&2; exit 1; }

# Find the keystore by what it CONTAINS — JSON with a "crypto" object — rather
# than by excluding filenames we expect. The exclusion approach picked up a
# .DS_Store that Finder dropped beside a keystore and tried to decrypt it,
# reporting a perfectly good wallet as unreadable.
key() {
  local dir="$CRED/$1" f
  [ -d "$dir" ] || { echo "no keystore directory $dir" >&2; exit 1; }
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    if python3 -c "import json,sys
d=json.load(open(sys.argv[1]))
sys.exit(0 if isinstance(d,dict) and ('crypto' in d or 'Crypto' in d) else 1)" "$f" 2>/dev/null; then
      cast wallet decrypt-keystore --keystore-dir "$dir" "$(basename "$f")" \
        --unsafe-password "$(cat "$dir/password.txt")" | grep -o '0x[0-9a-fA-F]\{64\}'
      return 0
    fi
  done
  echo "no V3 keystore found in $dir" >&2; exit 1
}

O1=$(key msig-owner1)
O2=$(key msig-owner2)

# Read the id BEFORE submitting: submit() appends, so the new transaction's id is
# the count as it stood beforehand. Reading it afterwards would race any other
# owner submitting concurrently.
N=$(cast call --rpc-url "$RPC" "$MSIG" "transactionCount()(uint256)" | awk '{print $1}')

cast send --rpc-url "$RPC" --private-key "$O1" "${EXTRA[@]+"${EXTRA[@]}"}" \
  "$MSIG" "submit(address,uint256,bytes)" "$TARGET" 0 "$DATA" >/dev/null
cast send --rpc-url "$RPC" --private-key "$O2" "${EXTRA[@]+"${EXTRA[@]}"}" \
  "$MSIG" "confirm(uint256)" "$N" >/dev/null
cast send --rpc-url "$RPC" --private-key "$O1" "${EXTRA[@]+"${EXTRA[@]}"}" \
  "$MSIG" "execute(uint256)" "$N" >/dev/null

echo "  msig tx $N executed on $CH"
