#!/usr/bin/env bash
# Prove that no Ferminux DEX contract contains a PUSH0 (0x5f) opcode.
#
# ferminux-geth forks go-ethereum v1.10.26, which pre-dates Shanghai: PUSH0 is
# an invalid opcode on chain 3961 and any contract containing one is bricked.
#
# Method: a real DISASSEMBLY (`cast disassemble`), not a byte grep — a 0x5f byte
# that is merely PUSH data cannot produce a false positive, and a genuine PUSH0
# cannot hide inside a constant. Both the CREATION bytecode (what the deploy
# transaction executes) and the DEPLOYED bytecode (what every later call
# executes) are checked.
#
# foundry.toml sets bytecode_hash = "none" and cbor_metadata = false, so there
# is no trailing CBOR metadata blob for the disassembler to misread as opcodes:
# every byte examined here is real code.
#
# Usage:  ./script/check-push0.sh          (from dex/contracts)
# Exit:   0 = clean, 1 = a PUSH0 was found

set -euo pipefail
cd "$(dirname "$0")/.."

CONTRACTS=(FerminuxFactory FerminuxPair FerminuxRouter WFMX LiquidityLocker)
STATUS=0

forge build >/dev/null 2>&1

echo "Disassembling Ferminux DEX bytecode (evm_version = paris, no metadata)"
printf '%-18s %-9s %10s %10s   %s\n' "CONTRACT" "ARTIFACT" "BYTES" "OPCODES" "PUSH0"

check() { # $1 = contract, $2 = label, $3 = forge inspect field
  local NAME="$1" LABEL="$2" FIELD="$3" CODE BYTES ASM OPS HITS
  CODE="$(forge inspect "$NAME" "$FIELD" --json | tr -d '"')"
  BYTES=$(( (${#CODE} - 2) / 2 ))
  ASM="$(cast disassemble "$CODE")"
  OPS=$(printf '%s\n' "$ASM" | grep -c . || true)
  HITS=$(printf '%s\n' "$ASM" | grep -cw "PUSH0" || true)
  if [ "$HITS" -ne 0 ]; then
    STATUS=1
    printf '%-18s %-9s %10s %10s   FOUND %s -- FAIL\n' "$NAME" "$LABEL" "$BYTES" "$OPS" "$HITS"
  else
    printf '%-18s %-9s %10s %10s   none  -- ok\n' "$NAME" "$LABEL" "$BYTES" "$OPS"
  fi
}

for NAME in "${CONTRACTS[@]}"; do
  check "$NAME" "creation" bytecode
  check "$NAME" "deployed" deployedBytecode
done

if [ "$STATUS" -eq 0 ]; then
  echo "PASS: zero PUSH0 opcodes in any Ferminux DEX contract."
else
  echo "FAIL: PUSH0 found. Check evm_version in foundry.toml."
fi
exit "$STATUS"
